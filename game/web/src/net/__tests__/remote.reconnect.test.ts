import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@hp/shared';
import { RemoteTransport } from '../remote';
import type { LinkState } from '../transport';

/** Minimal controllable WebSocket. */
class FakeWs {
  static all: FakeWs[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  createdAt = Date.now();
  constructor(public url: string) { FakeWs.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  recv(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
  hello() { this.recv({ type: 'hello', serverTime: Date.now(), snapshot: {}, private: {} }); }
  pong() { this.recv({ type: 'pong', clientTime: 0, serverTime: Date.now() }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}
const last = () => FakeWs.all[FakeWs.all.length - 1];
const pings = (w: FakeWs) => w.sent.filter(s => s.includes('"ping"')).length;

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('RemoteTransport reconnect (phone: tab switched or browser app backgrounded)', () => {
  let t: RemoteTransport;
  let states: LinkState[];
  let msgs: ServerMessage[];

  const connected = () => {
    t.connect('g1', 'tok', m => msgs.push(m), s => states.push(s));
    last().open(); last().hello();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWs.all = [];
    vi.stubGlobal('WebSocket', FakeWs);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline')))); // the REST probe must never hit a real network
    t = new RemoteTransport({ apiUrl: 'https://api.test', wsUrl: 'wss://ws.test/live', retryMs: 5_000 });
    states = []; msgs = [];
  });
  afterEach(() => { t.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('reconnects at once when the tab becomes visible and the old socket is silently dead', () => {
    connected();
    const dead = last();
    setHidden(true);
    vi.advanceTimersByTime(120_000); // phone asleep: the socket never reports a close
    setHidden(false);
    vi.advanceTimersByTime(4_000);   // the ping we send on return gets no answer
    expect(FakeWs.all.length).toBe(2);
    expect(last()).not.toBe(dead);
    last().open(); last().hello();
    expect(states[states.length - 1]).toBe('open');
  });

  it('keeps a healthy socket when the tab returns and the server answers the ping', () => {
    connected();
    const ws = last();
    setHidden(true); vi.advanceTimersByTime(10_000); setHidden(false);
    expect(pings(ws)).toBeGreaterThan(1); // probed on return
    ws.pong();
    vi.advanceTimersByTime(10_000);
    expect(FakeWs.all.length).toBe(1);
  });

  it('does not give up after a long background period during which retries could not run', () => {
    connected();
    last().drop();                       // closed while backgrounded; a retry timer is now pending
    setHidden(true);
    vi.setSystemTime(Date.now() + 300_000); // browser froze timers for 5 minutes: the clock jumps, no timer fires
    setHidden(false);
    vi.advanceTimersByTime(1_000);       // the resume handler (or the pending retry) opens a socket
    last().drop();                       // it fails once more; the old code now sees "down for 5 min" and gives up
    vi.advanceTimersByTime(1_000);
    expect(states).not.toContain('down');
    expect(msgs.some(m => m.type === 'error')).toBe(false);
    last().open(); last().hello();
    expect(states[states.length - 1]).toBe('open');
  });

  it('reconnects immediately when the network comes back (online event)', () => {
    connected();
    last().drop();
    vi.advanceTimersByTime(6_000);        // backoff has grown
    const n = FakeWs.all.length;
    window.dispatchEvent(new Event('online'));
    expect(FakeWs.all.length).toBe(n + 1);
  });

  it('detects a half-open socket while the tab stays visible (no traffic for two ping intervals)', () => {
    connected();
    const dead = last();
    vi.advanceTimersByTime(45_000);       // pings go out, nothing ever comes back
    expect(FakeWs.all.length).toBeGreaterThanOrEqual(2);
    expect(last()).not.toBe(dead);
  });

  it('queues clicks made while the socket is dead and delivers them after the reconnect', () => {
    connected();
    last().drop();
    t.send({ action: 'campaign', type: 'roadshow', seat: 7, clientRef: 'c1' } as never);
    vi.advanceTimersByTime(6_000);
    last().open(); last().hello();
    expect(last().sent.some(s => s.includes('"roadshow"'))).toBe(true);
  });

  describe('never waits forever for a connection that is not coming', () => {
    it('abandons a socket that stays CONNECTING (mobile network black hole) and tries a new one', () => {
      t.connect('g1', 'tok', m => msgs.push(m), s => states.push(s));
      const first = last();              // never opens, never errors
      vi.advanceTimersByTime(9_000);
      vi.advanceTimersByTime(6_000);     // the 5 s wait before the next attempt
      expect(FakeWs.all.length).toBeGreaterThanOrEqual(2);
      expect(last()).not.toBe(first);
      expect(states).not.toContain('down');
    });

    it('abandons a socket that opens but never delivers the hello (lost first ping) and tries a new one', () => {
      t.connect('g1', 'tok', m => msgs.push(m), s => states.push(s));
      const first = last(); first.open(); // open, but the server never answers
      vi.advanceTimersByTime(9_000);
      vi.advanceTimersByTime(6_000);
      expect(last()).not.toBe(first);
      last().open(); last().hello();
      expect(states[states.length - 1]).toBe('open');
    });

    it('keeps trying on a bad network for minutes without silently freezing', () => {
      t.connect('g1', 'tok', m => msgs.push(m), s => states.push(s));
      vi.advanceTimersByTime(120_000);
      expect(FakeWs.all.length).toBeGreaterThanOrEqual(8); // many attempts, not one stuck forever
    });

    it('a stalled retry chain (lost timers) is restarted by the watchdog', () => {
      t.connect('g1', 'tok', m => msgs.push(m), s => states.push(s));
      const first = last();
      // simulate a lost handshake timer: the attempt would otherwise sit there forever
      const timers = (t as unknown as { timers: { hello?: ReturnType<typeof setTimeout> } }).timers;
      clearTimeout(timers.hello); timers.hello = undefined;
      vi.advanceTimersByTime(30_000);
      expect(FakeWs.all.length).toBeGreaterThanOrEqual(2);
      expect(last()).not.toBe(first);
    });
  });

  describe('manual reconnect (the "Reconnect now" button)', () => {
    it('opens a fresh socket immediately and resets the backoff', () => {
      connected();
      last().drop();
      vi.advanceTimersByTime(20_000);
      const n = FakeWs.all.length;
      t.reconnect();
      expect(FakeWs.all.length).toBe(n + 1);
      last().open(); last().hello();
      expect(states[states.length - 1]).toBe('open');
    });

    it('also works after the transport gave up ("down")', () => {
      t.connect('g1', 'tok', m => msgs.push(m), s => states.push(s));
      last().drop(1008);                 // the server closes declined players with 1008: fatal
      expect(states).toContain('down');
      const n = FakeWs.all.length;
      t.reconnect();
      expect(FakeWs.all.length).toBe(n + 1);
      last().open(); last().hello();
      expect(states[states.length - 1]).toBe('open');
    });

    it('is a no-op when there is no session', () => {
      expect(() => t.reconnect()).not.toThrow();
      expect(FakeWs.all.length).toBe(0);
    });
  });

  describe('automatic retry every connection.retryMs (no manual click needed)', () => {
    it('retries on a steady 5 s beat, without slowing down (no growing backoff)', () => {
      t.connect('g1', 'tok', m => msgs.push(m), s => states.push(s));
      last().drop(1006);                           // refused / dropped straight away, again and again
      for (let i = 0; i < 12; i++) {
        const n = FakeWs.all.length;
        while (FakeWs.all.length === n) vi.advanceTimersByTime(50); // wait for the next attempt
        last().drop(1006);                         // ...and have it fail at once
      }
      const times = FakeWs.all.map(w => w.createdAt);
      const gaps = times.slice(1).map((x, k) => x - times[k]);
      expect(gaps.length).toBeGreaterThanOrEqual(10);
      for (const g of gaps) { expect(g).toBeGreaterThanOrEqual(4_900); expect(g).toBeLessThanOrEqual(5_600); }
    });

    it('never gives up on a transient outage, however long it lasts (10 minutes)', () => {
      t.connect('g1', 'tok', m => msgs.push(m), s => states.push(s));
      vi.advanceTimersByTime(600_000);
      expect(states).not.toContain('down');
      expect(msgs.some(m => m.type === 'error')).toBe(false);
      expect(FakeWs.all.length).toBeGreaterThan(30);
      last().open(); last().hello();               // the network finally comes back
      expect(states[states.length - 1]).toBe('open');
    });

    it('does give up for good when the server says the game is gone (REST probe: NOT_FOUND)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ error: 'NOT_FOUND', message: 'gone' }) })));
      t.connect('g1', 'tok', m => msgs.push(m), s => states.push(s));
      last().drop(1006); vi.advanceTimersByTime(6_000);
      last().drop(1006); vi.advanceTimersByTime(6_000);   // 2 failures: the probe runs next time
      last().drop(1006); vi.advanceTimersByTime(6_000);
      await vi.advanceTimersByTimeAsync(10);
      expect(states).toContain('down');
      expect(msgs.some(m => m.type === 'error')).toBe(true);
    });

    it('makes no attempts while the page is hidden, and reconnects at once when it is shown', () => {
      connected();
      setHidden(true);
      last().drop(1006);
      const n = FakeWs.all.length;
      vi.advanceTimersByTime(60_000);
      expect(FakeWs.all.length).toBe(n);           // nothing while hidden (the browser freezes it anyway)
      setHidden(false);
      expect(FakeWs.all.length).toBe(n + 1);       // immediately on return
    });
  });
});
