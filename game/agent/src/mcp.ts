// stdio MCP server: ONE process = ONE AI player session in ONE game. Every action of actions.ts is a tool.
// Config (env): HP_SERVER (default http://localhost:8787), HP_WS (default derived), HP_SESSION_FILE (persist the session so a restart rejoins).
// stdout is the MCP protocol channel: all diagnostics go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ACTIONS, executeAction, formatResultText } from './actions';
import { configForMap, renderRules } from './rules';
import { AgentSession } from './session';

export const SERVER_INSTRUCTIONS = [
  'HUNG PARLIAMENT: an online mock-election game. You play as one political party, exactly like a human player.',
  'You can only JOIN games a human created; you can never create or start a game.',
  'Start: call get_rules (full rulebook + strategy), then join_game with the join code the human gives you, then wait_for_admission,',
  'list_party_options + set_party, then wait for the host to start. During play call get_state, list_seats, campaign_batch, and loop on wait_for_events.',
  'Be fast: the campaign lasts only a few minutes and spending is irreversible. Errors come back as text with a Hint: read it.',
].join(' ');

export const PLAY_PROMPT = (joinCode?: string, nickname?: string): string => [
  'You are an AI player in HUNG PARLIAMENT (an online multiplayer mock-election game) using the hung-parliament MCP tools. Play to win.',
  '',
  '1. Call get_rules and read it carefully (setting, prices, effects, polling phases, counting, coalition negotiation, points, strategy).',
  `2. Call join_game${joinCode ? ` with join_code "${joinCode}"` : ' with the join code the human host gives you (ask if you do not have one)'}${nickname ? ` and nickname "${nickname}" (shown only to the host until you set a party)` : ' and a short nickname (shown only to the host until you set a party)'}. You can NEVER create or start a game; only a human host can.`,
  '3. Call wait_for_admission (repeat if it returns pending). Then list_party_options and set_party with a unique name, colour, symbol and avatar.',
  '4. Wait for the host to start (wait_for_events with types ["status"], or get_state). When the campaign starts, be FAST:',
  '   - get_state (budget, timers), list_seats {open_only:true}, get_news; plan a mix of rallies (clustered) and roadshows (many quiet seats);',
  '   - place everything with campaign_batch (up to 50 actions per call); spend the whole budget; act before each polling phase closes.',
  '5. During counting (3+ players): watch the tally via get_state, chat with the other parties, propose_government (you are PM) or respond_offer. No government by the deadline = everybody loses.',
  '6. When status is "finished", tell the human the result.',
  'Loop efficiently with wait_for_events {timeout_s: 30} instead of polling. Never call leave_game unless you want to quit (you would be eliminated).',
].join('\n');

export function createMcpServer(session: AgentSession): McpServer {
  const server = new McpServer({ name: 'hung-parliament', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });

  for (const a of ACTIONS) {
    server.registerTool(
      a.name,
      {
        description: a.description,
        inputSchema: a.schema.shape,
        annotations: { readOnlyHint: !!a.readOnly, destructiveHint: a.name === 'leave_game', openWorldHint: false },
      },
      async (args: unknown) => {
        const r = await executeAction(session, a.name, args);
        return { content: [{ type: 'text' as const, text: formatResultText(r) }], ...(r.ok ? {} : { isError: true }) };
      },
    );
  }

  server.registerResource(
    'rules',
    'hung-parliament://rules',
    { title: 'HUNG PARLIAMENT rulebook', description: 'Complete rules and strategy guide with live numbers', mimeType: 'text/markdown' },
    async (uri) => {
      const cfg = configForMap(session.mapId());
      const text = renderRules(cfg, { timeline: session.client.state.snapshot?.timeline ?? null });
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  server.registerPrompt(
    'play-hung-parliament',
    {
      title: 'Play HUNG PARLIAMENT',
      description: 'Instructions for joining and playing a HUNG PARLIAMENT game as an AI player',
      argsSchema: { join_code: z.string().optional(), nickname: z.string().optional() },
    },
    (args: { join_code?: string; nickname?: string }) => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: PLAY_PROMPT(args.join_code, args.nickname) } }],
    }),
  );

  return server;
}

export function sessionFromEnv(env: NodeJS.ProcessEnv = process.env): AgentSession {
  return new AgentSession({
    server: env.HP_SERVER || 'http://localhost:8787',
    ws: env.HP_WS || undefined,
    sessionFile: env.HP_SESSION_FILE || undefined,
    log: (m) => console.error('[hung-parliament] ' + m),
  });
}

export async function main(): Promise<void> {
  const session = sessionFromEnv();
  await session.restore();
  const server = createMcpServer(session);
  await server.connect(new StdioServerTransport());
  console.error('[hung-parliament] MCP server ready (server ' + session.client.server + ')');
  const shutdown = () => { session.client.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[hung-parliament] fatal:', e); process.exit(1); });
}
