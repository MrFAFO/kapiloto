# Football Data + Market Provider Spike

Status: provider decision pending empirical coverage test.

Verified against public provider information on 2026-10-18.

## Why this spike now

The Kapiloto research architecture now requires a structured fixture card before Sol runs.

At minimum the provider layer must reliably supply:
- fixture identity and kickoff;
- competition/stage context;
- team/squad/coach mappings;
- recent results and standings;
- lineups/injuries where available;
- pre-match 90-minute 1X2 odds for the prior;
- timestamps/versions needed to freeze a pre-match snapshot.

The provider must cover the actual competitions that appear on Winner 16 tickets, not just top European leagues.

## Candidate A — API-Football / API-Sports

Public claims/current plan:
- 1,248 leagues and cups;
- Israeli coverage lists Liga Alef, Liga Leumit, Ligat Ha'al, State Cup, Super Cup and Toto Cup Ligat Al;
- standard plans include fixtures, lineups, injuries, statistics, predictions, pre-match odds and in-play odds;
- Free: 100 requests/day;
- Pro: $19/month, 7,500 requests/day;
- Ultra: $29/month, 75,000 requests/day;
- Mega: $39/month, 150,000 requests/day.

Important implementation note:
- API-Football documents only a seven-day history window for its normal pre-match odds endpoint.
- Kapiloto therefore must persist every odds snapshot it uses; we cannot depend on the provider to reconstruct old cutoff-time priors later.

### Why it is the first spike candidate
- broad competition coverage on one plan;
- very low cost for an MVP;
- Israeli competitions are explicitly listed;
- one vendor can potentially satisfy fixture + lineup/injury + odds needs.

### Risks to test
- field-level coverage varies by league/season/fixture;
- Israeli lower-league lineup/injury/odds completeness may be much weaker than “league covered” suggests;
- bookmaker depth and odds update quality must be measured, not assumed;
- advanced metrics such as xG may be limited relative to premium providers.

## Candidate B — Sportmonks

Public claims/current plan:
- 2,200+ football leagues;
- field-level Coverage Finder;
- fixtures, squads, lineups, statistics and other football data;
- pre-match/in-play odds and richer advanced-data options;
- Starter: €29/month for 5 leagues;
- Growth: €99/month for 30 leagues;
- Pro: €249/month for 120 leagues;
- odds/prediction and advanced feeds have additional plan/add-on considerations.

### Strengths
- stronger advanced-statistics/xG story;
- explicit coverage tooling per league/field;
- odds, fixture and participant ids live in one ecosystem;
- potentially better long-term research inputs.

### Risks
- Winner 16 can draw from many competitions; league-count pricing may become material;
- public pages do not establish the exact Israeli field coverage required by Kapiloto;
- total cost must include the exact odds/advanced-data package needed.

## Not preferred as primary — football-data.org

Useful for common competitions, but its published coverage is much narrower and does not establish the broad Israeli/multi-league coverage Kapiloto needs.

It can remain a reference/secondary source, not the first primary-provider spike.

## Market-prior derivation

Kapiloto should not use a single bookmaker's raw implied probabilities as p_prior.

For each market snapshot:

1. Select only the 90-minute full-time-result 1X2 market.
2. Require a complete Home/Draw/Away triple from the same bookmaker snapshot.
3. Convert decimal odds to raw implied values:
   - q1 = 1 / odds_home
   - qx = 1 / odds_draw
   - q2 = 1 / odds_away
4. Remove bookmaker margin by normalization:
   - p1 = q1 / (q1 + qx + q2)
   - px = qx / sum
   - p2 = q2 / sum
5. Convert each bookmaker distribution to basis points.
6. Aggregate across eligible bookmakers using a versioned robust method (initial candidate: component-wise median followed by renormalization).
7. Persist:
   - raw odds;
   - provider/bookmaker ids;
   - captured/update time;
   - overround;
   - de-vigged bookmaker probabilities;
   - final aggregated prior;
   - derivation version.

If only one complete bookmaker is available, the prior may still be used but its quality flag/reliability contribution is reduced.

## Coverage-spike procedure

Before selecting a provider, test against several real Winner 16 rounds.

For every listed fixture collect:
- fixture mapping success;
- kickoff accuracy;
- competition/stage;
- squad/coach availability;
- recent-results/standings;
- injuries/suspensions;
- expected/actual lineups;
- 1X2 odds availability;
- number of complete bookmakers;
- odds timestamps/update recency;
- xG/advanced metrics if available.

Score separately by:
- top international leagues;
- Israeli Premier League;
- Liga Leumit;
- cups;
- less common foreign leagues.

## Acceptance criteria for a primary MVP provider

The provider must:
- map essentially all 16 fixtures of sampled rounds;
- provide trustworthy kickoff/orientation data;
- provide a usable structured prior for the large majority of pre-match fixtures;
- fail explicitly when a field is unsupported;
- provide timestamps sufficient for cutoff/evaluation isolation;
- permit server-side storage/use under its commercial terms.

We should not select a vendor from marketing coverage counts alone.

## Recommended next action

Start the empirical spike with API-Football's free tier.

Use Sportmonks as the quality benchmark on a trial/free account for the same sampled fixtures.

Only after comparing real Winner 16 rounds should D-006's provider implementation be bound to a concrete vendor.
