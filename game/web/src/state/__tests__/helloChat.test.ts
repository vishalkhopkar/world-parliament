import { beforeEach, describe, expect, it } from 'vitest';
import type { GameSnapshot, ServerMessage } from '@hp/shared';
import { useStore } from '../store';

const snapshot = {} as GameSnapshot;
const priv = { you: 'a', budget: 0, myActions: [], myReports: [] };
const m = (id: string, ts: number) => ({ id, from: 'b', to: ['a'], text: id, ts });
const hello = (chat?: ReturnType<typeof m>[]): ServerMessage => ({ type: 'hello', serverTime: 1, snapshot, private: priv, ...(chat ? { chat } : {}) });

beforeEach(() => useStore.getState().reset());

describe('chat history in hello (a reconnect keeps the conversation)', () => {
  it('a hello with history replaces the chat log', () => {
    useStore.getState().applyServer({ type: 'chat', message: m('old', 1) });
    useStore.getState().applyServer(hello([m('x', 5), m('y', 6)]));
    expect(useStore.getState().chat.map(c => c.id)).toEqual(['x', 'y']);
  });

  it('messages that arrive live afterwards are appended once', () => {
    useStore.getState().applyServer(hello([m('x', 5)]));
    useStore.getState().applyServer({ type: 'chat', message: m('z', 7) });
    useStore.getState().applyServer({ type: 'chat', message: m('z', 7) });
    expect(useStore.getState().chat.map(c => c.id)).toEqual(['x', 'z']);
  });

  it('a hello without a chat field (older server) keeps what the client already has', () => {
    useStore.getState().applyServer({ type: 'chat', message: m('keep', 1) });
    useStore.getState().applyServer(hello());
    expect(useStore.getState().chat.map(c => c.id)).toEqual(['keep']);
  });
});
