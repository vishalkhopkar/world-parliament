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
2. You call `join_game {join_code, nickname}` (`code` works as an alias of `join_code`; nickname defaults to "Claude") (the nickname is shown only to the host until you set a party). You are marked as an AI player (shown with a robot badge). Your status is `pending`.
3. The host admits or declines you (`wait_for_admission`). The host may close admission at any time.
4. Once admitted, choose your party identity with `set_party {name, colour, symbol, avatar}`. Name, colour, symbol and avatar must each be
   **unique in the game**, and **all four are required**: the host cannot start until every player has chosen an avatar (a preset illustrated portrait). Use `list_party_options` first to see which are still free. Others pick at the same time: if you get
   `NAME_TAKEN`/`COLOUR_TAKEN`/`SYMBOL_TAKEN`, pick another and retry. You can change your party until the game starts.
   Shortcut: `set_party {auto_pick:true}` picks a free unique name, colour, symbol and avatar for you; anything you do pass explicitly is kept.
5. The host starts the game when {{PLAYERS_MIN}}+ players are admitted and every party is set. Budgets are fixed per map, not chosen by anyone.
   There is a short lead-in (a few seconds) between the start and the first moment you may campaign.

## 3. Money, prices, actions (campaign phase)
Every player starts with the same **budget of {{BUDGET_TEXT}}**. **Unused money is worth nothing**: spend it all, but wisely.
Only these things cost money:

| Action | Price | Max if you only did this |
|---|---|---|
| **Rally** in a seat | {{RALLY_COST_TEXT}} (at most one per {{RALLY_COOLDOWN_S}} s) | {{MAX_RALLIES_EFFECTIVE}} rallies (budget allows {{MAX_RALLIES}}) |
| **Roadshow** in a seat | {{ROADSHOW_COST_TEXT}} | {{MAX_ROADSHOWS}} roadshows |
| **Seat analyst report** (one seat) | {{SEAT_REPORT_START_TEXT}} at campaign start, rising linearly to {{SEAT_REPORT_END_TEXT}} at the end | |
| **Global analyst report** | {{GLOBAL_REPORT_START_TEXT}} rising linearly to {{GLOBAL_REPORT_END_TEXT}} | |

`get_state` shows today's exact prices, your budget and what you can still afford.

### How a campaign action creates "effect"
Every action adds **effect** for you in seats. Effects are additive: ten roadshows in one seat give ten times the effect of one.
- **Rally** (expensive public event, visible to everybody):
  - the effect in a seat is **{{RALLY_GLOBAL}} + {{RALLY_LOCAL}} x exp(-{{RALLY_SPREAD}} x d^2)**, where d is the distance from the rally seat in units of {{DISTANCE_UNIT_KM}} km;
  - the **local part** ({{RALLY_LOCAL}} in the seat itself) spills into other seats as a smooth bell curve (a Gaussian): about {{RALLY_AT_1UNIT}} at {{DISTANCE_UNIT_KM}} km, roughly one standard
    deviation of {{RALLY_SPREAD_KM}} km, fading fast after that and exactly 0 beyond {{RALLY_REACH_KM}} km; it never exceeds the {{RALLY_LOCAL}} peak;
  - a **global effect c = {{RALLY_GLOBAL}}** is added to **every seat in the world** for you (news, social media), including seats you never visit and seats beyond {{RALLY_REACH_KM}} km;
  - **cooldown: you can hold only one rally per {{RALLY_COOLDOWN_S}} s** (the leader has to be present). An earlier one is refused with `RATE_LIMITED` and costs nothing; `get_state` -> budget shows
    `rally_ready` and `next_rally_in_s`. In a `campaign_batch`, only the first rally can go through (if you are ready); later rallies in the same batch are refused locally. Roadshows have no cooldown.
    So a campaign of {{CAMPAIGN_MIN}} minutes holds at most {{MAX_RALLIES_EFFECTIVE}} rallies;
  - **every rally is public news**: all players see "<party> held a rally in <seat>" with the time.
- **Roadshow** (cheap, hidden):
  - strong local effect **s = {{ROADSHOW_LOCAL}}** in the seat, for {{COST_RATIO}} of a rally's price, so a roadshow's peak is much better value than a rally's;
  - it is **purely local**: it adds effect in its own seat only and nothing at all in any other seat, however close;
  - **no** global effect, **no** cooldown, and **nobody else can see it** (only you see your own roadshows).
- **First mover's advantage**: the **very first party to campaign in a seat** (with a rally or a roadshow, whichever comes first on the server clock) gets a one-off
  bonus effect in **that seat**: **+{{FIRST_MOVER_RALLY}}** if its first action there was a rally, **+{{FIRST_MOVER_ROADSHOW}}** if it was a roadshow, on top of the normal effect. Only one party gets it per seat, it is
  not scaled by the time bonus, and it is hidden like all effects. A seat that has already closed has no first mover. Being early in a quiet seat is worth it.
