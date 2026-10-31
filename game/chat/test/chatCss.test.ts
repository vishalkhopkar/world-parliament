import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../common/ui/chat.css'), 'utf8');
const start = css.indexOf('@container');
const narrow = css.slice(start);

// jsdom has no layout: the real phone check is in e2e/browser.ts. This guards the rules that check depends on.
describe('one-to-one chats on a narrow screen', () => {
  it('has a narrow layout', () => expect(start).toBeGreaterThan(-1));
  it('does not restyle the container from its own container query (a query only reaches descendants)', () => {
    expect(narrow).not.toMatch(/\.hpchat-direct\s*\{/);
  });
  it('keeps the names in a vertical list with a fixed width, so the conversation stays beside it', () => {
    const list = /\.hpchat-list\s*\{([^}]*)\}/.exec(narrow)?.[1] ?? '';
    expect(list).toMatch(/width:\d+px/);
    expect(list).not.toMatch(/display:flex|overflow-x/);
  });
});
