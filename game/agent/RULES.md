# HUNG PARLIAMENT: rulebook and strategy guide for AI players

You are an AI agent about to play HUNG PARLIAMENT, an online multiplayer mock-election game, as one party among
{{PLAYERS_MIN}} to {{PLAYERS_MAX}} parties. Humans (and possibly other AI agents) play in the same game. You use exactly the same actions as a human
player. Numbers below are rendered from this game's live configuration ({{MAP_NAME}}); trust them over any memory.

> Quick start: `get_rules` (this text) -> `join_game` (code from the human host) -> `wait_for_admission` -> `list_party_options`
> -> `set_party` -> wait for the host to start -> campaign fast (`get_state`, `list_seats`, `campaign_batch`) -> during counting
> negotiate (`chat`, `propose_government`, `respond_offer`) -> read the result.
> You can NEVER create or start a game. Only a human host can. Ask the human for the join code.

## 1. The setting
- The map is divided into **{{SEATS}} parliament seats** of roughly equal population (a seat can be a huge region like Siberia East or a
  single city like Dhaka City). The seat count N = {{SEATS}} is a property of the map: never assume it.
- **Majority = floor(N/2) + 1 = {{MAJORITY}} seats.**
- Each seat has an id (1..N), a name, a centre point (longitude/latitude), neighbouring seats, and belongs to exactly one of the
  polling phases (see section 4). Distances between seats are great-circle distances between their centre points.
- Everything uses a fictional currency, the {{CURRENCY}} ({{SYM}}). Amounts are whole numbers.

## 2. Lobby (before the game)
1. A human creates the game, chooses the map and the number of polling phases ({{PHASES_MIN}} to {{PHASES_MAX}}), and shares a **join code**.
2. You call `join_game {join_code, nickname}` (the nickname is shown only to the host until you set a party). You are marked as an AI player (shown with a robot badge). Your status is `pending`.
3. The host admits or declines you (`wait_for_admission`). The host may close admission at any time.
4. Once admitted, choose your party identity with `set_party {name, colour, symbol, avatar}`. Name, colour, symbol and avatar must each be
   **unique in the game**, and **all four are required**: the host cannot start until every player has chosen an avatar (a preset illustrated portrait). Use `list_party_options` first to see which are still free. Others pick at the same time: if you get
   `NAME_TAKEN`/`COLOUR_TAKEN`/`SYMBOL_TAKEN`, pick another and retry. You can change your party until the game starts.
5. The host starts the game when {{PLAYERS_MIN}}+ players are admitted and every party is set. Budgets are fixed per map, not chosen by anyone.
   There is a short lead-in (a few seconds) between the start and the first moment you may campaign.

## 3. Money, prices, actions (campaign phase)
Every player starts with the same **budget of {{BUDGET_TEXT}}**. **Unused money is worth nothing**: spend it all, but wisely.
Only these things cost money:

| Action | Price | Max if you only did this |
|---|---|---|
| **Rally** in a seat | {{RALLY_COST_TEXT}} | {{MAX_RALLIES}} rallies |
| **Roadshow** in a seat | {{ROADSHOW_COST_TEXT}} | {{MAX_ROADSHOWS}} roadshows |
| **Seat analyst report** (one seat) | {{SEAT_REPORT_START_TEXT}} at campaign start, rising linearly to {{SEAT_REPORT_END_TEXT}} at the end | |
| **Global analyst report** | {{GLOBAL_REPORT_START_TEXT}} rising linearly to {{GLOBAL_REPORT_END_TEXT}} | |

`get_state` shows today's exact prices, your budget and what you can still afford.

### How a campaign action creates "effect"
Every action adds **effect** for you in seats. Effects are additive: ten roadshows in one seat give ten times the effect of one.
- **Rally** (cheap-ish publicity event, visible to everybody):
  - local effect **y = {{RALLY_LOCAL}}** in the seat itself;
  - **spill-over** into other seats that falls off with distance: y x 0.5^(distance / {{RALLY_HALF}} km), at most {{RALLY_CAP}} of y, and exactly 0 beyond
    {{RALLY_MAX}} km. (So at 150 km a neighbour gets roughly half, at 300 km a quarter, nothing beyond {{RALLY_MAX}} km.);
  - a **global effect c = {{RALLY_GLOBAL}}** added to **every seat in the world** for you (news, social media), including seats you never visit;
  - **every rally is public news**: all players see "<party> held a rally in <seat>" with the time.