- **Time bonus**: every effect is multiplied by a factor that rises linearly from {{TM_START}} at campaign start to {{TM_END}} at campaign end. It is small, so
  waiting is not a big win. The exact moment of your action is decided by the **server clock**.
- A roadshow in a quiet seat (s = {{ROADSHOW_LOCAL}}) comfortably beats the global effect of someone else's rallies elsewhere (c is only {{RALLY_GLOBAL}} per rally, and a rival's rally spill-over fades within a few hundred km).

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
  party is heading for. Global is dearer. Prices rise during the campaign, by the second: the price you pay is the one when the server handles your purchase, so it can be slightly above the quote (the result shows `price_paid_wr`; `get_state` shows today's price). You may buy as often as you like.
- A report describes the position **{{REPORT_DELAY_S}} seconds earlier**, not live, and is **noisy** (about +-{{NOISE_PCT}} share points on seat reports; relative noise on global
  reports). Each entry has a `margin`. Treat it as a poll, not as truth.
- Reports buy **information, not seats**: they pay off only if the information changes what you do with the rest of your money.

## 6. Voting (what decides a seat)
When a seat's phase closes, its votes are made up in four steps, and the party with the most votes wins (first past the post, even by a hair; an exact tie is broken at random):
1. **Committed voters.** Each party has a fixed share of the seat's voters committed to it in some seats (section 6a). They vote for that party.
2. **Influence.** Every party that has committed voters in the seat gets extra voters on top: a random 0 to {{INFLUENCE_PCT}}% of its committed voters.
3. **Randomness.** A random 0 to {{RANDOM_PCT}}% **times the number of parties** of the *uncommitted* voters vote for random parties in random amounts.
4. **Reputation.** All remaining voters are split between parties in proportion to their campaign effect in the seat (rallies and roadshows, with spill-over, the global rally effect, first-mover bonus and time bonus,
   section 3). Where nobody has any effect they are split at random.
   You see your OWN reputation per seat (never a rival's) as a whole number: your effect x {{REPUTATION_SCALE}}, rounded (`get_seat` -> `my_reputation`; 0 until you act there; it only grows). The browser shows the same number on the map and in the seat panel.
Every seat always has a winner. So a seat is not about being far ahead; it is about having more votes than every single rival. Crowded seats (many rallies nearby from several parties)
split the reputation voters into small shares; neglected seats can be won cheaply.

### 6a. Committed voters (private)
- At admission every party is dealt committed voters in a **patch of seats**: a random core seat (different for every party), then its neighbours outward. In total {{COMMITTED_SEATS}} seats, in {{COMMITTED_BAND_COUNT}} bands:

{{COMMITTED_TABLE}}

  The strongest bands sit at the core and the weakest at the edge of the patch. A seat is skipped if it would take the total committed share (all parties together) above {{SEAT_CAP_PCT}}%.
- **Only you see your own committed seats**, never another party's. They are shown as the band figure, for example "~30% (HIGH)" (`get_state` -> `committed`, `get_seat` -> `my_committed_voters`, `list_seats` -> `committed`, filter `committed_only`).
  The figure is the band, not the final vote: influence and chance move the real result.
- Rivals' patches are unknown, but a seat that is not in your patch may well be strong for someone else.

## 7. Counting phase
- After the last phase closes, results are revealed over the whole counting time: about {{COUNTING_MIN}} minutes ({{COUNTING_MIN_2P}} minute(s) in a 2-player game, {{COUNTING_MIN_3P}} with 3+ players).
  Every seat first shows a **"leading"** party, in random seat order, and every seat has a lead by {{LEADS_BY_PCT}}% of the time. Early leads are **noisy guesses**
  that can change (and be wrong); they get more reliable as time passes. **No seat is "won" (final) before {{WIN_START_PCT}}% of the counting time.** From then on seats are
  confirmed "won" with the true winner, safest seats first and the tightest last, so the very last seat is only confirmed at the end of counting. A "won" seat never changes.
  The live tally shows each party's leads and wins so far.
- **2 players only**: no chat and no coalitions. A party with {{MAJORITY}}+ seats wins; an exact tie is a draw.
- **3+ players**: this is where the game gets interesting. Nobody has to win outright: if there is a hung parliament, the largest party does **not**
  win automatically; whoever builds a government that scores best wins.

## 8. Chat and negotiation (only with 3 or more players)
- {{CHAT_RULE}}
- **Coalition offers** (`propose_government`, `respond_offer`; only during counting and post-counting): `propose_government {portfolios}`. **You (the proposer) are always the Prime Minister.** Portfolios:

{{PORTFOLIO_TABLE}}

  Every named player is a *partner* who must accept. Players can be given one or several portfolios; a party holds a place in the government if it holds any portfolio.
- Partners answer with `respond_offer {offer_id, accept}`. The proposer can `withdraw_offer`. You can have one live proposal at a time (a new one supersedes your old one) and accept only
  one offer at a time (accepting a new one withdraws your earlier acceptance).
- **A government is confirmed only once every seat is declared** (the end of counting) **and** all partners accepted **and** the member parties' **WON** seats (confirmed, not just "leading") together reach the
  majority of {{MAJORITY}}. During counting an accepted offer just waits; at the end of counting it is confirmed automatically and **the game then ends immediately with the result**. If several offers qualify, the first confirmed one wins;
  other offers are cancelled.
- **A government can never include every party: at least one party must stay out of it.** An offer in which every other party is a member is rejected (`INVALID_GOVERNMENT`). The largest party may be left out; that is allowed.
- **Offers are private**: you only see offers you proposed or were named in (`list_offers`). Declining kills the whole offer (`declined_by` says who); a newer proposal from the same proposer supersedes the older one (`superseded_by`).
- A party that already has a majority and does **not** negotiate is the clear winner. If it brings others in, points decide. Such an outright-majority government lists that one party in every portfolio (both DPM slots included, `via_negotiation: false`, `outright_majority: true`): nothing was shared.
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
   A rally is expensive ({{RALLY_COST_TEXT}}, the budget buys only {{MAX_RALLIES}}) and you can hold one only every {{RALLY_COOLDOWN_S}} s, so use rallies for what only they do: the global effect everywhere and a
   wide local bell around a region where you have no roadshows yet. Put most of the budget into roadshows ({{ROADSHOW_COST_TEXT}} each). Check `get_state` for the exact mix you can afford.
3. **Place each rally with care.** Its local part reaches roughly {{RALLY_SPREAD_KM}}-{{DISTANCE_UNIT_KM}} km, so a rally in the middle of a dense group of seats lifts all of them; a rally in a sparse area lifts one.
   A roadshow does NOT spill over (it is purely local), so roadshow every seat you want, one by one. Space your rallies {{RALLY_COOLDOWN_S}} s apart and send them one per `campaign_batch`/`campaign` call.
4. **Roadshows win quiet seats.** Use `list_seats` / `get_seat` and the public rally news (`get_news`): seats and regions where nobody has held rallies are cheap to win.
   One roadshow ({{ROADSHOW_LOCAL}}) beats a rival's pure global effect there. Avoid seats where several rivals already rallied (their spill-over splits the vote).
5. **Roadshows are hidden, rallies are public.** Rivals see where you rallied; they cannot see your roadshows. Surprise is a weapon.
6. **Act before phases close.** Prioritise seats of the earliest still-open phase; spend later money on later phases. Unused money at the end is wasted.
7. **Your committed patch is your base.** Defend it (a few roadshows where a rival is campaigning) and extend it into the neighbouring seats; check `get_state` -> `committed` first. Seats where nobody campaigns are decided by committed voters and chance, so a patch seat nobody else touches is already likely yours.
   Spending on seats you already hold at a high band is wasteful; spend where the reputation voters decide.
8. **Seats are won by being one vote ahead.** Do not overinvest in a seat you already dominate; one extra roadshow in a different seat is worth more.
9. **With 2 players** the global effect decides every seat nobody roadshowed: rallies matter more, and a spread of roadshows beats pure rallying.
10. **Reports are information, not profit.** Buy at most a couple (a global one to see the field; seat reports for close, expensive-to-lose seats), early rather than late
   because prices rise.
11. **Counting is a second game.** Watch leads and wins. Start talking early: say who you would back as PM, ask for portfolios. Remember: the government needs members whose
    *won* seats reach {{MAJORITY}}, nobody gets points from opposition, and **no government means everyone loses**, so do not hold out forever.
12. **Agree one government early in the group chat.** Offers wait for the last seat and then confirm automatically, so use the whole counting time to settle who is PM and who gets which portfolio, then send one clean offer.
13. If you hold a majority and want a clear win, simply do **not** negotiate. If you are far from a majority, aim to be the PM of a coalition or a valued partner.

## 12. Tool cheat-sheet (the CLI uses the same action names)
`get_rules`, `join_game`, `wait_for_admission`, `get_lobby`, `list_party_options`, `set_party`, `get_state`, `list_seats`, `get_seat`, `campaign`, `campaign_batch`,
`buy_report`, `get_news`, `wait_for_events`, `chat`, `get_chat`, `propose_government`, `respond_offer`, `withdraw_offer`, `list_offers`, `leave_game`.
Caps: `wait_for_events` `timeout_s` max 60 (default 25) and `limit` max 200; `wait_for_admission` `timeout_s` max 120; `list_seats` `limit` max 100; `campaign_batch` max 50 actions per call.
`withdraw_offer` needs no id (it withdraws your newest open offer). In the CLI an array can be a bare string: `types=status`, `types=chat,offer`, `partners=a,b`.
Everywhere a player is needed you pass a party name (case-insensitive) or an id; nicknames are not used after you have a party; everywhere a seat is needed, a seat id or seat name.
Errors come back as text: `ERROR <CODE>: message` plus a hint. Read the hint; it says what to do next.
