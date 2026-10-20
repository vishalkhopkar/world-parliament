# Agent C notes (infra)
- game/infra CDK app done: Data, Web, Api (lambdas + HTTP + WS + state machine + scheduler + alarms + budget) stacks; optional GithubOidcStack (-c oidc=true).
- Api stack is a single stack incl. orchestration: cross-stack refs would be circular. Cycles inside avoided via fixed names (functions, state machine, scheduler role) and ARNs computed from names.
- Placeholder handlers created in game/server/src/handlers (all 8); server/tsconfig.json created.
- `npx cdk synth` dev+prod OK, `tsc -p` OK. Workflow: .github/workflows/game-deploy.yml.

## CSS extraction pass (styling agent)
Moved all component-embedded styling to CSS files: App.css, components/{ui,Toast,campaign,Negotiation}.css, screens/{game,Home,PartySetup,Counting,Result}.css, map/SeatMap.css; styles.css keeps only theme/generic rules. Remaining style= uses are CSS custom properties only (--party-colour, --dot-size, --swatch-colour, --seg-width, --majority-left, --nt-duration). SeatMap.tsx keeps d3 per-seat fills and display toggling. Disabled .swatch now has background-image:none to match the previous (inline-masked) look.
