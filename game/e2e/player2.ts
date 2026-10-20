// A simple scripted "human-like" player that joins an existing game by join code and plays it.
//   npx tsx e2e/player2.ts <JOINCODE> [--name Player2] [--base http://localhost:8787] [--tick 600]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AVATARS, PARTY_COLOURS, PARTY_SYMBOLS, WORLD_CONFIG } from '@hp/shared';
import type { ClientMessage, GameMapPackage, ServerMessage, SeatId } from '@hp/shared';

const argv = process.argv.slice(2);
const code = argv.find(a => !a.startsWith('--'))!.toUpperCase();
const flag = (n: string, d: string) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = flag('base', 'http://localhost:8787');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const NAME = flag('name', 'Player2');
const CFG = WORLD_CONFIG;
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../../maps/world-500/site/data/game.json', import.meta.url)), 'utf8')) as GameMapPackage;
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${NAME}:`, ...a);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const seatName = new Map(PKG.seats.map(s => [s.id, s.name]));

async function api(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(BASE + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) } });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}

async function main() {
  const j = await api('POST', '/games/join', { joinCode: code, nickname: NAME });
  if (j.status !== 200 && j.status !== 201) throw new Error('join failed: ' + JSON.stringify(j));
  const { gameId, playerId, token } = j.json;
  log('requested to join; waiting for the admin to admit me ...');
  for (;;) {
    const l = await api('GET', `/games/${gameId}`, undefined, token);
    if (l.status === 401 || l.status === 403) throw new Error('declined by the admin');
    const me = l.json?.players?.find((p: any) => p.playerId === playerId);
    if (me && me.status !== 'pending') {
      log('admitted');
      const taken = new Set(l.json.players.map((p: any) => p.party?.colour).filter(Boolean));
      const takenSym = new Set(l.json.players.map((p: any) => p.party?.symbol).filter(Boolean));
      const colour = (PARTY_COLOURS.find(c => !taken.has(c.hex)) ?? PARTY_COLOURS[0]).hex;
      const symbol = (PARTY_SYMBOLS.find(s => !takenSym.has(s.id)) ?? PARTY_SYMBOLS[0]).id;
      const takenAv = new Set(l.json.players.map((p: any) => p.party?.avatar).filter(Boolean));
      const avatar = (AVATARS.find(a => !takenAv.has(a.id)) ?? AVATARS[0]).id;
      const r = await api('POST', `/games/${gameId}/party`, { party: { name: 'Player 2 Alliance', colour, symbol, avatar } }, token);
      log('party set', r.status, r.json?.error ?? '');
      break;
    }
    await sleep(1000);
  }

  const polled = new Set<SeatId>();
  let budget = 0, started = false, countingSeen = false, lastSeatName = '';
  let campaignStart = 0, campaignEnd = 0;
  const ws = new WebSocket(`${WS}?gameId=${encodeURIComponent(gameId)}&token=${encodeURIComponent(token)}`);
  const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
  let finish!: () => void;
  const done = new Promise<void>(r => (finish = r));
  ws.onopen = () => send({ action: 'ping', clientTime: Date.now() });
  setInterval(() => { try { send({ action: 'ping', clientTime: Date.now() }); } catch { /* ignore */ } }, 15000);

  const offerResponded = new Set<string>();
  ws.onmessage = ev => {
    const m = JSON.parse(String(ev.data)) as ServerMessage;
    switch (m.type) {
      case 'hello': budget = m.private.budget; if (m.snapshot.timeline) { campaignStart = m.snapshot.timeline.campaignStart; campaignEnd = m.snapshot.timeline.campaignEnd; } break;
      case 'private': budget = m.private.budget; break;
      case 'actionAck': budget = m.budget; break;
      case 'report': budget = m.budget; log('report', m.report.scope, m.report.entries.map(e => `${e.rank}.${(e.estimate * (m.report.scope === 'seat' ? 100 : 1)).toFixed(0)}`).join(' ')); break;
      case 'status': if (m.timeline) { campaignStart = m.timeline.campaignStart; campaignEnd = m.timeline.campaignEnd; } if (m.status === 'campaign') started = true; if (m.status === 'counting') { countingSeen = true; log('counting started'); } break;
      case 'phaseClosed': m.seats.forEach(s => polled.add(s)); log(`phase ${m.phase + 1} closed (${m.seats.length} seats)`); break;
      case 'news': if (m.item.playerId !== playerId) lastSeatName = seatName.get(m.item.seat) ?? ''; break;
      case 'offer':
        if (m.offer.status === 'open' && m.offer.partners.includes(playerId) && !offerResponded.has(m.offer.offerId)) {
          offerResponded.add(m.offer.offerId);
          const mine = Object.entries(m.offer.portfolios).filter(([, ps]) => ps.includes(playerId)).map(([k]) => k);
          log(`offer from ${m.offer.proposer.slice(0, 6)}: I would get [${mine.join(', ') || 'nothing'}] -> accepting`);
          setTimeout(() => send({ action: 'respondOffer', offerId: m.offer.offerId, accept: true }), 2500);
        }
        break;
      case 'government': log('government formed, PM', m.government.pm.slice(0, 6)); break;
      case 'result': log('RESULT:', m.result.outcome, 'winners', m.result.winners.map(w => w.slice(0, 6)).join(','), 'my points', m.result.points.find(p => p.playerId === playerId)?.total); finish(); break;
      case 'error': log('server error', m.error, m.message); break;
    }
  };

  // wait for the campaign
  while (!started) await sleep(500);
  await sleep(6000);
  log('campaign running; budget', budget);
  // Fast pacing (designer: 4 s per decision was too slow): one decision every TICK_MS, budget spread evenly over the
  // remaining campaign so the bot never runs dry early; a rally roughly every 5th action; two global reports.
  const TICK_MS = Number(flag('tick', '600'));
  let tick = 0, reports = 0;
  const reportBudget = 2 * CFG.analyst.globalReport.end;
  while (!countingSeen) {
    tick++;
    const open = PKG.seats.map(s => s.id).filter(id => !polled.has(id));
    // pace: by time fraction f of the campaign, spend at most f of the (budget minus report reserve), plus one rally of slack
    const f = campaignEnd > campaignStart ? Math.min(1, Math.max(0, (Date.now() - campaignStart) / (campaignEnd - campaignStart))) : 1;
    const allowedSpent = f * (CFG.budget - reportBudget) + CFG.costs.rally;
    const spendable = Math.min(budget - (reports < 2 ? reportBudget : 0), allowedSpent - (CFG.budget - budget));
    const type = tick % 5 === 0 && spendable >= CFG.costs.rally ? 'rally' : 'roadshow';
    if (spendable >= CFG.costs[type] && open.length) send({ action: 'campaign', type, seat: pick(open) });
    if ((tick === 40 || tick === 200) && reports < 2) { send({ action: 'buyReport', scope: 'global' }); reports++; }
    await sleep(TICK_MS);
  }
  log('waiting for the result ...');
  await done;
  ws.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
