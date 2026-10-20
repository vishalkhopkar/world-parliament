#!/usr/bin/env node
// Shell fallback CLI for the HUNG PARLIAMENT agent actions, runnable from ANY working directory:
//   node game/agent/bin/cli.mjs start --name Claude1
//   node game/agent/bin/cli.mjs get_rules --name Claude1
import { register } from 'tsx/esm/api';

register();
const { run } = await import('../src/cli.ts');
await run();
