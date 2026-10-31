import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PhasesSelect, clampPhases } from '../PhasesSelect';

const range = { min: 2, max: 4, default: 3 } as never;

describe('PhasesSelect', () => {
  it('lists min..max with "N phases" labels', () => {
    render(<PhasesSelect range={range} value={3} onChange={() => undefined} />);
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['2 phases', '3 phases', '4 phases']);
    expect(screen.getByRole('combobox')).toHaveValue('3');
  });
  it('uses the singular for 1 phase', () => {
    render(<PhasesSelect range={{ min: 1, max: 2, default: 1 } as never} value={1} onChange={() => undefined} />);
    expect(screen.getByRole('option', { name: '1 phase' })).toBeInTheDocument();
  });
  it('clamps a stale value into the range', () => {
    expect(clampPhases(9, range)).toBe(4);
    expect(clampPhases(0, range)).toBe(2);
    render(<PhasesSelect range={range} value={9} onChange={() => undefined} />);
    expect(screen.getByRole('combobox')).toHaveValue('4');
  });
  it('reports the chosen number and can be disabled', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PhasesSelect range={range} value={3} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith(2);
    rerender(<PhasesSelect range={range} value={3} onChange={onChange} disabled />);
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
