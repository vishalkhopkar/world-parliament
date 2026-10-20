# agent-2p: no negotiation in 2-player games
- shared/src/protocol.ts: ErrorCode += 'NEGOTIATION_DISABLED'; server/src/core/types.ts HTTP_STATUS 409.
- server gameService: requireNegotiationAllowed (members incl. eliminated >= 3) in chat/proposeGovernment/respondOffer/withdrawOffer (after phase checks).
- tests: server/test/negotiation2p.test.ts. web: Negotiation.tsx notice, mock.ts guard. e2e/bots.ts 2p branch.
