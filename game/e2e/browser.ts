// Browser end-to-end test: 3 headless-Chrome players play one short game through the real UI against the local dev server.
//   npx tsx e2e/browser.ts            (from game/)  -> screenshots in e2e/shots/
// Starts (and afterwards kills) its own dev server (:8787, short timings) and Vite dev server (:5173).
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { WORLD_CONFIG } from '@hp/shared';
import type { Browser, BrowserContext, Page } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const gameDir = path.resolve(here, '..');
const SHOTS = path.join(here, 'shots');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// Ports can be overridden (E2E_API_PORT / E2E_WEB_PORT) when a dev server already holds 8787/5173.
const API_PORT = Number(process.env.E2E_API_PORT ?? 8787), WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5173);
const URL_ = API_PORT === 8787 ? `http://localhost:${WEB_PORT}/?server=local` : `http://localhost:${WEB_PORT}/?server=${encodeURIComponent(`http://localhost:${API_PORT}`)}`;

const children: ChildProcess[] = [];
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function start(name: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const c = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  c.stdout?.on('data', d => { if (process.env.VERBOSE) process.stdout.write(`[${name}] ${d}`); });
  c.stderr?.on('data', d => { if (process.env.VERBOSE || /error/i.test(String(d))) process.stderr.write(`[${name}] ${d}`); });
  children.push(c);
  return c;
}
/** Kills only the processes (and their trees) started here. */
function killAll() {
  for (const c of children) {
    if (!c.pid || c.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-c.pid, 'SIGKILL');
    } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

async function portFree(port: number): Promise<boolean> {
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) }); return false; } catch (e) { return !(e instanceof Error && e.name === 'TimeoutError'); }
}
async function waitHttp(url: string, ms: number) {
  const end = Date.now() + ms;
  for (;;) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) return; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error('timeout waiting for ' + url);
    await sleep(300);
  }
}

// ------------------------------------------------------------------ UI helpers
const problems: string[] = [];
const see = async (page: Page, text: string | RegExp, ms = 20000) => {
  try { await page.getByText(text).first().waitFor({ state: 'visible', timeout: ms }); }
  catch { throw new Error(`expected text not visible: ${String(text)} (url ${page.url()})`); }
};
const shot = async (page: Page, name: string) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const PHONE_WIDTH = 390;
const btn = (page: Page, name: string | RegExp) => page.getByRole('button', { name });
const budget = async (page: Page) => (await page.locator('.hud-item.budget strong').innerText()).trim();

/** Click the k-th biggest seat on the map (dispatching the click straight to the SVG path; small seats are hard to hit). */
async function clickSeat(page: Page, k: number): Promise<number> {
  await page.waitForFunction(() => document.querySelectorAll('path.seat').length > 400, undefined, { timeout: 60000 });
  const seat = await page.evaluate((rank: number) => {
    const ps = [...document.querySelectorAll<SVGPathElement>('path.seat')].map(p => {
      const b = p.getBBox();
      return { p, area: b.width * b.height, id: (p as any).__data__?.properties?.seat as number };
    }).sort((a, z) => z.area - a.area);
    const t = ps[rank + 12]; // skip the very biggest (often split across the polling phases oddly); any large seat is fine
    t.p.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return t.id;
  }, k);
  return seat;
}


