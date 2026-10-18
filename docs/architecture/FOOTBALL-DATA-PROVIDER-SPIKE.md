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

## Implemented spike harness

The repository now contains provider-neutral spike code:

- `lib/providers/types.ts` — normalized fixture/market/report contracts;
- `lib/providers/market.ts` — shared de-vig + robust bookmaker aggregation;
- `lib/providers/api-football.ts`;
- `lib/providers/sportmonks.ts`;
- `scripts/provider-spike.ts`;
- provider parser/market unit tests.

Environment variables:

```
API_FOOTBALL_API_KEY=
SPORTMONKS_API_TOKEN=
```

Input example:
`scripts/provider-spike.sample.json`.

Run the exact same input against API-Football:

```bash
npm run spike:provider -- --provider api-football --input ./round.json --out ./artifacts/api-football.json
```

Then Sportmonks:

```bash
npm run spike:provider -- --provider sportmonks --input ./round.json --out ./artifacts/sportmonks.json
```

Default concurrency is 2 and can be changed up to 8 with `--concurrency`.

Provider fixture IDs are optional. If omitted, the harness attempts same-date home/away name matching using supplied aliases. For a serious comparison, prefer already verified provider mappings when available so fixture-resolution quality and data-field coverage are measured separately.

The report distinguishes provider-declared capability from observed payload count. For example, zero injury rows does not mean injury coverage is unsupported.

API-Football's normal pre-match odds history is short-lived, so the most meaningful market spike must run on upcoming/recent fixtures and persist the output immediately.

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

## Round 264101 live spike result

Executed against API-Football Free on 2026-10-18 using the repository spike harness with free-tier throttling.

### Summary
- requested fixtures: 16
- resolved fixtures: **16/16**
- fixtures with observed odds: **16/16**
- average complete 1X2 bookmakers when odds were available: **5.94**
- fixtures with observed lineups: **6/16**
- fixtures with observed injuries: **11/16**
- degraded one-bookmaker priors: **0**

The six observed lineups correspond to fixtures that had already finished by the time of the spike. Future fixtures correctly had no published lineup yet, so 6/16 must not be interpreted as poor lineup coverage.

### Israeli coverage observations
All five Israeli fixtures mapped correctly, including Ligat Ha'al and Liga Leumit.

Completed Ligat Ha'al fixtures returned full lineup payloads (40 entries per fixture), demonstrating usable lineup coverage.

However, all five Israeli fixtures returned zero injury rows in this sample. This is a material limitation for availability research and must be supplemented with official/web evidence.

### Market-prior quality
Every fixture returned a usable non-degraded 1X2 prior from 5–6 complete bookmakers.

Example priors (basis points):
- Beitar Jerusalem vs Maccabi Tel Aviv: 3186 / 2464 / 4350
- Bournemouth vs Sunderland: 4520 / 2766 / 2714
- Leeds United vs Manchester United: 4034 / 2692 / 3274
- Celta Vigo vs Alaves: 4302 / 2911 / 2787
- Borussia Mönchengladbach vs Hoffenheim: 3058 / 2357 / 4585

These are de-vigged aggregated market priors produced by Kapiloto's shared market function; they are not bookmaker raw implied probabilities.

### Free-tier operational finding
API-Football Free is limited to 10 requests/minute and 100/day. The first burst test hit HTTP 429 after several fixtures.

The spike harness was then changed to:
- cache fixtures by date;
- skip the current-season league-coverage endpoint on Free;
- throttle requests to one slot every 6.5 seconds;
- wait for the previous rate-limit window before retrying.

The throttled full-round run completed successfully with no provider errors.

### Decision
API-Football is accepted as the **provisional MVP structured provider** for:
- canonical fixture resolution/mapping;
- kickoff/status;
- league/round context;
- lineup payloads when published;
- structured pre-match 1X2 market prior;
- injury data when present.

It is **not** accepted as the sole injury/team-news source.

The provider abstraction remains mandatory, and Sportmonks remains the benchmark/fallback candidate.
