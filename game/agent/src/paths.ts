// Paths shared by cli.ts and daemon.ts (node builtins only, so the CLI starts fast).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AGENT_DIR = resolve(HERE, '..');
export const SESSIONS_DIR = join(AGENT_DIR, '.sessions');
export const DAEMON_ENTRY = join(HERE, 'daemon.ts');

export const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const stateFile = (name: string, dir = SESSIONS_DIR): string => join(dir, `${name}.json`);
export const logFile = (name: string, dir = SESSIONS_DIR): string => join(dir, `${name}.log`);
export const sessionFile = (name: string, dir = SESSIONS_DIR): string => join(dir, `${name}.session.json`);

export interface DaemonInfo { name: string; pid: number; port: number; secret: string; server: string; startedAt: number }