/** Open the seat panel of seat `id` by dispatching the click to its path (does not paint; small seats are hard to hit with a real mouse). */
async function openSeat(page: Page, id: number) {
  await page.evaluate(i => { document.querySelector(`path.seat[data-seat="${i}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }, id);
}
const digits = (t: string) => Number(t.replace(/\D/g, ''));
const budgetNum = async (page: Page) => digits(await budget(page));
const COST = WORLD_CONFIG.costs;

/** A point on land at height `frac` of the map (the first seat found scanning from the left), where a brush stroke can start. */
async function landStart(page: Page, frac: number): Promise<{ x: number; y: number; w: number }> {
  const pt = await page.evaluate(f => {
    const r = document.querySelector('svg.map')!.getBoundingClientRect();
    const y = r.top + r.height * f;
    for (let x = r.left + r.width * 0.12; x < r.right - r.width * 0.45; x += 4) {
      const top = document.elementsFromPoint(x, y)[0];
      if (top && (top.classList.contains('seat') || top.classList.contains('hit'))) return { x, y, w: r.width };
    }
    return null;
  }, frac);
  if (!pt) throw new Error('no land found for a brush stroke at height ' + frac);
  return pt;
}

/** A real mouse stroke over the map: press on land, drag right by 30% of the map width, release. Checks the brush cursor on the way. */
async function stroke(page: Page, frac: number, name: string) {
  const st = await landStart(page, frac);
  await page.mouse.move(st.x, st.y);
  if (!(await page.locator('.brush-cursor').isVisible())) problems.push(`${name}: the brush cursor is not shown over the map`);
  if (!(await page.locator('svg.map.brushing').count())) problems.push(`${name}: the map is not in brush mode on a desktop`);
  await page.mouse.down();
  await page.mouse.move(st.x + st.w * 0.15, st.y, { steps: 20 });
  if (!(await page.locator('.brush-cursor').isVisible())) problems.push(`${name}: the brush cursor vanished during a stroke`);
  await page.mouse.move(st.x + st.w * 0.3, st.y, { steps: 20 });
  await page.mouse.up();
  return st;
}

/** The party's own candidate count in the side panel (its row is the first and says "(you)"). */
const ownCount = async (page: Page) => digits(await page.locator('[data-tour="candidate-counts"] li').first().locator('.cc-count').innerText());
/** Wait until the candidate count is above `above`, has stopped moving and matches the budget (every candidate costs costs.candidate). */
async function settled(page: Page, name: string, above = 0): Promise<number> {
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const c = await ownCount(page), b = await budgetNum(page);
    if (c > above && c === last && b === WORLD_CONFIG.budget - COST.candidate * c) return c;
    last = c;
    await sleep(250);
  }
  const c = await ownCount(page), b = await budgetNum(page);
  problems.push(`${name}: candidates ${c} and budget ${b} never settled (expected budget ${WORLD_CONFIG.budget - COST.candidate * c})`);
  return c;
}
/** Seats where every party has a candidate (the group has one figure per party; figures may be display:none), biggest first. */
async function sharedSeats(page: Page, parties: number): Promise<number[]> {
  return page.evaluate(n => [...document.querySelectorAll<SVGGElement>('g.seat-candidates')]
    .filter(g => g.querySelectorAll('.candidate-figure').length >= n)
    .map(g => { const p = document.querySelector<SVGPathElement>(`path.seat[data-seat="${g.dataset.seat}"]`)!; const b = p.getBBox(); return { id: Number(g.dataset.seat), area: b.width * b.height }; })
    .sort((a, z) => z.area - a.area).map(x => x.id), parties);
}
const candidateSeats = (page: Page) => page.evaluate(() => [...document.querySelectorAll<SVGGElement>('g.seat-candidates')].map(g => Number(g.dataset.seat)));

const avatarBtn = (page: Page, label: string) => page.getByRole('radio', { name: label, exact: true });

async function setParty(page: Page, name: string, colour: string, symbol: string, avatar: string) {
  await btn(page, /Set up my party|Edit my party/).click();
  await page.getByPlaceholder("e.g. People's Front").fill(name);
  await page.getByLabel(colour, { exact: true }).click();
  await page.getByLabel(symbol, { exact: true }).click();
  await avatarBtn(page, avatar).click();
  await page.getByAltText(`Selected avatar: ${avatar}`).waitFor();
  await btn(page, 'Save party').click();
  await btn(page, 'Edit my party').waitFor({ timeout: 10000 });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  for (const f of ['01-home', '02-lobby-admin', '03-party', '04-lobby-ready', '05a-precampaign-painted', '05b-precampaign-panel', '05c-precampaign-phone', '05-campaign-admin', '06-campaign-b-report', '07-campaign-c-seat-report', '07b-campaign-group-chat-tagged', '08-counting', '08b-counting-one-to-one-chat', '08c-counting-chat-phone', '09-offer', '09b-offer-phone', '09a-offer-everyone-blocked', '10-government', '11-result-admin', '12-result-c', '13-play-again-admin']) rmSync(path.join(SHOTS, f + '.png'), { force: true });
  if (!existsSync(CHROME)) throw new Error('Chrome not found at ' + CHROME + ' (set CHROME_PATH)');
  for (const p of [API_PORT, WEB_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is already in use; stop that server first`);

  log('starting dev server + vite');
  start('server', [path.join(gameDir, 'node_modules/tsx/dist/cli.mjs'), 'src/local/devServer.ts'], path.join(gameDir, 'server'), {
    HP_PRECAMPAIGN_MS: '45000', HP_CAMPAIGN_MS: '45000', HP_COUNTING_MS: '20000', HP_POST_MS: '15000', HP_START_DELAY_MS: '2000', HP_PORT: String(API_PORT),
  });
  start('vite', [path.join(gameDir, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort'], path.join(gameDir, 'web'), {});
  await waitHttp(`http://localhost:${API_PORT}/games/x`, 60000);
  await waitHttp(`http://localhost:${WEB_PORT}/`, 60000);
  log('servers up');

  const browser: Browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctxs: BrowserContext[] = [];
  const mk = async (name: string): Promise<Page> => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    ctxs.push(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', e => problems.push(`${name}: uncaught ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) problems.push(`${name}: console.error ${m.text()}`); });
    return page;
  };
  const A = await mk('Asha'), B = await mk('Ben'), C = await mk('Chitra');

  try {
    // ---- create / join / admit
    await A.goto(URL_);
    await see(A, 'Win seats. Build a government.');
    if (await A.getByText('Mock mode').count()) throw new Error('the app is still in mock mode');
    // map chooser: a card per map, default selected, "View map" opens the study site in a new tab
    const card = A.getByTestId('map-card').first();
    await card.waitFor({ state: 'visible' });
    if (!(await A.getByRole('radio', { name: /World/ }).isChecked())) problems.push('the default map (World) is not pre-selected');
    const viewMap = card.getByRole('link', { name: /View map/ });
    if ((await viewMap.getAttribute('href')) !== '/maps/world-500/site/index.html') problems.push('View map href is ' + (await viewMap.getAttribute('href')));
    if ((await viewMap.getAttribute('target')) !== '_blank') problems.push('View map does not open in a new tab');
    const thumbOk = await A.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>('[data-testid="map-card"] img'); return !!i && i.complete && i.naturalWidth > 0; }, undefined, { timeout: 8000 }).then(() => true, () => false);
    if (!thumbOk) problems.push('map thumbnail did not load');
    const [popup] = await Promise.all([A.context().waitForEvent('page'), viewMap.click()]);
    await popup.waitForLoadState('domcontentloaded');
    if (!/\/maps\/world-500\/site\/index\.html$/.test(popup.url())) problems.push('View map opened ' + popup.url());
    await popup.close();
    await shot(A, '01-home');
    await A.getByPlaceholder('e.g. Vishal').fill('Asha');
    await btn(A, 'Create game').click();
    await see(A, 'Join code');
    const code = (await A.locator('.big-code').innerText()).trim();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) throw new Error('bad join code: ' + code);
    log('game created, code', code);
    for (const [page, nick] of [[B, 'Ben'], [C, 'Chitra']] as const) {
      await page.goto(URL_);
      await page.getByPlaceholder('e.g. Vishal').fill(nick);
      await page.getByPlaceholder('HP7K2Q').fill(code);
      await btn(page, 'Ask to join').click();
      await see(page, /Waiting for the admin/);
    }
    await see(A, 'Join requests (2)');
    await shot(A, '02-lobby-admin');
    await btn(A, 'Admit').first().click();
    await see(A, 'Join requests (1)');
    await btn(A, 'Admit').first().click();
    await see(B, 'Set up my party'); await see(C, 'Set up my party');
    log('both admitted');

    // ---- parties
    await setParty(A, 'Lotus Front', 'Saffron', 'Sun', 'Modi');
    await B.getByRole('button', { name: 'Set up my party' }).click();
    await B.getByPlaceholder("e.g. People's Front").fill('Blue Anchor');
    await B.getByLabel('Blue', { exact: true }).click();
    await B.getByLabel('Anchor', { exact: true }).click();
    // an avatar is required: saving without one shows a message and stays on the page
    await btn(B, 'Save party').click();
    await see(B, /Choose an avatar/);
    if (await btn(B, 'Edit my party').count()) problems.push('party saved without an avatar');
    if (!(await avatarBtn(B, 'Modi').isDisabled())) problems.push('Modi should be disabled for Ben (taken by Asha)');
    await avatarBtn(B, 'Raga').click();
    await B.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>('.avatar-preview'); return !!i && i.complete && i.naturalWidth === 512; }, undefined, { timeout: 8000 }).catch(() => problems.push('avatar preview (512 px full image) did not load'));
    await sleep(500); // let the 512 px preview paint
    await shot(B, '03-party');
    await btn(B, 'Save party').click();
    await btn(B, 'Edit my party').waitFor();
    await setParty(C, 'Green Leaf', 'Green', 'Leaf', 'Mamata');
    // colours/symbols/avatars picked by others are disabled for the next player
    await btn(C, 'Edit my party').click();
    if (!(await C.getByLabel('Saffron', { exact: true }).isDisabled())) problems.push('Saffron should be disabled for Chitra (taken by Asha)');
    if (!(await avatarBtn(C, 'Raga').isDisabled())) problems.push('Raga should be disabled for Chitra (taken by Ben)');
    if (!(await avatarBtn(C, 'Mamata').isEnabled())) problems.push('Chitra should keep her own avatar selectable');
    await btn(C, 'Back').click();
    await see(A, 'Blue Anchor'); await see(A, 'Green Leaf');
    for (const a of ['modi', 'raga', 'mamata']) {
      if (!(await A.locator(`.party-avatar img[src="/avatars/thumb/${a}.jpg"]`).first().isVisible())) problems.push(`lobby does not show the ${a} avatar`);
    }
    await shot(A, '04-lobby-ready');
    await btn(A, 'Start the campaign').click();
    for (const p of [A, B, C]) await p.locator('.app.screen-preCampaign').waitFor({ timeout: 20000 });
    for (const [n, p] of [['A', A], ['B', B], ['C', C]] as const) {
      if (await budgetNum(p) !== WORLD_CONFIG.budget) problems.push(`${n}: the pre-campaign starts on ${await budget(p)}, expected ${WORLD_CONFIG.budget}`);
      await see(p, 'Pre-campaign ends in');
    }
    log('pre-campaign started');

    // ---- pre-campaign: paint candidates with the real mouse (Asha), then B and C the same way
    const cc = (p: Page) => p.locator('[data-tour="candidate-counts"]');
    if ((await ownCount(A)) !== 0) problems.push('Asha starts with candidates');
    const smoke = A.waitForSelector('g.rep-smoke.seat-spend', { state: 'attached', timeout: 10000 }).catch(() => problems.push('no red -' + COST.candidate + ' smoke (g.rep-smoke.seat-spend) after painting'));
    const start = await stroke(A, 0.4, 'Asha');
    const nA = await settled(A, 'Asha');
    await smoke;
    if (nA < 2) problems.push(`one stroke fielded only ${nA} candidate(s); the test needs at least 2`);
    if (!(await A.locator('g.seat-candidates .candidate-figure').count())) problems.push('painted seats show no candidate figure');
    if (!(await A.locator('g.seat-candidates .candidate-figure').evaluateAll(els => els.some(e => (e as SVGGElement).getBoundingClientRect().width > 0)))) problems.push('no candidate figure is visible on the world map');
    // the others' counts update live
    await see(B, new RegExp('Lotus Front'));
    await B.waitForFunction(n => [...document.querySelectorAll('[data-tour="candidate-counts"] li')].some(li => /Lotus Front/.test(li.textContent ?? '') && Number(li.querySelector('.cc-count')?.textContent) === n), nA, { timeout: 10000 })
      .catch(() => problems.push(`Ben does not see Lotus Front's ${nA} candidates live`));
    log(`Asha painted ${nA} candidates`);
    await shot(A, '05a-precampaign-painted');

    // a click without moving opens the seat panel and paints nothing; Withdraw and Field switch the open panel by themselves
    const own = await candidateSeats(A);
    const P = (await A.evaluate(([x, y]) => Number(document.elementsFromPoint(x, y)[0]?.getAttribute('data-seat')), [start.x, start.y])) || own[0];
    const Q = own.find(x => x !== P)!;
    const bef = await budgetNum(A);
    await A.mouse.move(start.x, start.y);
    await A.mouse.click(start.x, start.y);
    const panel = A.locator('[data-tour="fielding-panel"]');
    await panel.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await panel.locator('.fp-withdraw').isVisible())) problems.push('the panel of a fielded seat has no Withdraw button');
    if ((await panel.locator('.fp-candidates li[data-player]').count()) < 1) problems.push('the panel does not list who is fielded here');
    await sleep(600);
    if ((await budgetNum(A)) !== bef || (await ownCount(A)) !== nA) problems.push('a click without moving painted a candidate');
    await shot(A, '05b-precampaign-panel');
    const refund = A.waitForSelector('g.rep-smoke.seat-refund', { state: 'attached', timeout: 10000 }).catch(() => problems.push('no green +' + COST.candidate + ' smoke (g.rep-smoke.seat-refund) after withdrawing'));
    await panel.locator('.fp-withdraw').click();
    await panel.locator('.fp-field').waitFor({ state: 'visible', timeout: 5000 }).catch(() => problems.push('the open panel did not switch to Field after Withdraw'));
    await refund;
    if ((await settled(A, 'Asha after withdraw', 0)) !== nA - 1) problems.push('withdraw did not lower the candidate count by one');
    if (!(await panel.isVisible())) problems.push('the panel closed after Withdraw');
    await panel.locator('.fp-field').click();
    await panel.locator('.fp-withdraw').waitFor({ state: 'visible', timeout: 5000 }).catch(() => problems.push('the open panel did not switch back to Withdraw after Field'));
    if ((await settled(A, 'Asha after re-field', 0)) !== nA) problems.push('fielding again did not restore the candidate count');
    // seat Q stays withdrawn: Asha has no candidate there in the campaign
    await openSeat(A, Q);
    await panel.locator('.fp-withdraw').click();
    await panel.locator('.fp-field').waitFor({ state: 'visible', timeout: 5000 });
    await settled(A, 'Asha after the second withdraw', 0);
    await A.keyboard.press('Escape');
    log(`seat ${P} withdrawn and fielded again, seat ${Q} left empty`);

    // one-to-one chat in the pre-campaign: only the recipient reads it
    const chatBox = (p: Page) => p.locator('[data-tour="precampaign-chat"]');
    await chatBox(A).getByRole('tab', { name: /Blue Anchor/ }).click();
    await chatBox(A).getByPlaceholder('Message Blue Anchor').fill('Pre-campaign pact?');
    await chatBox(A).getByRole('button', { name: 'Send', exact: true }).click();
    await chatBox(B).getByRole('tab', { name: /Lotus Front/ }).click();
    await chatBox(B).getByText('Pre-campaign pact?').last().waitFor({ state: 'visible', timeout: 10000 });
    await sleep(400);
    if (await C.getByText('Pre-campaign pact?').count()) problems.push('a pre-campaign one-to-one message leaked to a third party');
    {
      const side = await A.locator('aside.side').boundingBox(), slot = await chatBox(A).boundingBox();
      if (!side || !slot || slot.height < 250 || slot.y + slot.height < side.y + side.height - 40) problems.push(`the pre-campaign chat does not fill the side panel (${JSON.stringify(slot)} in ${JSON.stringify(side)})`);
    }
    log('pre-campaign chat ok');

    // Ben and Chitra paint the same rows; Asha adds the second row
    for (const [n, p] of [['Ben', B], ['Chitra', C]] as const) {
      await stroke(p, 0.4, n);
      if ((await settled(p, n)) < 2) problems.push(`${n}'s stroke fielded fewer than 2 candidates`);
    }
    for (const [n, p] of [['Asha', A], ['Ben', B], ['Chitra', C]] as const) { await stroke(p, 0.58, n); await settled(p, n, 1); }
    // the majority shown is the one of the contested seats
    for (const p of [A, B, C]) {
      await p.waitForFunction(() => { const m = /Majority:\s*(\d+) of (\d+) contested/.exec(document.querySelector('.cc-majority')?.textContent ?? ''); return !!m && Number(m[2]) > 10 && Number(m[1]) === Math.floor(Number(m[2]) / 2) + 1; }, undefined, { timeout: 10000 })
        .catch(() => problems.push('the pre-campaign panel does not show majority = floor(contested / 2) + 1'));
    }

    // seats every party fielded in (figures are hidden in the campaign, so read them now)
    const shared = await sharedSeats(A, 3);

    // phone: no brush, tap a seat, Field works. It is Asha's own session (same token), so her desktop page reloads afterwards.
    {
      const ctx = await browser.newContext({ storageState: await ctxs[0].storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const ph = await ctx.newPage();
      try {
        await ph.goto(URL_);
        await ph.locator('.app.screen-preCampaign').waitFor({ timeout: 30000 });
        await ph.waitForFunction(() => document.querySelectorAll('path.seat').length > 400, undefined, { timeout: 60000 });
        if (await ph.locator('.brush-cursor').count()) problems.push('phone: a brush cursor is shown on a touch screen');
        if (await ph.locator('svg.map.brushing').count()) problems.push('phone: the map is in brush mode on a touch screen');
        // a big seat Asha has not fielded, with a point on land that is on screen
        const target = await ph.evaluate(() => {
          const fielded = new Set([...document.querySelectorAll<SVGGElement>('g.seat-candidates')].map(g => g.dataset.seat));
          const vw = innerWidth, vh = innerHeight;
          const cands = [...document.querySelectorAll<SVGPathElement>('path.seat')].filter(p => !fielded.has(p.dataset.seat)).map(p => { const b = p.getBBox(); return { p, area: b.width * b.height }; }).sort((a, z) => z.area - a.area).slice(0, 40);
          for (const { p } of cands) {
            const r = p.getBoundingClientRect();
            for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) {
              const x = r.left + (r.width * i) / 10, y = r.top + (r.height * j) / 10;
              if (x < 4 || y < 4 || x > vw - 4 || y > vh - 4) continue;
              if (document.elementsFromPoint(x, y)[0] === p) return { x, y, seat: Number(p.dataset.seat) };
            }
          }
          return null;
        });
        if (!target) problems.push('phone: found no unfielded seat to tap');
        else {
          await ph.touchscreen.tap(target.x, target.y);
          const phPanel = ph.locator('[data-tour="fielding-panel"]');
          await phPanel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => problems.push('phone: tapping a seat did not open the fielding panel'));
          await shot(ph, '05c-precampaign-phone');
          const before = await ownCount(ph);
          await phPanel.locator('.fp-field').tap();
          await phPanel.locator('.fp-withdraw').waitFor({ state: 'visible', timeout: 5000 }).catch(() => problems.push('phone: Field in the panel did not fielded a candidate'));
          if ((await ownCount(ph)) !== before + 1) problems.push('phone: the candidate count did not rise by one after Field');
        }
      } finally {
        await ctx.close();
      }
      await A.reload();
      await A.locator('.app.screen-preCampaign').waitFor({ timeout: 30000 });
      await A.waitForFunction(() => document.querySelectorAll('path.seat').length > 400, undefined, { timeout: 60000 });
      await settled(A, 'Asha after the reload', 1);
      log('phone check ok; Asha reloaded back into the pre-campaign');
    }

    // ---- the campaign opens: only seats with a candidate can be campaigned in
    for (const p of [A, B, C]) await p.locator('.app.screen-campaign').waitFor({ timeout: 60000 });
    for (const p of [A, B, C]) await see(p, 'Campaign ends in');
    for (const p of [A, B, C]) await p.getByText('Campaign starts in').first().waitFor({ state: 'hidden', timeout: 15000 });
    log('campaign started');
    const gone = shared.indexOf(Q);
    if (gone >= 0) shared.splice(gone, 1);
    if (shared.length < 8) throw new Error(`only ${shared.length} seats are contested by all three parties`);
    // "My actions" is hidden (the chat fills its space)
    if (await A.locator('.my-actions-hidden').isVisible()) problems.push('the My actions panel is visible; the chat should fill its space');
    {
      const side = await A.locator('aside.side').boundingBox(), slot = await A.locator('[data-tour="chat"]').boundingBox();
      if (!side || !slot || slot.height < 250 || slot.y + slot.height < side.y + side.height - 40) problems.push(`the campaign chat does not fill the side panel (${JSON.stringify(slot)} in ${JSON.stringify(side)})`);
    }

    // a seat without my candidate: every action is disabled with "No candidate here", and the seat is dimmed
    await openSeat(A, Q);
    for (const k of ['rally', 'minorRally', 'roadshow']) {
      const o = A.locator('.sam-' + k);
      await o.waitFor({ state: 'visible', timeout: 5000 });
      if (!(await o.isDisabled()) || !/No candidate here/.test(await o.innerText())) problems.push(`.sam-${k} is not disabled with "No candidate here" in a seat without a candidate`);
    }
    if (!(await A.locator(`path.seat.faded[data-seat="${Q}"]`).count())) problems.push('a seat without a candidate is not dimmed');
    await A.keyboard.press('Escape');

    // ---- campaign: minor rally (secret), roadshow, rally; checked through the budget
    const bud0 = await budgetNum(A);
    await openSeat(A, shared[0]);
    if (!(await A.locator('.sam-contesting li[data-player]').count())) problems.push('the campaign seat panel does not list who is contesting');
    await A.locator('.sam-minorRally').click();
    await A.waitForFunction(b => Number(document.querySelector('.hud-item.budget strong')!.textContent!.replace(/\D/g, '')) === b, bud0 - COST.minorRally, { timeout: 10000 }).catch(() => problems.push(`budget after a minor rally is not ${bud0 - COST.minorRally}`));
    await openSeat(A, shared[0]);
    await A.locator('.sam-roadshow').click();
    await A.waitForFunction(b => Number(document.querySelector('.hud-item.budget strong')!.textContent!.replace(/\D/g, '')) === b, bud0 - COST.minorRally - COST.roadshow, { timeout: 10000 }).catch(() => problems.push('budget after a roadshow is wrong'));
    await sleep(800);
    // a minor rally (like a roadshow) is not news
    for (const p of [B, C]) if (await p.locator('.nt').getByText(/rallied/).count()) problems.push('a minor rally or roadshow showed up in the news');
    await openSeat(A, shared[0]);
    await A.locator('.sam-rally').click();
    await A.waitForFunction(b => Number(document.querySelector('.hud-item.budget strong')!.textContent!.replace(/\D/g, '')) === b, bud0 - COST.minorRally - COST.roadshow - COST.rally, { timeout: 10000 }).catch(() => problems.push('budget after a major rally is wrong'));
    const bud1 = await budget(A);
    log(`Asha acted in seat ${shared[0]}; budget ${bud0} -> ${bud1}`);
    if (!(await A.locator('.hud-me .party-avatar img').isVisible())) problems.push('campaign HUD does not show my avatar');
    await shot(A, '05-campaign-admin');

    const bBefore = await budgetNum(B);
    await openSeat(B, shared[1]);
    await B.locator('.sam-rally').click();
    await openSeat(B, shared[2]);
    await B.locator('.sam-roadshow').click();
    await B.waitForFunction(b => Number(document.querySelector('.hud-item.budget strong')!.textContent!.replace(/\D/g, '')) === b, bBefore - COST.rally - COST.roadshow, { timeout: 10000 }).catch(() => problems.push('Ben: budget after a rally and a roadshow is wrong'));
    await see(A, /rallied in/);                       // Ben's rally is public news on Asha's screen
    await see(B, /Lotus Front.*rallied|Blue Anchor.*rallied/);
    // free news-agency graphs ("News agencies" button, not the paid "Global report (price)" analyst button)
    if (WORLD_CONFIG.news.enabled) {
      const bN = await budget(B);
      await btn(B, /^News agencies$/).click();
      const dialog = B.getByRole('dialog', { name: 'News agencies' });
      await dialog.waitFor({ timeout: 10000 });
      const want = WORLD_CONFIG.news.agencies.length;
      await B.locator('[data-testid="gr-chart"]').nth(want - 1).waitFor({ timeout: 10000 }).catch(() => problems.push('the news agencies dialog did not show its charts'));
      const charts = await B.locator('[data-testid="gr-chart"]').count();
      if (charts !== want) problems.push(`the news agencies dialog shows ${charts} charts, expected one per configured agency (${want})`);
      for (const a of WORLD_CONFIG.news.agencies) if (!(await dialog.getByText(a.name, { exact: true }).count())) problems.push(`news agency ${a.name} is missing from the dialog`);
      await shot(B, '06-news-agencies');
      await B.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => problems.push('Escape did not close the news agencies dialog'));
      if ((await budget(B)) !== bN) problems.push('the news agencies are free but the budget changed');
    } else if (await B.getByRole('button', { name: /^News agencies$/ }).count()) problems.push('news agencies are switched off but their button is shown');
    if (WORLD_CONFIG.analyst.globalReport.enabled) {
      const bB = await budget(B);
      await btn(B, /^Global report \(/).click();
      await see(B, 'Global (seats)');
      if ((await budget(B)) === bB) problems.push('budget did not drop after a global report');
    } else if (await B.getByRole('button', { name: /^Global report \(/ }).count()) problems.push('the global report is switched off but its button is shown');
    await shot(B, '06-campaign-b-report');

    const cBefore = await budgetNum(C);
    await openSeat(C, shared[3]);
    await C.locator('.sam-rally').click();
    await C.waitForFunction(b => Number(document.querySelector('.hud-item.budget strong')!.textContent!.replace(/\D/g, '')) === b, cBefore - COST.rally, { timeout: 10000 }).catch(() => problems.push('Chitra: budget after a rally is wrong'));
    await openSeat(C, shared[3]);
    if (WORLD_CONFIG.analyst.seatReport.enabled) {
      await C.locator('.sam-report').click();
      await C.locator('.report').first().waitFor({ timeout: 10000 });
    } else if (await C.locator('.sam-report').count()) problems.push('the seat report is switched off but its option is shown');
    await shot(C, '07-campaign-c-seat-report');
    // privacy: Asha's roadshow must not show up for Ben as news (only rallies are public)
    if (await B.locator('.nt').getByText(/roadshow/i).count()) problems.push('a roadshow leaked into the news ticker');

    // a reload rejoins the game (session kept in localStorage)
    const cKept = await budgetNum(C);
    await C.reload();
    await see(C, 'Campaign ends in', 30000);
    await C.locator('path.seat').first().waitFor({ timeout: 30000 });
    if ((await budgetNum(C)) !== cKept) problems.push(`Chitra's budget changed over the reload (${cKept} -> ${await budgetNum(C)})`);
    // the fielding survives the reload: a seat she contests can be campaigned in
    await C.waitForFunction(() => document.querySelectorAll('path.seat').length > 400, undefined, { timeout: 60000 });
    await openSeat(C, shared[3]);
    if (await C.locator('.sam-roadshow').isDisabled()) problems.push('Chitra cannot campaign in her own seat after the reload');
    await C.keyboard.press('Escape');
    log('Chitra reloaded and rejoined');

    // campaign-phase chat: the ONE group chat is open from the campaign start (Chat.Campaigning = GROUP); everybody reads it
    for (const p of [A, B, C]) await p.getByRole('heading', { name: 'Group chat' }).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => problems.push('the group chat card is missing during the campaign'));
    await B.getByPlaceholder(/Message everyone/).fill('Campaign hello from Blue Anchor');
    await B.getByRole('button', { name: 'Send', exact: true }).click();
    await see(B, 'Campaign hello from Blue Anchor'); await see(A, 'Campaign hello from Blue Anchor'); await see(C, 'Campaign hello from Blue Anchor');
    // tagging: typing @ offers the parties; picking one tags it, and the tagged party sees its own tag highlighted
    const groupBox = B.getByPlaceholder(/Message everyone/);
    await groupBox.fill('');
    await groupBox.pressSequentially('Hi @Lot');
    await B.getByRole('option', { name: /Lotus Front/ }).click().catch(() => problems.push('the @ picker did not offer Lotus Front'));
    await groupBox.pressSequentially('let us talk');
    await B.getByRole('button', { name: 'Send', exact: true }).click();
    await see(A, 'let us talk');
    if (!(await A.locator('.hpchat-tag.me', { hasText: '@Lotus Front' }).count())) problems.push('the tagged party does not see its tag highlighted');
    if (await C.locator('.hpchat-tag.me').count()) problems.push('an untagged party sees a tag of itself');
    await shot(A, '07b-campaign-group-chat-tagged');
    log('campaign group chat + @ tag ok');

    // ---- counting
    for (const p of [A, B, C]) await see(p, 'Counting ends in', 60000);
    log('counting');
    // chat: one-to-one from counting (always): what Blue Anchor writes to Lotus Front, only Lotus Front reads
    const chatCard = (p: Page) => p.locator('section.chat-card');
    for (const [n, p] of [['A', A], ['B', B], ['C', C]] as const) {
      await p.getByRole('heading', { name: 'Chats' }).first().waitFor({ state: 'visible', timeout: 10000 })
        .catch(async () => { problems.push(`the one-to-one chats are missing during counting (${n})`); await shot(p, `fail-chats-${n}`); });
    }
    await B.getByRole('tab', { name: /Lotus Front/ }).click();
    await B.getByPlaceholder('Message Lotus Front').fill('Shall we talk portfolios?');
    await B.getByRole('button', { name: 'Send', exact: true }).click();
    await see(B, 'Shall we talk portfolios?');
    await A.getByRole('tab', { name: /Blue Anchor/ }).click();
    await see(A, 'Shall we talk portfolios?');
    await sleep(500);
    if (await C.getByText('Shall we talk portfolios?').count()) problems.push('a one-to-one message leaked to a third party');
    if (!(await chatCard(A).getByRole('tabpanel', { name: 'Chat with Blue Anchor' }).count())) problems.push('one-to-one chat does not name the other party');
    await shot(A, '08b-counting-one-to-one-chat');
    // phone width: the names one below the other on the left, the open conversation (with its message box) on the right
    await B.setViewportSize({ width: PHONE_WIDTH, height: 844 });
    await chatCard(B).scrollIntoViewIfNeeded();
    const convTabs = chatCard(B).getByRole('tab');
    const [listBox, paneBox, tab0, tab1, sendBox] = await Promise.all([
      chatCard(B).getByRole('tablist').boundingBox(), chatCard(B).getByRole('tabpanel').boundingBox(), convTabs.nth(0).boundingBox(), convTabs.nth(1).boundingBox(),
      chatCard(B).getByRole('button', { name: 'Send', exact: true }).boundingBox(),
    ]);
    if (!listBox || !paneBox || !tab0 || !tab1 || !sendBox) problems.push('phone: a part of the one-to-one chat is not rendered');
    else {
      if (listBox.x + listBox.width > paneBox.x + 1) problems.push(`phone: the list of names should be left of the conversation (list ends ${listBox.x + listBox.width}, conversation starts ${paneBox.x})`);
      if (paneBox.width < 200) problems.push(`phone: the conversation is too narrow (${paneBox.width}px)`);
      if (tab1.y < tab0.y + tab0.height - 1 || Math.abs(tab1.x - tab0.x) > 1) problems.push('phone: the names should be one below the other');
      if (sendBox.x + sendBox.width > PHONE_WIDTH) problems.push(`phone: the Send button is off-screen (ends ${sendBox.x + sendBox.width})`);
    }
    await shot(B, '08c-counting-chat-phone');
    await B.setViewportSize({ width: 1400, height: 900 });
    log('one-to-one chats ok');
    await B.waitForFunction(() => /\d+ of \d+ seats declared/.test(document.body.innerText) && !/^0 of/.test(document.querySelector('.tally-foot')?.textContent ?? '0 of'), undefined, { timeout: 30000 });
    await shot(B, '08-counting');
    log('first seats declared');


    // Lotus Front proposes a government. Designer's rule: a government can never include every party.
    const dpm = A.locator('.pf', { hasText: 'Deputy Prime Minister' }).locator('select').first();
    const home = A.locator('.pf', { hasText: 'Home' }).locator('select').first();
    const send = btn(A, 'Send offer');
    await send.waitFor();
    // 1) everybody in: the UI blocks it (Send disabled + explanation) BEFORE the valid offer is sent
    await dpm.selectOption({ label: 'Blue Anchor' });
    await home.selectOption({ label: 'Green Leaf' });
    await see(A, 'At least one party must stay out of the government.', 10000);
    if (!(await send.isDisabled())) problems.push('Send offer should be disabled when every party is in the government');
    await shot(A, '09a-offer-everyone-blocked');
    // 2) wait until every seat is declared (a government is only confirmed then), then invite the partner that gives a majority; the other party stays in opposition
    // every contested seat declared (the total is the contested seats, not the map's seat count)
    await B.waitForFunction(() => { const m = /(\d+) of (\d+) seats declared/.exec(document.querySelector('.tally-foot')?.textContent ?? ''); return !!m && m[1] === m[2] && Number(m[1]) > 10; }, undefined, { timeout: 60000 });
    await home.selectOption({ value: '' });
    let partner = 'Blue Anchor';
    const combinedGood = async () => A.locator('.combined.good').count().then(n => n > 0);
    if (!(await combinedGood())) {
      partner = 'Green Leaf';
      await dpm.selectOption({ label: 'Green Leaf' });
      if (!(await combinedGood())) problems.push('neither Blue Anchor nor Green Leaf gives Lotus Front a majority; the offer cannot be confirmed');
    }
    const outName = partner === 'Blue Anchor' ? 'Green Leaf' : 'Blue Anchor';
    log(`Lotus Front proposes with ${partner}; ${outName} stays out`);
    for (let i = 0; i < 20 && (await send.isDisabled()); i++) await sleep(250);
    await send.click();
    const [PP, OO] = partner === 'Blue Anchor' ? [B, C] : [C, B];
    // the offer arrives in the partner's one-to-one chat with Lotus Front
    await PP.getByRole('tab', { name: /Lotus Front/ }).click();
    await see(PP, /Lotus Front proposes/);
    await sleep(500);
    if (await OO.getByText(/Lotus Front proposes/).count()) problems.push(`${outName} sees an offer it is not part of (offers are private)`);
    for (const pg of [A, B, C]) for (const nick of ['Asha', 'Ben', 'Chitra']) {
      const txt = await chatCard(pg).innerText();
      if (txt.includes(nick)) problems.push(`nickname ${nick} shown in chat card`);
    }
    await shot(PP, '09-offer');
    // an offer must stay usable in the narrower conversation of a phone
    await PP.setViewportSize({ width: PHONE_WIDTH, height: 844 });
    await btn(PP, 'Accept').first().scrollIntoViewIfNeeded();
    const acceptBox = await btn(PP, 'Accept').first().boundingBox();
    if (!acceptBox || acceptBox.x + acceptBox.width > PHONE_WIDTH) problems.push(`phone: the Accept button is off-screen (${JSON.stringify(acceptBox)})`);
    await shot(PP, '09b-offer-phone');
    await PP.setViewportSize({ width: 1400, height: 900 });
    // all seats are declared, so accepting confirms the government and the game finishes at once: the Result screen replaces the Counting screen
    await btn(PP, 'Accept').first().click();
    log('offer accepted');

    // ---- result
    for (const p of [A, B, C]) await see(p, 'Coalition government', 30000);
    log('result screen shown right after the acceptance');
    await see(A, 'Points');
    const rows = await A.locator('table.points tbody tr').count();
    if (rows !== 3) problems.push(`points table has ${rows} rows, expected 3`);
    await see(A, /Winner/);
    // the party that was left out of the government scores the opposition points (0)
    const outRow = (await (partner === 'Blue Anchor' ? C : B).locator('table.points tbody tr', { hasText: outName }).first().innerText()).replace(/\s+/g, ' ');
    log('left-out party row:', outRow);
    if ((await A.locator('table.points .party-avatar img').count()) !== 3) problems.push('result table should show 3 avatars');
    await shot(A, '11-result-admin');
    await shot(C, '12-result-c');
    log('result shown');

    // ---- play again: only the host sees it; everybody rolls over with their party and lands in the campaign
    if (await btn(B, 'Play again').count()) problems.push('a non-host must not see the Play again button');
    await see(B, 'Waiting for the host to play again');
    const phasesBefore = await A.locator('select').first().inputValue();
    await A.locator('select').first().selectOption({ value: phasesBefore === '1' ? '2' : '1' });
    await btn(A, 'Play again').click();
    // a new game starts in the pre-campaign for 3+ players: nothing is fielded and the budget is full again, so everybody fields again
    for (const p of [A, B, C]) await p.locator('.app.screen-preCampaign').waitFor({ timeout: 30000 });
    for (const [p, n] of [[A, 'A'], [B, 'B'], [C, 'C']] as const) {
      if (await btn(p, 'Save party').count()) problems.push(`${n}: party setup was shown again after play again`);
      if (await budgetNum(p) !== WORLD_CONFIG.budget) problems.push(`${n}: the new game does not start on a full budget (${await budget(p)})`);
      if ((await ownCount(p)) !== 0) problems.push(`${n}: candidates were carried over to the new game`);
    }
    await shot(A, '13-play-again-admin');
    for (const [n, p] of [['Asha', A], ['Ben', B], ['Chitra', C]] as const) {
      await p.waitForFunction(() => document.querySelectorAll('path.seat').length > 400, undefined, { timeout: 60000 });
      await stroke(p, 0.4, n);
      await settled(p, n + ' (new game)');
    }
    for (const p of [A, B, C]) await see(p, 'Campaign ends in', 60000);
    log('play again: everyone fielded again and is in the new campaign');
  } catch (e) {
    for (const [n, p] of [['A', A], ['B', B], ['C', C]] as const) await p.screenshot({ path: path.join(SHOTS, `fail-${n}.png`) }).catch(() => undefined);
    throw e;
  } finally {
    for (const c of ctxs) await c.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main().then(() => {
  killAll();
  if (problems.length) { console.error('\nPROBLEMS:\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log(`\nPASS: browser e2e (${((Date.now() - t0) / 1000).toFixed(0)}s). Screenshots in ${SHOTS}`);
  process.exit(0);
}).catch(e => {
  console.error('\nFAIL:', e instanceof Error ? e.message : e);
  if (problems.length) console.error('Other problems:\n  ' + problems.join('\n  '));
  killAll();
  process.exit(1);
});
