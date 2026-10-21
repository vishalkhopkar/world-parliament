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
    t = new RemoteTransport({ apiUrl: 'https://api.test', wsUrl: 'wss://ws.test/live' });
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
    vi.advanceTimersByTime(1_000);
    last().open(); last().hello();
    expect(last().sent.some(s => s.includes('"roadshow"'))).toBe(true);
  });
});
