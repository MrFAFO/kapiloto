# Opus review prompt — Kapiloto structured football data pipeline

You are reviewing Kapiloto's structured-data architecture after the production Winner 16 round 264201 test.

This is a **review/design task only**. Do not edit code, deploy, mutate production, or trigger paid AI research.

## Product principle

Kapiloto pays for football-data APIs specifically so that objective facts do not depend on web articles.

Structured providers should be the canonical source for facts such as:
- recent match results;
- goals for/against;
- home/away splits;
- standings;
- rest days / schedule load;
- fixture identity, orientation and kickoff;
- lineups/squads/coach where provider coverage is reliable;
- injuries/sidelined where provider coverage is reliable;
- market 1X2 prior;
- xG/xGA and richer performance statistics where available;
- Pressure Index / other provider-native performance metrics where available.

Sol/web research should primarily add interpretation and context that structured feeds do not reliably encode:
- breaking team news;
- tactical changes;
- coach comments;
- rotation intent;
- dressing-room/off-field issues;
- unusual match context;
- analyst views;
- qualitative interpretation.

The research model should reason **from structured facts plus web context**, not re-search objective facts on the web when the API already supplies them.

## Critical production finding

In round 264201, the research Fixture Card for Game 2 contained:
- `recent_matches: []`
- `table_snapshot_id: null`
- `squad_snapshot_id: null`
- `coach: null`
- a flat league-base prior because no market snapshot was present.

This forced Sol to use web articles to establish basic form such as "three consecutive wins".

## Existing implementation to inspect

Read:
- `docs/architecture/FOOTBALL-DATA-PROVIDER-SPIKE.md`
- `lib/kapiloto/fixture-card.ts`
- `lib/kapiloto/fixture-input-store.ts`
- `lib/kapiloto/research-plan-preparer.ts`
- `lib/kapiloto/research-prompt.ts`
- `lib/providers/types.ts`
- `lib/providers/api-football.ts`
- `lib/providers/api-football-sync.ts`
- `lib/providers/api-football-supabase-store.ts`
- `lib/providers/sportmonks.ts`
- `lib/providers/sportmonks-sync.ts`
- `lib/providers/sportmonks-facts.ts`
- `lib/providers/sportmonks-supabase-store.ts`
- related tests and migrations/tables for provider facts/snapshots.

Also read the completed grounding-policy review and keep it in mind. Do not conflate the two problems: one is evidence policy, the other is failure to supply structured facts.

## Known empirical provider findings

From the provider spike:
- Sportmonks is strong for structured performance analytics in entitled leagues.
- It has supplied conventional statistics and Pressure Index on sampled Israeli competitions.
- It supplied xG-family metrics on sampled Serie A/Bundesliga/Ligue 1/Premier League/La Liga fixtures when entitled.
- It supplied lineups and sidelined rows on many sampled fixtures.
- API-Football successfully supplied broad fixture mapping and usable 1X2 market priors, but coverage/plan windows have limitations.
- Sportmonks has not yet proven usable 1X2 bookmaker triples in the sampled run.
- Therefore capability-specific provider fallback is already a design requirement.

## Core design question

Design the structured data layer that should exist **before Sol runs**.

We do not want to dump hundreds of raw provider rows into the LLM and ask it to calculate everything.

We want a deterministic pipeline that:
1. ingests raw provider data with provenance;
2. persists snapshots;
3. derives stable, versioned football features;
4. freezes those features at research cutoff;
5. passes a compact but rich structured Fixture Card to Sol;
6. lets Sol interpret those facts together with web research;
7. never requires a news article to prove an objective fact already present in the structured snapshot.

## Questions to answer

1. What exact raw provider data should Kapiloto ingest for each fixture/team before research?
2. Which provider should be primary/fallback **by capability**, not globally?
   - fixture identity/status
   - recent results
   - standings
   - lineups/squads
   - injuries/sidelined
   - coach
   - match statistics
   - xG/xGA
   - Pressure Index
   - 1X2 odds/prior
3. Which facts should be stored raw, and which should be derived deterministically?
4. What derived features should be calculated before Sol?
   Examples to assess:
   - last N form, with home/away split;
   - goals/xG for and against;
   - xG difference trend;
   - opponent-strength-adjusted form;
   - rest days / congestion;
   - clean-sheet/scoring streaks;
   - lineup continuity;
   - missing-player importance;
   - home/away performance;
   - table position/points with deduction flags;
   - recent tactical/performance trend from Pressure Index/statistics.
5. Which of these are safe deterministic features, and which require model interpretation?
6. How should provider disagreements be represented?
7. How should missing coverage be represented explicitly, so missing data is never confused with zero?
8. How should timestamps/cutoffs prevent post-kickoff leakage?
9. How should facts and derived features be versioned and replayable?
10. What should the new `KapilotoFixtureCard` schema look like?
11. How should the Sol prompt change so it:
    - treats structured facts as authoritative for objective data;
    - does not waste web searches re-proving them;
    - uses web for qualitative/contextual evidence;
    - may challenge a provider fact only when there is explicit conflicting evidence.
12. How should grounding treat structured facts?
    - They should not need web quote verification.
    - What provenance/integrity checks should replace web grounding for them?
13. How should structured facts participate in factors and final probability derivation?
14. How much raw Sportmonks analytics should Sol actually see versus precomputed summaries?
15. Can we use Sportmonks to compute a richer deterministic team-strength/performance baseline before Sol?
16. What additional tables/snapshots are needed, if any?
17. What changes are required in `research-plan-preparer.ts` and `fixture-input-store.ts`?
18. Which current code paths are dead/unused despite already ingesting Sportmonks facts?
19. What is the safest incremental rollout plan without another expensive full 16-game research run?
20. Which tests are mandatory before production?

## Required output

Return:

1. **Diagnosis** — why round 264201 did not use the structured data we already pay for.
2. **Target architecture** — provider raw → canonical snapshot → derived features → frozen Fixture Card → Sol + web context.
3. **Provider-by-capability matrix** with primary/fallback.
4. **Exact Fixture Card v3 proposal**, including field names and provenance metadata.
5. **Exact deterministic derived features** to calculate before Sol, with formulas/rules where appropriate.
6. **What Sol should calculate vs what code should calculate.**
7. **How structured evidence and web evidence should coexist in grounding/factors.**
8. **Concrete code changes by file/table.**
9. **Migration/compatibility plan.**
10. **Test plan.**
11. **Cost/latency impact.**
12. **A staged rollout plan** that first validates the structured pipeline offline/shadow-mode before any new paid research.
13. **Top 5 risks / failure modes.**
14. **Recommended first implementation slice** that gives the biggest quality gain with the least complexity.

Important: do not assume "provider says league covered" means every field is present. Missing/unsupported must be explicit and per-capability/per-fixture.
