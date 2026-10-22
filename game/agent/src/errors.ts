// Errors that always carry a machine code, a human message and a hint on what to do next (returned to the LLM as text).
import type { ErrorCode } from '@hp/shared';

export type AgentErrorCode = ErrorCode | 'NOT_JOINED' | 'ALREADY_JOINED' | 'UNKNOWN_PLAYER' | 'UNKNOWN_SEAT' | 'UNKNOWN_OPTION'
  | 'INVALID_INPUT' | 'NO_CONNECTION' | 'TIMEOUT' | 'NO_CONFIRMATION' | 'NO_MAP' | 'NOT_ADMITTED' | 'UNKNOWN_ACTION' | 'DAEMON';

const HINTS: Partial<Record<AgentErrorCode, string>> = {
  BAD_REQUEST: 'Check the input values (use get_lobby / list_party_options / list_seats to see valid values).',
  UNAUTHORIZED: 'Your session token is not valid for this game (the game may have been restarted). Call leave_game, then join_game again with a fresh join code.',
  FORBIDDEN: 'You are not allowed to do that right now (not admitted yet, eliminated, or a host-only action). AI players can never host or start games.',
  NOT_FOUND: 'Nothing found. Check the join code or ids.',
  GAME_FULL: 'The game is full. Ask the host to free a slot or start a new game.',
  ADMISSION_CLOSED: 'The host is not admitting players (or the game has started). Ask the host to re-open admission in the lobby.',
  NAME_TAKEN: 'Another party already uses that name; pick a different party name.',
  COLOUR_TAKEN: 'Another party already has that colour; call list_party_options and pick a colour that is not taken.',
  SYMBOL_TAKEN: 'Another party already has that symbol; call list_party_options and pick a free symbol.',
  AVATAR_TAKEN: 'Another party already has that avatar; call list_party_options and pick an avatar that is not taken.',
  WRONG_PHASE: 'That action is not available in the current game phase. Call get_state to see the phase and the timers.',
  INSUFFICIENT_FUNDS: 'Not enough budget. Call get_state to see your budget and the current prices. Cheaper options: roadshow instead of rally; skip reports.',
  SEAT_POLLED: 'Voting in that seat has already closed. Use list_seats with open_only=true to find seats you can still campaign in.',
  TOO_LATE: 'The campaign (or that phase) is over.',
  RATE_LIMITED: 'Slow down a little and retry.',
  INVALID_GOVERNMENT: 'The coalition proposal is invalid: the PM must be you, portfolio limits apply (DPM max 2, others 1), only active players, and at least one party must stay out of the government (a government can never include every party). Members must together hold a majority of WON seats; it is confirmed only once every seat is declared (end of counting).',
  OFFER_NOT_FOUND: 'No such open offer. Call list_offers for current offer ids and their status.',
  ALREADY_COMMITTED: 'A government has already been formed; negotiation is over.',
  NOT_ENOUGH_PLAYERS: 'The game needs more players before it can start (that is the host\'s job).',
  NEGOTIATION_DISABLED: 'With only 2 players there is no chat or coalition-building: a majority wins, an exact tie is a draw.',
  INTERNAL: 'Server error. Wait a second and try again; if it persists, call get_state to check the connection.',
  NOT_JOINED: 'You have not joined a game yet. Call join_game with the join code the human host gave you.',
  ALREADY_JOINED: 'You are already in a game. Call leave_game first if you really want to join another one (you will lose your current party).',
  UNKNOWN_PLAYER: 'Use a party name or player id exactly as listed by get_lobby / get_state.',
  UNKNOWN_SEAT: 'Use a seat id (1..N) or a seat name as listed by list_seats (query=... searches by name).',
  UNKNOWN_OPTION: 'Call list_party_options to see valid colours, symbols and avatars.',
  INVALID_INPUT: 'Fix the input and try again. `node game/agent/bin/cli.mjs actions` / the tool schema lists the expected fields.',
  NO_CONNECTION: 'The live connection to the game server is down (it reconnects automatically for up to 90 s). Retry in a few seconds.',
  TIMEOUT: 'The server did not answer in time. Call get_state to see whether the action took effect before retrying.',
  NO_CONFIRMATION: 'The server accepted the message but sent no confirmation. Call get_state / list_offers to check.',
  NO_MAP: 'The map package for this game could not be loaded, so seat names are unavailable. Use numeric seat ids. (Set HP_GAME_PACKAGE to the game.json path.)',
  NOT_ADMITTED: 'The host has not admitted you yet. Call wait_for_admission.',
  UNKNOWN_ACTION: 'Run the "actions" command (CLI) or list the MCP tools to see valid action names.',
  DAEMON: 'The background daemon is not running. Start it with: node game/agent/bin/cli.mjs start --name <name>',
};

export class AgentError extends Error {
  constructor(public code: AgentErrorCode, message: string, public hint?: string) {
    super(message);
    this.name = 'AgentError';
    if (hint === undefined) this.hint = HINTS[code];
  }
}

export interface ErrorInfo { code: string; message: string; hint?: string }

export function toErrorInfo(e: unknown): ErrorInfo {
  if (e instanceof AgentError) return { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) };
  const msg = e instanceof Error ? e.message : String(e);
  return { code: 'INTERNAL', message: msg, hint: 'Unexpected error inside the agent tool. Call get_state; if it keeps failing, leave_game and rejoin.' };
}

export const formatError = (i: ErrorInfo): string => `ERROR ${i.code}: ${i.message}${i.hint ? `\nHint: ${i.hint}` : ''}`;
