import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResultPanel } from '../ResultPanel';

const party = { name: 'Lotus Front', colour: '#FFFFFF', symbol: 'sun' };
const card = (kind: 'LEADS' | 'WON' | 'TRAILS' | 'LOST') =>
  render(<ResultPanel kind={kind} candidate="Asha Rao" party={party} constituency="Konkan" />);

describe('ResultPanel', () => {
  it.each(['LEADS', 'WON', 'TRAILS', 'LOST'] as const)('shows the %s header with its class', kind => {
    const { container } = card(kind);
    expect(container.querySelector('.rp-head')).toHaveTextContent(kind);
    expect(container.querySelector('article')).toHaveClass(`rp-${kind.toLowerCase()}`);
  });

  it('shows the uppercase candidate, party with symbol on the party colour, and the constituency', () => {
    const { container } = card('WON');
    expect(screen.getByText('ASHA RAO')).toBeInTheDocument();
    expect(screen.getByText('Konkan')).toBeInTheDocument();
    const p = container.querySelector('.rp-party') as HTMLElement;
    expect(p).toHaveTextContent('Lotus Front');
    expect(p.querySelector('svg')).not.toBeNull();
    expect(p.style.background).toMatch(/255, 255, 255|#fff/i);
    expect(p.style.color).toMatch(/0, 0, 0|#000/i); // black on a white party
    expect(container.querySelector('svg.rp-photo')).not.toBeNull();
  });

  it('uses white text on a dark party colour; a very long name stays in one text box', () => {
    const { container } = render(<ResultPanel kind="LEADS" candidate="Jamaluddin Mohammed Hussain" party={{ ...party, colour: '#1F5FBF' }} constituency="X" />);
    expect((container.querySelector('.rp-party') as HTMLElement).style.color).toMatch(/255, 255, 255|#fff/i);
    expect(screen.getByText('JAMALUDDIN MOHAMMED HUSSAIN')).toHaveClass('rp-text');
  });
});