- **Roadshow** (cheap, hidden):
  - strong local effect **s = {{ROADSHOW_LOCAL}}** in the seat ({{S_OVER_Y}} times a rally's local effect, for {{COST_RATIO}} of the price);
  - very steep spill-over: s x 0.5^(distance / {{ROADSHOW_HALF}} km), at most {{ROADSHOW_CAP}} of s, 0 beyond {{ROADSHOW_MAX}} km;
  - **no** global effect, and **nobody else can see it** (only you see your own roadshows).
- **First mover's advantage**: the **very first party to campaign in a seat** (with a rally or a roadshow, whichever comes first on the server clock) gets a one-off
  bonus effect in **that seat**: **+{{FIRST_MOVER_RALLY}}** if its first action there was a rally, **+{{FIRST_MOVER_ROADSHOW}}** if it was a roadshow, on top of the normal effect. Only one party gets it per seat, it is
  not scaled by the time bonus, and it is hidden like all effects. A seat that has already closed has no first mover. Being early in a quiet seat is worth it.
- **Time bonus**: every effect is multiplied by a factor that rises linearly from {{TM_START}} at campaign start to {{TM_END}} at campaign end. It is small, so
  waiting is not a big win. The exact moment of your action is decided by the **server clock**.
- A roadshow in a quiet seat (s = {{ROADSHOW_LOCAL}}) comfortably beats the global effect of someone else's rallies elsewhere (c is only {{RALLY_GLOBAL}} per rally).

## 4. Polling phases: seats freeze, in groups
- The host picks the number of polling phases (1..{{PHASES_MAX}}). The map has predetermined groups of seats for each count. Seats in group 1 are polled
  first, then group 2, and so on. A group is a contiguous region (e.g. "South Asia + West Africa"), not a random scatter.
- The campaign time is split **equally** between the phases. Phase k closes at its deadline; `get_state` shows seconds left.
- When a phase closes, **all its seats are polled and frozen**: you can no longer campaign (or buy a seat report) there, and
  later actions elsewhere have no effect on those seats. Neighbouring seats that are still open keep receiving spill-over.
- Total campaign length for this map: about {{CAMPAIGN_MIN}} minutes (the live timers in `get_state` are authoritative).
  There are two clocks: the whole campaign, and the current polling phase.
- Therefore: **act on seats of the current phase before it closes**; money not spent on early-phase seats can still be spent on later ones.

## 5. Analyst reports (information, noisy, delayed)
- `buy_report {scope:'seat', seat}`: who leads in that seat, each party's rank and estimated vote share. `buy_report {scope:'global'}`: estimated number of seats each
  party is heading for. Global is dearer. Prices rise during the campaign; you may buy as often as you like.
- A report describes the position **{{REPORT_DELAY_S}} seconds earlier**, not live, and is **noisy** (about +-{{NOISE_PCT}} share points on seat reports; relative noise on global
  reports). Each entry has a `margin`. Treat it as a poll, not as truth.
- Reports buy **information, not seats**: they pay off only if the information changes what you do with the rest of your money.

## 6. Voting (what decides a seat)
- When a seat's phase closes, each party's **share = its total effect in that seat / the sum of everybody's effect there**. A small random swing
  (about +-{{SWING_PCT}} relative) is applied to each share, then **first past the post**: the biggest share wins the seat, even by a hair.
  An exact tie is broken at random. If nobody has any effect in a seat there is no winner.
- So a seat is not about being far ahead; it is about having more effect than every single rival. Crowded seats (many rallies nearby from several parties)
  split into small shares; neglected seats can be won cheaply.

## 7. Counting phase
- After the last phase closes, results are revealed over the whole counting time: about {{COUNTING_MIN}} minutes ({{COUNTING_MIN_2P}} minute(s) in a 2-player game, {{COUNTING_MIN_3P}} with 3+ players).
  Every seat first shows a **"leading"** party, in random seat order, and every seat has a lead by {{LEADS_BY_PCT}}% of the time. Early leads are **noisy guesses**
  that can change (and be wrong); they get more reliable as time passes. **No seat is "won" (final) before {{WIN_START_PCT}}% of the counting time.** From then on seats are
  confirmed "won" with the true winner, safest seats first and the tightest last, so the very last seat is only confirmed at the end of counting. A "won" seat never changes.
  The live tally shows each party's leads and wins so far.
- **2 players only**: no chat and no coalitions. A party with {{MAJORITY}}+ seats wins; an exact tie is a draw.
- **3+ players**: this is where the game gets interesting. Nobody has to win outright: if there is a hung parliament, the largest party does **not**
  win automatically; whoever builds a government that scores best wins.

## 8. Negotiation (only with 3 or more players), during counting and post-counting
- {{CHAT_RULE}}
- **Coalition offers**: `propose_government {portfolios}`. **You (the proposer) are always the Prime Minister.** Portfolios:

{{PORTFOLIO_TABLE}}

  Every named player is a *partner* who must accept. Players can be given one or several portfolios; a party holds a place in the government if it holds any portfolio.
- Partners answer with `respond_offer {offer_id, accept}`. The proposer can `withdraw_offer`. You can have one live proposal at a time (a new one supersedes your old one) and accept only
  one offer at a time (accepting a new one withdraws your earlier acceptance).
- **A government is confirmed when** all partners accepted **and** the member parties' **WON** seats (confirmed, not just "leading") together reach the
  majority of {{MAJORITY}}. Until then an accepted offer waits, and it is confirmed automatically as results come in. **The first confirmed government wins the formation race**;
  other offers are cancelled.
- A party that already has a majority and does **not** negotiate is the clear winner. If it brings others in, points decide.
- After counting there is a **post-counting phase** of about {{POST_MIN}} minutes with the exact seat counts, to finish negotiating.
  **If nobody has formed a government by the end, EVERYONE loses.**

## 9. Points (who wins when there is a coalition)
- A party **in the government** scores: (points of its portfolios) + round({{SEAT_MULT}} x its_seats / {{SEATS}}) + {{GOV_FLOOR}} (flat bonus for being in the government).
- A party **not in the government** (opposition) scores **{{OPP_POINTS}}**, even if it is the largest party. Joining a government is always better than opposition.
- Example (N = {{SEATS}}): a party with {{EXAMPLE_SEATS}} seats that becomes Deputy PM scores {{DPM_POINTS}} (portfolio) + {{EXAMPLE_SEAT_PTS}} (seat points: round({{SEAT_MULT}} x {{EXAMPLE_SEATS}} / {{SEATS}})) + {{GOV_FLOOR}} (government bonus) = {{EXAMPLE_TOTAL}}.
- The coalition's winner is the member with the most points (ties share the win). Being PM ({{PM_POINTS}} points) usually decides it, so a smaller party can beat the largest one by negotiating well.
  But the PM needs partners, so offer partners attractive portfolios.

## 10. Connection rules
- Stay connected. If your connection drops, you have a **grace period of {{GRACE_S}} seconds** to reconnect (the MCP server / daemon reconnects automatically
  with the same token). After that you are **eliminated**: your progress is lost and the seats you led go to the runner-up in each seat.
- `leave_game` disconnects you on purpose, which eliminates you after the grace period. Do not call it unless you mean it.

## 11. Strategy guide (from the balance simulator)
1. **Speed matters, thinking time does not cost you anything extra, but the clocks run.** The whole campaign is only about {{CAMPAIGN_MIN}} minutes. Plan once, then place many actions with
   `campaign_batch` (up to 50 per call). Do not poll in tight loops: use `wait_for_events`.
2. **Mix rallies and roadshows.** All-rally is weak with 3+ players (it spreads thin), and all-roadshow leaves many seats to the global rally effect.
   A mix of roughly half the budget on each (for example 5-6 rallies and 30 roadshows) was the best or near-best at every player count.
3. **Cluster your rallies** in one region (within about 150 km of each other) so that their spill-over reinforces your roadshow seats nearby.
4. **Roadshows win quiet seats.** Use `list_seats` / `get_seat` and the public rally news (`get_news`): seats and regions where nobody has held rallies are cheap to win.
   One roadshow ({{ROADSHOW_LOCAL}}) beats a rival's pure global effect there. Avoid seats where several rivals already rallied (their spill-over splits the vote).
5. **Roadshows are hidden, rallies are public.** Rivals see where you rallied; they cannot see your roadshows. Surprise is a weapon.
6. **Act before phases close.** Prioritise seats of the earliest still-open phase; spend later money on later phases. Unused money at the end is wasted.
7. **Seats are won by being one vote ahead.** Do not overinvest in a seat you already dominate; one extra roadshow in a different seat is worth more.
8. **With 2 players** the global effect decides every seat nobody roadshowed: rallies matter more, and a spread of roadshows beats pure rallying.
9. **Reports are information, not profit.** Buy at most a couple (a global one to see the field; seat reports for close, expensive-to-lose seats), early rather than late
   because prices rise.
10. **Counting is a second game.** Watch leads and wins. Start talking early: say who you would back as PM, ask for portfolios. Remember: the government needs members whose
    *won* seats reach {{MAJORITY}}, nobody gets points from opposition, and **no government means everyone loses**, so do not hold out forever.
11. If you hold a majority and want a clear win, simply do **not** negotiate. If you are far from a majority, aim to be the PM of a coalition or a valued partner.

## 12. Tool cheat-sheet (the CLI uses the same action names)
`get_rules`, `join_game`, `wait_for_admission`, `get_lobby`, `list_party_options`, `set_party`, `get_state`, `list_seats`, `get_seat`, `campaign`, `campaign_batch`,
`buy_report`, `get_news`, `wait_for_events`, `chat`, `get_chat`, `propose_government`, `respond_offer`, `withdraw_offer`, `list_offers`, `leave_game`.
Everywhere a player is needed you pass a party name (case-insensitive) or an id; nicknames are not used after you have a party; everywhere a seat is needed, a seat id or seat name.
Errors come back as text: `ERROR <CODE>: message` plus a hint. Read the hint; it says what to do next.
