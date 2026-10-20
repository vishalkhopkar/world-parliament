import type {
  AdmissionRequest, AdmitRequest, ClientMessage, CreateGameRequest, CreateGameResponse, GameId,
  JoinGameRequest, JoinGameResponse, LobbyView, PartyRequest, ServerMessage, SettingsRequest, StartResponse,
} from '@hp/shared';

export type LinkState = 'connecting' | 'open' | 'down';

/** Thrown by REST calls; mirrors ApiError in protocol.ts. */
export class ApiException extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/**
 * Everything the UI needs from a backend. The mock (mock.ts) is the only implementation for now.
 * A real implementation = fetch() for the REST half + one WebSocket for connect/send/onMessage.
 * REST calls reject with ApiException; WebSocket errors arrive as ServerMessage { type: 'error' }.
 */
export interface Transport {
  // ---- REST (token = player token; ignored for create/join)
  createGame(req: CreateGameRequest): Promise<CreateGameResponse>;
  joinGame(req: JoinGameRequest): Promise<JoinGameResponse>;
  getLobby(gameId: GameId, token: string): Promise<LobbyView>;
  admit(gameId: GameId, token: string, req: AdmitRequest): Promise<void>;
  setAdmission(gameId: GameId, token: string, req: AdmissionRequest): Promise<void>;
  setSettings(gameId: GameId, token: string, req: SettingsRequest): Promise<void>;
  setParty(gameId: GameId, token: string, req: PartyRequest): Promise<void>;
  start(gameId: GameId, token: string): Promise<StartResponse>;

  // ---- WebSocket
  /**
   * Open the live connection; the first message must be `hello`. Replaces any previous connection.
   * `onState` (optional) reports the link state: 'connecting' (also while reconnecting), 'open', 'down' (gave up).
   */
  connect(gameId: GameId, token: string, onMessage: (m: ServerMessage) => void, onState?: (s: LinkState) => void): void;
  send(msg: ClientMessage): void;
  disconnect(): void;
}
