import { describe, expect, it } from 'vitest';
import { newId } from '../src/core/util';

describe('newId', () => {
  it('is unique and sorts in creation order, even within one millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => newId(4));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
