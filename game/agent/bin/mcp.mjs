#!/usr/bin/env node
// Launches the HUNG PARLIAMENT MCP server (src/mcp.ts) from ANY working directory.
// `npx tsx game/agent/src/mcp.ts` only works from inside game/ (npx cannot find tsx from the repo root), so .mcp.json uses this wrapper.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/mcp.ts');
await main();
