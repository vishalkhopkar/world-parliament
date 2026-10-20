// Balance simulator for HUNG PARLIAMENT. Usage (from game/sim):
//   npx tsx src/run.ts --mode field --games 200 --players 2,3,5,10 --phases 1,3,5
// Modes: field (random strategy mix), h2h (2-player matrix), lone, mix (rally-share sweep), checks (analytic), full.
import fs from 'node:fs';
import { WORLD_CONFIG, createRng, haversineKm } from '@hp/shared';
import type { MapConfig } from '@hp/shared';
import { DEFAULT_POOL, STRATEGIES } from './bots';
import { runGame } from './game';
import { Agg, StratAgg, fieldTable, pad, padR, pct } from './metrics';
import { buildWorld, loadMap } from './world';
import type { World } from './world';

interface Args {
  mode: string;
  games: number;
  players: number[];
  phases: number[];
  seed: string;
  pool: string[];
  sets: string[];
  json?: string;
  verify: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { mode: 'field', games: 200, players: [2, 3, 5, 10], phases: [1, 3, 5], seed: 'hp', pool: DEFAULT_POOL, sets: [], verify: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const next = () => argv[++i];
    if (f === '--mode') a.mode = next();
    else if (f === '--games') a.games = Number(next());
    else if (f === '--players') a.players = next().split(',').map(Number);
    else if (f === '--phases') a.phases = next().split(',').map(Number);
    else if (f === '--seed') a.seed = next();
    else if (f === '--strategies' || f === '--pool') a.pool = next().split(',');
    else if (f === '--set') a.sets.push(next());
    else if (f === '--json') a.json = next();
    else if (f === '--verify') a.verify = true;
    else if (f === '--quiet') a.quiet = true;
    else throw new Error(`unknown flag ${f}`);
  }
  return a;
}

/** Apply "effects.rally.local=1.2" style overrides to a deep copy of the config. */
export function withOverrides(base: MapConfig, sets: string[]): MapConfig {
  const cfg = JSON.parse(JSON.stringify(base)) as MapConfig;
  for (const s of sets) {
    const [path, val] = s.split('=');
    const keys = path.split('.');
    let o: any = cfg;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = Number(val.replace(/_/g, ''));
  }
  return cfg;
}

function log(...x: unknown[]) { console.log(...x); }

function sample<T>(rng: () => number, pool: T[], m: number): T[] {
  return Array.from({ length: m }, () => pool[Math.floor(rng() * pool.length)]);
}

// ------------------------------------------------------------------ modes

function modeField(w: World, args: Args, out: Record<string, unknown>) {
  for (const P of args.players) {
    for (const k of args.phases) {
      const agg = new Agg();
      const rng = createRng(`${args.seed}:field:${P}:${k}`);
      let vmax = 0;
      for (let g = 0; g < args.games; g++) {
        const strat = sample(rng, args.pool, P);
        const r = runGame(w, strat, k, `${args.seed}:f:${P}:${k}:${g}`, { verify: args.verify && g < 5 });
        vmax = Math.max(vmax, r.verifyDiff);
        agg.add(r);
      }
      if (args.verify) log(`verify: max |incremental - engine| effect diff = ${vmax.toExponential(2)}`);
      log(`\n== FIELD  players=${P} phases=${k} games=${args.games}  (random strategy per seat of the table)  ${(agg.ms / agg.games).toFixed(1)} ms/game`);
      log(fieldTable(agg, P, w.cfg.seatCount, w.cfg.budget));
      log(`pure-c seats ${pct(agg.pureC / agg.games / w.cfg.seatCount)}   c-only winner == actual winner ${pct(agg.cMatch / agg.games / w.cfg.seatCount)}   actions rejected (frozen seat) ${agg.rejected}`);
      out[`field_${P}_${k}`] = summarise(agg, P, w);
    }
  }
}

function summarise(agg: Agg, P: number, w: World) {
  const o: Record<string, unknown> = { games: agg.games, msPerGame: agg.ms / agg.games, pureC: agg.pureC / agg.games / w.cfg.seatCount, cMatch: agg.cMatch / agg.games / w.cfg.seatCount };
  for (const [s, a] of agg.by) {
    o[s] = { n: a.appearances, seats: a.seats / a.appearances / w.cfg.seatCount, win: a.win / a.appearances, winFair: (a.win / a.appearances) * P, maj: a.maj / a.appearances };
  }
  return o;
}

