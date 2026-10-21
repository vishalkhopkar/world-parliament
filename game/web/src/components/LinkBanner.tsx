import type { LinkState } from '../net/transport';

/** Banner shown while the live connection is not open. The browser retries by itself every `retryMs`; the button forces it now. */
export function LinkBanner({ link, retryMs, onReconnect }: { link: LinkState; retryMs: number; onReconnect: () => void }) {
  if (link === 'open') return null;
  const secs = Math.round(retryMs / 1000);
  return (
    <div className="link-banner" role="status">
      <span>{link === 'down' ? 'Disconnected from the server.' : `Reconnecting to the server… (retrying every ${secs} s)`}</span>
      <button className="btn sm link-retry" onClick={onReconnect}>Reconnect now</button>
    </div>
  );
}
