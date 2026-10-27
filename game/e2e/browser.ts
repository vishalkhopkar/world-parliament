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
const API_PORT = 8787, WEB_PORT = 5173;
const URL_ = `http://localhost:${WEB_PORT}/?server=local`;

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
  for (const f of ['01-home', '02-lobby-admin', '03-party', '04-lobby-ready', '05-campaign-admin', '06-campaign-b-report', '07-campaign-c-seat-report', '08-counting', '09-offer', '09a-offer-everyone-blocked', '10-government', '11-result-admin', '12-result-c']) rmSync(path.join(SHOTS, f + '.png'), { force: true });
  if (!existsSync(CHROME)) throw new Error('Chrome not found at ' + CHROME + ' (set CHROME_PATH)');
  for (const p of [API_PORT, WEB_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is already in use; stop that server first`);

  log('starting dev server + vite');
  start('server', [path.join(gameDir, 'node_modules/tsx/dist/cli.mjs'), 'src/local/devServer.ts'], path.join(gameDir, 'server'), {
    HP_CAMPAIGN_MS: '45000', HP_COUNTING_MS: '20000', HP_POST_MS: '15000', HP_START_DELAY_MS: '2000', HP_PORT: String(API_PORT),
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
    for (const p of [A, B, C]) await see(p, 'Campaign ends in');
    for (const p of [A, B, C]) await p.getByText('Campaign starts in').first().waitFor({ state: 'hidden', timeout: 15000 });
    log('campaign started');

    // ---- campaign: rallies + roadshows
    const bud0 = await budget(A);
    const seatA = await clickSeat(A, 0);
    await A.locator('.sam-rally').click();
    await see(A, 'My actions (1)');
    await clickSeat(A, 0);
    await A.locator('.sam-roadshow').click();
    await see(A, 'My actions (2)');
    const bud1 = await budget(A);
    if (bud0 === bud1) problems.push('budget did not change after campaigning');
    log(`Asha acted in seat ${seatA}; budget ${bud0} -> ${bud1}`);
    if (!(await A.locator('.hud-me .party-avatar img').isVisible())) problems.push('campaign HUD does not show my avatar');
    await shot(A, '05-campaign-admin');

    await clickSeat(B, 3);
    await B.locator('.sam-rally').click();
    await see(B, 'My actions (1)');
    await clickSeat(B, 4);
    await B.locator('.sam-roadshow').click();
    await see(B, 'My actions (2)');
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

    await clickSeat(C, 6);
    await C.locator('.sam-rally').click();
    await see(C, 'My actions (1)');
    await clickSeat(C, 6);
    if (WORLD_CONFIG.analyst.seatReport.enabled) {
      await C.locator('.sam-report').click();
      await C.locator('.report').first().waitFor({ timeout: 10000 });
    } else if (await C.locator('.sam-report').count()) problems.push('the seat report is switched off but its option is shown');
    await shot(C, '07-campaign-c-seat-report');
    // privacy: Asha's roadshow must not show up for Ben as news (only rallies are public)
    if (await B.locator('.nt').getByText(/roadshow/i).count()) problems.push('a roadshow leaked into the news ticker');

    // a reload rejoins the game (session kept in localStorage)
    await C.reload();
    await see(C, 'Campaign ends in', 30000);
    await see(C, 'My actions (1)');
    log('Chitra reloaded and rejoined');

    // campaign-phase chat: the ONE group chat is open from the campaign start (messaging.opensAt = campaign); everybody reads it
    for (const p of [A, B, C]) await p.getByRole('heading', { name: 'Group chat' }).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => problems.push('the group chat card is missing during the campaign'));
    await B.getByPlaceholder('Message everyone').fill('Campaign hello from Blue Anchor');
    await B.getByRole('button', { name: 'Send', exact: true }).click();
    await see(B, 'Campaign hello from Blue Anchor'); await see(A, 'Campaign hello from Blue Anchor'); await see(C, 'Campaign hello from Blue Anchor');
    log('campaign group chat ok');

    // ---- counting
    for (const p of [A, B, C]) await see(p, 'Counting ends in', 60000);
    log('counting');
    await B.waitForFunction(() => /\d+ of 500 seats declared/.test(document.body.innerText) && !/^0 of/.test(document.querySelector('.tally-foot')?.textContent ?? '0 of'), undefined, { timeout: 30000 });
    await shot(B, '08-counting');

    // chat: ONE group chat (messaging.mode = group, the default): what Blue Anchor writes, everybody reads (party names, never nicknames)
    const chatCard = (p: Page) => p.locator('section.card', { has: p.getByRole('heading', { name: 'Group chat' }) });
    await B.getByPlaceholder('Message everyone').fill('Shall we talk portfolios?');
    await B.getByRole('button', { name: 'Send', exact: true }).click();
    await see(B, 'Shall we talk portfolios?');
    await see(A, 'Shall we talk portfolios?');
    await see(C, 'Shall we talk portfolios?');
    if (!(await chatCard(C).getByText('Blue Anchor').count())) problems.push('group chat does not name the sender by party');

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
    await see(B, /500 of 500 seats declared/, 60000);
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
    await see(PP, /Lotus Front proposes/);
    await sleep(500);
    if (await OO.getByText(/Lotus Front proposes/).count()) problems.push(`${outName} sees an offer it is not part of (offers are private)`);
    for (const pg of [A, B, C]) for (const nick of ['Asha', 'Ben', 'Chitra']) {
      const txt = await pg.locator('section.card', { has: pg.getByRole('heading', { name: 'Group chat' }) }).innerText();
      if (txt.includes(nick)) problems.push(`nickname ${nick} shown in chat card`);
    }
    await shot(PP, '09-offer');
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
