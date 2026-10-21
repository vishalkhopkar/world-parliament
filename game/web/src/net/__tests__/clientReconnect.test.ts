import { describe, expect, it, vi } from 'vitest';
import { setTransport } from '../client';
import type { Transport } from '../transport';

describe('client.reconnect (the "Reconnect now" button)', () => {
  it('asks the transport to reconnect immediately when running against a real server', async () => {
    vi.resetModules();
    window.history.pushState({}, '', '/?server=https://api.test'); // selects the real (remote) transport
    const { reconnect, setTransport: set } = await import('../client');
    const t = { reconnect: vi.fn() } as unknown as Transport;
    set(t);
    reconnect();
    expect(t.reconnect).toHaveBeenCalledTimes(1);
    window.history.pushState({}, '', '/');
  });

  it('does nothing in the offline mock (nothing to reconnect to)', async () => {
    vi.resetModules();
    const { reconnect, setTransport: set } = await import('../client');
    const t = { reconnect: vi.fn() } as unknown as Transport;
    set(t);
    reconnect();
    expect(t.reconnect).not.toHaveBeenCalled();
  });
});
void setTransport;