function modeH2H(w: World, args: Args, out: Record<string, unknown>) {
  const pool = args.pool;
  for (const k of args.phases) {
    const win: number[][] = pool.map(() => pool.map(() => 0));
    const seats: number[][] = pool.map(() => pool.map(() => 0));
    let ms = 0; let cnt = 0; let pure = 0;
    for (let a = 0; a < pool.length; a++) {
      for (let b = a; b < pool.length; b++) {
        let wa = 0; let sa = 0; let sb = 0;
        for (let g = 0; g < args.games; g++) {
          const flip = g % 2 === 1;
          const r = runGame(w, flip ? [pool[b], pool[a]] : [pool[a], pool[b]], k, `${args.seed}:h:${k}:${a}:${b}:${g}`);
          const ra = flip ? r.players[1] : r.players[0];
          const rb = flip ? r.players[0] : r.players[1];
          wa += ra.win; sa += ra.seats; sb += rb.seats;
          ms += r.ms; cnt++; pure += r.pureC;
        }
        win[a][b] = wa / args.games; win[b][a] = 1 - wa / args.games;
        seats[a][b] = sa / args.games; seats[b][a] = sb / args.games;
      }
    }
    log(`\n== HEAD-TO-HEAD 2 players, phases=${k}, games/pair=${args.games}: row strategy's WIN% vs column (mean seats in brackets)  ${(ms / cnt).toFixed(1)} ms/game, pure-c seats ${pct(pure / cnt / w.cfg.seatCount)}`);
    log(padR('', 13) + pool.map((s) => pad(s.slice(0, 11), 12)).join('') + pad('avg win', 9));
    const avgs: number[] = [];
    for (let a = 0; a < pool.length; a++) {
      let tot = 0;
      let row = padR(pool[a], 13);
      for (let b = 0; b < pool.length; b++) {
        row += pad(`${(100 * win[a][b]).toFixed(0)} (${seats[a][b].toFixed(0)})`, 12);
        if (a !== b) tot += win[a][b];
      }
      avgs.push(tot / (pool.length - 1));
      row += pad(pct(avgs[a], 1), 9);
      log(row);
    }
    out[`h2h_${k}`] = { pool, win, seats, avgWin: avgs };
  }
}

function modeMix(w: World, args: Args, out: Record<string, unknown>) {
  // rally-share sweep: each mix level vs a field of the default pool
  const levels = ['ROADSHOW', 'MIX10', 'MIX20', 'MIX30', 'MIX50', 'MIX70', 'MIX100E', 'RALLY_EARLY'];
  const short: Record<string, string> = { ROADSHOW: 'RS', MIX10: 'M10', MIX20: 'M20', MIX30: 'M30', MIX50: 'M50', MIX70: 'M70', RALLY_EARLY: 'RLE', RALLY: 'RL', MIX100E: 'M100E', MIX100: 'M100', MIX50E: 'M50E' };
  for (const P of args.players) {
    for (const k of args.phases) {
      const res: string[] = [];
      const rec: Record<string, unknown> = {};
      for (const lv of levels) {
        // one player of strategy lv, the rest drawn from the default pool
        const rng = createRng(`${args.seed}:mix:${P}:${k}:${lv}`);
        let win = 0; let seats = 0; let n = 0;
        for (let g = 0; g < args.games; g++) {
          const strat = [lv, ...sample(rng, DEFAULT_POOL, P - 1)];
          const r = runGame(w, strat, k, `${args.seed}:m:${P}:${k}:${lv}:${g}`);
          win += r.players[0].win; seats += r.players[0].seats; n++;
        }
        res.push(`${short[lv]} ${(100 * seats / n / w.cfg.seatCount).toFixed(1)}/${(100 * win / n).toFixed(0)}`);
        rec[lv] = { seats: seats / n / w.cfg.seatCount, win: win / n };
      }
      log(`MIX P=${P} k=${k} (seats%/win%, fair ${(100 / P).toFixed(0)}%): ` + res.join(' | '));
      out[`mix_${P}_${k}`] = rec;
    }
  }
}

