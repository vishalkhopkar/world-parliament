import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LinkBanner } from '../LinkBanner';

describe('LinkBanner', () => {
  it('renders nothing while the link is open', () => {
    const { container } = render(<LinkBanner link="open" retryMs={5000} onReconnect={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says it retries by itself, with the configured interval, and offers Reconnect now', () => {
    const onReconnect = vi.fn();
    render(<LinkBanner link="connecting" retryMs={5000} onReconnect={onReconnect} />);
    expect(screen.getByText(/Reconnecting to the server/)).toBeInTheDocument();
    expect(screen.getByText(/retrying every 5 s/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('follows the config value (2 s)', () => {
    render(<LinkBanner link="connecting" retryMs={2000} onReconnect={() => undefined} />);
    expect(screen.getByText(/retrying every 2 s/)).toBeInTheDocument();
  });

  it('when the transport gave up for good (declined / game gone) it says disconnected and does not promise retries', () => {
    render(<LinkBanner link="down" retryMs={5000} onReconnect={() => undefined} />);
    expect(screen.getByText(/Disconnected from the server/)).toBeInTheDocument();
    expect(screen.queryByText(/retrying every/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Reconnect now' })).toBeInTheDocument();
  });
});
