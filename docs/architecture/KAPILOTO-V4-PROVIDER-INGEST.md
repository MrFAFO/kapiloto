# Kapiloto V4 Provider-Native Match Ledger Ingest (Foundation 1E-A2-A)

Status: contracts and offline implementation only. No provider backfill is executed by A2-A, and V3 does not read this layer.
Decision: D-056.

## Purpose

A2-A provides one atomic path from provider-native Sportmonks fixture data to the existing V4 Match Ledger. It preserves the 1A information-time contract while adding the minimum identity/bootstrap, stat-definition, audit and retrospective-training contracts required for the operator backfill in A2-B.

The outer payload is `kapiloto-provider-match-observation-v1`. Sportmonks parsing is versioned as `kapiloto-sportmonks-ledger-mapping-v1`. The inner immutable ledger observation remains `kapiloto-match-ledger-observation-v1`; its content hash and strict as-of reads are unchanged.

## Identity rules

- Teams and competitions are never created by A2-A. Sportmonks league/team ids must resolve through `confirmed` or `manual_override` mappings or the fixture is quarantined.
- Players may be minted from a provider id. The mapping is `confirmed`, confidence 1, with `mapping_basis = provider_native_bootstrap`; provider spelling is stored as an alias when present. No name or fuzzy matching is used.
- Existing authoritative fixture mappings win after orientation/team/competition validation.
- Without a fixture mapping, attachment is competition + oriented home/away identity scoped. The narrow candidate window is ±48h. Same-pair fixtures within ±14d and postponed/suspended/cancelled/under-review placeholders within ±180d are guards: ambiguity is quarantined, never guessed. Null-competition candidates within ±14d also quarantine.
- A new canonical fixture can be minted only when the caller explicitly permits it, supplies `kickoff_before`, the match is finished, the kickoff is older than that cutoff, and no candidate/guard exists. The database does not hardcode the V3 21/22-day operational window; A2-B owns that runner policy.
- Reverse orientation is a different fixture and is never swapped automatically.

The RPC lock order is fixed: provider-fixture identity → canonical competition/home/away pair → 1A fixture/provider → exclusive player identity. It requires READ COMMITTED.

## Provider identity sidecar and drift

`match_ledger_observation_provider_refs` stores exactly four identity-critical provider refs for every A2-A-recorded observation: league, season, home team and away team. Rows are written in the same top-level statement as the ledger observation and are immutable/sealed.

These refs are intentionally outside the 1A V1 content hash. Therefore A2-A never mutates them and never silently treats changed refs as the same observation. If the latest observation's four refs differ from a new payload, ingestion returns `provider_ref_drift`; if the latest version has no complete ref sidecar, it returns `provider_refs_unrecorded`. A future observation contract V2 is required if legitimate ref churn must become versioned content.

## Statistics

A2-A seeds a reviewed Sportmonks allow-list under definition version `sm-2024-08`:

- 5304 `EXPECTED_GOALS` → `expected_goals`
- 5305 `EXPECTED_GOALS_ON_TARGET` → `expected_goals_on_target`
- 7943 `EXPECTED_NON_PENALTY_GOALS` → `expected_non_penalty_goals`
- 42 `SHOTS_TOTAL` → `shots_total`
- 86 `SHOTS_ON_TARGET` → `shots_on_target`
- 45 `BALL_POSSESSION` → `possession_pct`
- 34 `CORNERS` → `corners`

The parser requires both the allow-listed type id and expected developer name. Unknown/drifted types are not ingested. The four non-xG ids/names remain an A2-B live-payload verification item. Missing metrics create no stat row and are never zero.

xG, xGoT and npxG are separate canonical keys. Extra-time fixtures do not ingest inseparable full-match provider stats.

## Strict and retrospective reads

`kapiloto-team-match-stats-v1` exposes one team per selected fixture, one provider per call, with identity/provenance, 90-minute result, provider league/season refs and all seven contract stat keys for/against. Every stat has one of:

- `observed`
- `not_observed`
- `family_not_provided`
- `not_separable`

Only `observed` has a numeric value.

`match_ledger_team_match_stats_as_of` is strict actual-knowledge selection and uses only database-stamped `first_seen_at`.

`match_ledger_team_match_stats_for_training` is a separate API and accepts only `kapiloto-retrospective-training-availability-v1`. For a version-1 finished `backfill` observation only:

`effective_available_at = min(first_seen_at, kickoff_at + 24h)`

All later corrections, withdrawals, scheduled sync and manual imports use actual `first_seen_at`. This is a retrospective training convention over finalized historical provider data. It is **not** a reconstruction of when Sportmonks or Kapiloto actually knew the information.

### Permitted claims

- Fit models on finalized historical outcomes/features.
- Retrospective forward-chained evaluation labeled `evaluation_class = retrospective`.
- Report performance of a model form trained/evaluated on finalized historical data.

### Forbidden claims

- Claim that Kapiloto could have known a backfilled fact before a historical match.
- Use backfilled rows as pre-match knowledge in historical research, Squad State, lineup snapshots or Prediction Registry artifacts.
- Describe retrospective results as simulated live-production performance.

True live-performance claims require actual-time forward data captured after scheduled ingestion starts.

## Audit and A2-B boundary

`provider_ingest_runs` freezes provider, purpose, ingest version, entitlement snapshot hash/scope and the operator mint cutoff. `provider_ingest_items` appends every recorded/unchanged/quarantined/failed attempt. `match_ledger_fixture_mints` records every fixture minted by the outer RPC.

A2-B, not A2-A, owns provider entitlement discovery, team/competition reconciliation, rate limiting/retries/resume, the operator historical backfill, pilot rollout and the coverage/quality report. No Team Strength, Player Impact, probability model or V4 runtime activation belongs to A2.