/** Replicator dynamics: strategies that beat the table average become more common; shows the stable population. */
function modeEvolve(w: World, args: Args, out: Record<string, unknown>) {
  const pool = args.pool.length > 0 && args.pool !== DEFAULT_POOL ? args.pool : ['RALLY_EARLY', 'ROADSHOW', 'MIX10', 'MIX20', 'MIX30', 'MIX50', 'MIX70', 'CLUSTER', 'SNIPER', 'ADAPTIVE', 'LATE'];
  const rounds = 14;
  for (const P of args.players) {
    for (const k of args.phases) {
      let wt = pool.map(() => 1 / pool.length);
      const rng = createRng(`${args.seed}:evo:${P}:${k}`);
      let last: Agg | undefined;
      for (let r = 0; r < rounds; r++) {
        const agg = new Agg();
        for (let g = 0; g < args.games; g++) {
          const strat: string[] = [];
          for (let q = 0; q < P; q++) {
            let u = rng(); let idx = 0;
            while (idx < pool.length - 1 && u > wt[idx]) { u -= wt[idx]; idx++; }
            strat.push(pool[idx]);
          }
          agg.add(runGame(w, strat, k, `${args.seed}:e:${P}:${k}:${r}:${g}`));
        }
        last = agg;
        const fit = pool.map((s) => { const a = agg.by.get(s); return a ? a.seats / a.appearances / (w.cfg.seatCount / P) : 1; });
        const mean = fit.reduce((acc, f, i) => acc + f * wt[i], 0);
        const nw = wt.map((x, i) => x * Math.exp(2.5 * (fit[i] / mean - 1)));
        const tot = nw.reduce((a, b) => a + b, 0);
        wt = nw.map((x) => Math.max(0.005, x / tot));
        const t2 = wt.reduce((a, b) => a + b, 0);
        wt = wt.map((x) => x / t2);
      }
      log(`
== EVOLVED POPULATION players=${P} phases=${k} (after ${rounds} rounds of ${args.games} games); fitness = seats / fair share`);
      const rows = pool.map((s, i) => {
        const a = (last as Agg).by.get(s) as StratAgg | undefined;
        return { s, w: wt[i], f: a ? a.seats / a.appearances / (w.cfg.seatCount / P) : NaN };
      }).sort((a, b) => b.w - a.w);
      log(rows.map((r) => `${padR(r.s, 13)} weight ${pad(pct(r.w, 0), 5)}  fitness ${r.f.toFixed(2)}`).join(String.fromCharCode(10)));
      out[`evolve_${P}_${k}`] = rows;
    }
  }
}

/** Crowding: as more players pile into dense clusters, their advantage should vanish and neglected seats get cheap. */
function modeCrowd(w: World, args: Args, out: Record<string, unknown>) {
  const P = 10;
  const k = args.phases[0] ?? 3;
  const order = Array.from({ length: w.n }, (_, i) => i).sort((a, b) => w.density[b] - w.density[a]);
  const dense = order.slice(0, 100);
  log(`CROWD players=${P} phases=${k}: m CLUSTER players, ${P} - m ROADSHOW players (random spread); per-player seat share`);
  log(`${pad('m', 3)}${pad('CLUSTER', 10)}${pad('ROADSHOW', 10)}${pad('distinct winners in 100 densest seats', 40)}${pad('best single share of them', 28)}`);
  for (const m of [1, 2, 3, 5, 7, 9, 10]) {
    let sc = 0; let sr = 0; let nc = 0; let nr = 0; let distinct = 0; let top = 0;
    for (let g = 0; g < args.games; g++) {
      const strat = [...Array(m).fill('CLUSTER'), ...Array(P - m).fill('ROADSHOW')];
      const r = runGame(w, strat, k, `${args.seed}:c:${m}:${g}`);
      for (const p of r.players) { if (p.strategy === 'CLUSTER') { sc += p.seats; nc++; } else { sr += p.seats; nr++; } }
      const cnt = new Map<number, number>();
      for (const i of dense) { const wn = r.winners[i]; if (wn >= 0) cnt.set(wn, (cnt.get(wn) ?? 0) + 1); }
      distinct += cnt.size;
      top += Math.max(0, ...cnt.values()) / dense.length;
    }
    log(`${pad(m, 3)}${pad(nc ? pct(sc / nc / w.cfg.seatCount) : '-', 10)}${pad(nr ? pct(sr / nr / w.cfg.seatCount) : '-', 10)}${pad((distinct / args.games).toFixed(1), 40)}${pad(pct(top / args.games), 28)}`);
  }
}

