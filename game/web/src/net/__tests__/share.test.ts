import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildJoinLink, copyText, joinCodeFromSearch } from '../share';

const setClipboard = (v: unknown) => Object.defineProperty(navigator, 'clipboard', { value: v, configurable: true });

afterEach(() => {
  setClipboard(undefined);
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the async clipboard API when it works', async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard({ writeText });
    expect(await copyText('HP7K2Q')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('HP7K2Q');
  });

  it('falls back to execCommand when the clipboard API is missing (insecure http context on a phone)', async () => {
    setClipboard(undefined);
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    expect(await copyText('HP7K2Q')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull(); // helper element is cleaned up
  });

  it('falls back to execCommand when the clipboard API rejects (iOS Safari)', async () => {
    setClipboard({ writeText: vi.fn(async () => { throw new Error('NotAllowedError'); }) });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    expect(await copyText('HP7K2Q')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('returns false when nothing can copy', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => false);
    expect(await copyText('HP7K2Q')).toBe(false);
  });

  it('returns false for empty text without touching the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard({ writeText });
    expect(await copyText('')).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('buildJoinLink', () => {
  const loc = (href: string) => new URL(href) as unknown as Location;

  it('builds origin + path + join code', () => {
    expect(buildJoinLink('hp7k2q', loc('https://hung.example.com/'))).toBe('https://hung.example.com/?join=HP7K2Q');
    expect(buildJoinLink('HP7K2Q', loc('https://x.test/play/'))).toBe('https://x.test/play/?join=HP7K2Q');
  });

  it('keeps server and mock so a dev link reaches the same backend, but drops as and any old join', () => {
    const l = buildJoinLink('HP7K2Q', loc('http://192.168.1.5:5173/?server=local&as=p2&join=OLD111#x'));
    const u = new URL(l);
    expect(u.searchParams.get('join')).toBe('HP7K2Q');
    expect(u.searchParams.get('server')).toBe('local');
    expect(u.searchParams.has('as')).toBe(false);
    expect(u.hash).toBe('');
    expect(buildJoinLink('HP7K2Q', loc('http://localhost:5173/?mock'))).toContain('mock');
  });
});

describe('joinCodeFromSearch', () => {
  it('reads and upper-cases a valid code', () => {
    expect(joinCodeFromSearch('?join=hp7k2q')).toBe('HP7K2Q');
    expect(joinCodeFromSearch('?server=local&join= ab3k ')).toBe('AB3K');
  });
  it('rejects junk, too short, too long and missing', () => {
    expect(joinCodeFromSearch('')).toBe('');
    expect(joinCodeFromSearch('?join=abc')).toBe('');
    expect(joinCodeFromSearch('?join=ABCDEFGHJ')).toBe('');
    expect(joinCodeFromSearch('?join=<script>')).toBe('');
    expect(joinCodeFromSearch('?join=AB%20CD')).toBe('');
  });
});
