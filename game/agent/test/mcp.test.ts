// MCP protocol test: the real stdio server, started exactly as the repo's .mcp.json starts it, driven by the SDK client.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { DevServer } from '../../server/src/local/devServer';
import { ACTIONS } from '../src/actions';
import { Human, startServer, until } from './helpers';

const REPO = resolve(__dirname, '..', '..', '..');
let srv: DevServer;
let base: string;
let tmp: string;

beforeAll(async () => {
  ({ srv, base } = await startServer());
  tmp = mkdtempSync(join(tmpdir(), 'hp-mcp-'));
});
afterAll(async () => { await srv.close(); rmSync(tmp, { recursive: true, force: true }); });

/** Spawn the MCP server from the repo's own .mcp.json entry (command/args), pointing it at the test server. */
async function connect(sessionFile?: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const cfg = JSON.parse(readFileSync(join(REPO, '.mcp.json'), 'utf8')).mcpServers['hung-parliament'] as { command: string; args: string[]; env?: Record<string, string> };
  const transport = new StdioClientTransport({
    command: cfg.command, args: cfg.args, cwd: REPO, stderr: 'pipe',
    env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}), HP_SERVER: base, ...(sessionFile ? { HP_SESSION_FILE: sessionFile } : {}) },
  });
  const client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

const text = (r: any): string => (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

describe('MCP server over stdio', () => {
  it('lists every action as a tool, the rules resource and the play prompt', async () => {
    const { client, close } = await connect();
    try {
      expect(client.getServerCapabilities()?.tools).toBeTruthy();
      expect(client.getInstructions()).toMatch(/get_rules/);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(ACTIONS.map((a) => a.name).sort());
      const camp = tools.find((t) => t.name === 'campaign_batch')!;
      expect(camp.description).toMatch(/50/);
      expect((camp.inputSchema as any).properties.actions.maxItems).toBe(50);
      expect(tools.find((t) => t.name === 'get_state')!.annotations?.readOnlyHint).toBe(true);
      expect(tools.some((t) => /create/i.test(t.name))).toBe(false);

      const res = await client.listResources();
      expect(res.resources.map((r) => r.uri)).toContain('hung-parliament://rules');
      const rules = await client.readResource({ uri: 'hung-parliament://rules' });
      expect((rules.contents[0] as any).text).toContain('W₹25 crore');

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((p) => p.name)).toContain('play-hung-parliament');
      const p = await client.getPrompt({ name: 'play-hung-parliament', arguments: { join_code: 'ABC123', nickname: 'Claude' } });
      const ptxt = (p.messages[0].content as any).text as string;
      expect(ptxt).toContain('get_rules');
      expect(ptxt).toContain('ABC123');
      expect(ptxt).toMatch(/NEVER create/);
    } finally { await close(); }
  });

  it('get_rules and error handling (isError + text with hint)', async () => {
    const { client, close } = await connect();
    try {
      const rules = await client.callTool({ name: 'get_rules', arguments: {} });
      expect(rules.isError).toBeFalsy();
      expect(text(rules)).toContain('HUNG PARLIAMENT');
      expect(text(rules)).toContain('251 seats');
      expect(text(rules)).not.toMatch(/\{\{/);

      const bad = await client.callTool({ name: 'campaign', arguments: { type: 'rally', seat: 3 } });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toMatch(/^ERROR NOT_JOINED: /);
      expect(text(bad)).toContain('Hint:');

      const bad2 = await client.callTool({ name: 'join_game', arguments: { join_code: 'ZZZZZZ', nickname: 'Bot' } });
      expect(bad2.isError).toBe(true);
      expect(text(bad2)).toMatch(/ERROR NOT_FOUND/);

      const state = await client.callTool({ name: 'get_state', arguments: {} });
      expect(JSON.parse(text(state)).joined).toBe(false);
    } finally { await close(); }
  });

  it('join_game over MCP shows up in the host lobby as an agent; a restarted server rejoins from HP_SESSION_FILE', async () => {
    const human = await new Human(base).create('Asha', 1);
    const sessionFile = join(tmp, 'session.json');
    const first = await connect(sessionFile);
    try {
      const j = await first.client.callTool({ name: 'join_game', arguments: { join_code: human.joinCode, nickname: 'ClaudeMCP' } });
      expect(j.isError).toBeFalsy();
      expect(JSON.parse(text(j)).status).toBe('pending');
      await until(async () => (await human.pending()).length === 1, 5000, 'pending agent');
      expect((await human.pending())[0]).toMatchObject({ nickname: 'ClaudeMCP', kind: 'agent', status: 'pending' });
      expect(existsSync(sessionFile)).toBe(true);
      // host admits
      await human.admit((await human.pending())[0].playerId);
      const w = await first.client.callTool({ name: 'wait_for_admission', arguments: { timeout_s: 10 } });
      expect(JSON.parse(text(w)).status).toBe('admitted');
    } finally { await first.close(); }

    // a new MCP server process with the same session file is the same player again
    const second = await connect(sessionFile);
    try {
      const st = JSON.parse(text(await second.client.callTool({ name: 'get_state', arguments: {} })));
      expect(st.joined).toBe(true);
      expect(st.you.nickname).toBe('ClaudeMCP');
      expect(st.admission).toBe('admitted');
      const lobby = JSON.parse(text(await second.client.callTool({ name: 'get_lobby', arguments: {} })));
      expect(lobby.players.filter((p: any) => p.kind === 'agent')).toHaveLength(1);
      const left = JSON.parse(text(await second.client.callTool({ name: 'leave_game', arguments: {} })));
      expect(left.left).toBe(true);
      expect(existsSync(sessionFile)).toBe(false);
    } finally { await second.close(); }
  });
});