function modeLone(w: World, args: Args, out: Record<string, unknown>) {
  const opp = ['RALLY_EARLY', 'RALLY'];
  for (const k of args.phases) {
    for (const o of opp) {
      let seats = 0; let wins = 0;
      for (let g = 0; g < args.games; g++) {
        const r = runGame(w, ['ROADSHOW', o], k, `${args.seed}:l:${k}:${o}:${g}`);
        seats += r.players[0].loneSeats; wins += r.players[0].loneWins;
      }
      log(`LONE roadshow vs all-${o}, phases=${k}: lone-roadshow seats/game ${(seats / args.games).toFixed(1)}  won ${pct(wins / Math.max(1, seats), 2)}`);
      out[`lone_${k}_${o}`] = { seatsPerGame: seats / args.games, winRate: wins / Math.max(1, seats) };
    }
  }
}

function modeChecks(w: World, args: Args, out: Record<string, unknown>) {
  const c = w.cfg;
  const R = c.budget / c.costs.rally;
  const S = c.budget / c.costs.roadshow;
  const cR = c.effects.rally.global * R;
  log('== ANALYTIC CHECKS');
  log(`budget ${c.budget.toLocaleString()}  rally ${c.costs.rally.toLocaleString()} (max ${R.toFixed(1)})  roadshow ${c.costs.roadshow.toLocaleString()} (max ${S.toFixed(1)})  ratio ${(c.costs.rally / c.costs.roadshow).toFixed(2)}`);
  log(`actions affordable: ${R.toFixed(0)} rallies ... ${S.toFixed(0)} roadshows`);
  log(`c x R_max = ${cR.toFixed(3)} (x1.1 late = ${(cR * 1.1).toFixed(3)});  s = ${c.effects.roadshow.local};  s / (c R) = ${(c.effects.roadshow.local / cR).toFixed(2)};  s / (1.1 c R) = ${(c.effects.roadshow.local / (1.1 * cR)).toFixed(2)}`);
  log(`y = ${c.effects.rally.local}, c = ${c.effects.rally.global}; s/y = ${(c.effects.roadshow.local / c.effects.rally.local).toFixed(2)}`);
  const cs = c.costs.roadshow;
  log(`seat report ${c.analyst.seatReport.start.toLocaleString()} -> ${c.analyst.seatReport.end.toLocaleString()} = ${(c.analyst.seatReport.start / cs).toFixed(1)} -> ${(c.analyst.seatReport.end / cs).toFixed(1)} roadshows (end/start ${(c.analyst.seatReport.end / c.analyst.seatReport.start).toFixed(2)})`);
  log(`global report ${c.analyst.globalReport.start.toLocaleString()} -> ${c.analyst.globalReport.end.toLocaleString()} = ${(c.analyst.globalReport.start / cs).toFixed(1)} -> ${(c.analyst.globalReport.end / cs).toFixed(1)} roadshows (end/start ${(c.analyst.globalReport.end / c.analyst.globalReport.start).toFixed(2)})`);
  log(`noise (share std / relative seats std) ${c.analyst.noise}; randomSwing ${c.randomSwing}`);

  // spill-over profile
  const kern = w.kernels;
  const names = JSON.parse(fs.readFileSync(new URL('../../../maps/world-500/site/data/seats.json', import.meta.url), 'utf8')) as { id: number; name: string }[];
  const nm = new Map(names.map((s) => [s.id, s.name]));
  const find = (re: RegExp) => w.map.seats.find((s) => re.test(nm.get(s.id) ?? ''));
  const show = (label: string, seat: { id: number } | undefined) => {
    if (!seat) { log(`  (${label}: not found)`); return; }
    const i = kern.index.get(seat.id) as number;
    const near: { d: number; r: number; s: number; name: string }[] = [];
    for (let j = 0; j < kern.n; j++) if (j !== i) near.push({ d: kern.distanceKm[i * kern.n + j], r: kern.rally[i * kern.n + j], s: kern.roadshow[i * kern.n + j], name: nm.get(kern.seatIds[j]) ?? String(kern.seatIds[j]) });
    near.sort((a, b) => a.d - b.d);
    log(`  ${label} = seat ${seat.id} ${nm.get(seat.id)}; nearest: ` + near.slice(0, 5).map((x) => `${x.name} ${x.d.toFixed(0)}km r=${x.r.toFixed(2)} s=${x.s.toFixed(2)}`).join(' | '));
  };
  log('spill-over examples (rally r, roadshow s, absolute):');
  show('Dhaka City', find(/^dhaka city$/i));
  show('Delhi East', find(/^delhi east$/i));
  show('Moscow', find(/^moscow$/i));
  const pairKm = (a: RegExp, b: RegExp, label: string) => {
    const sa = find(a); const sb = find(b);
    if (!sa || !sb) { log(`  (${label}: not found)`); return; }
    const i = kern.index.get(sa.id) as number; const j = kern.index.get(sb.id) as number;
    log(`  ${label}: ${kern.distanceKm[i * kern.n + j].toFixed(0)} km, rally spill ${kern.rally[i * kern.n + j].toFixed(3)} (${(100 * kern.rally[i * kern.n + j] / c.effects.rally.local).toFixed(1)}% of y), roadshow spill ${kern.roadshow[i * kern.n + j].toFixed(3)} (${(100 * kern.roadshow[i * kern.n + j] / c.effects.roadshow.local).toFixed(1)}% of s)`);
  };
  pairKm(/^dhaka city$/i, /^dhaka outer$/i, 'Dhaka City -> Dhaka Outer');
  pairKm(/^siberia east$/i, /^siberia west$/i, 'Siberia East -> Siberia West');
  pairKm(/^moscow$/i, /^moscow outer$/i, 'Moscow -> Moscow Outer');
  pairKm(/^moscow$/i, /^urals$/i, 'Moscow -> Urals');
  // distribution: seats receiving spill
  const rs = [0.5, 0.25, 0.1];
  const cnt = rs.map(() => 0);
  const cntS = rs.map(() => 0);
  for (let i = 0; i < kern.n; i++) for (let j = 0; j < kern.n; j++) {
    if (i === j) continue;
    rs.forEach((t, q) => {
      if (kern.rally[i * kern.n + j] >= t * c.effects.rally.local) cnt[q]++;
      if (kern.roadshow[i * kern.n + j] >= t * c.effects.roadshow.local) cntS[q]++;
    });
  }
  log(`mean #other seats receiving rally spill >= ${rs.map((t, q) => `${t}y: ${(cnt[q] / kern.n).toFixed(2)}`).join(', ')}`);
  log(`mean #other seats receiving roadshow spill >= ${rs.map((t, q) => `${t}s: ${(cntS[q] / kern.n).toFixed(2)}`).join(', ')}`);
  const dens = [...w.density].sort((a, b) => a - b);
  log(`rally spill-sum (density): median ${dens[250].toFixed(2)}  p90 ${dens[450].toFixed(2)}  max ${dens[499].toFixed(2)} (in units of y)`);
  const sp = (seats: number[]) => seats.length;
  void sp;
}

// ------------------------------------------------------------------ main

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = withOverrides(WORLD_CONFIG, args.sets);
  const map = loadMap();
  const t0 = performance.now();
  const w = buildWorld(map, cfg);
  const out: Record<string, unknown> = {};
  if (!args.quiet) log(`config overrides: ${args.sets.join(' ') || '(none)'}  seed=${args.seed}  world built in ${(performance.now() - t0).toFixed(0)} ms`);
  const modes = args.mode === 'full' ? ['checks', 'lone', 'mix', 'h2h', 'field'] : [args.mode];
  for (const m of modes) {
    if (m === 'field') modeField(w, args, out);
    else if (m === 'h2h') modeH2H(w, args, out);
    else if (m === 'lone') modeLone(w, args, out);
    else if (m === 'evolve') modeEvolve(w, args, out);
    else if (m === 'crowd') modeCrowd(w, args, out);
    else if (m === 'mix') modeMix(w, args, out);
    else if (m === 'checks') modeChecks(w, args, out);
    else throw new Error(`unknown mode ${m}`);
  }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 1));
  if (!args.quiet) log(`\ntotal ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

void StratAgg;
void STRATEGIES;
main();
