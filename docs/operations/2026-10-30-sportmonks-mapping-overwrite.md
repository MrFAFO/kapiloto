# 2026-10-30: V3 overwrote promoted Sportmonks competition mappings

Status: **Stage 0 containment applied to production** via migration
`20261030211645_kapiloto_v4_identity_mapping_guard.sql` (D-057) on
2026-10-30. Historical Match Ledger provider ingest is paused until Stage 1
attestations replace trust in V3-owned mapping columns.

## What happened

| Time (UTC) | Event |
| --- | --- |
| ~20:34:57 | Operator promoted Sportmonks competition mappings 8, 82, 372, 384 and 564 to `manual_override` in one transaction (5 rows), after the A2-B pilot verified provider id, entitlement and provider name. |
| 20:45:05 | Mappings 8 (Premier League), 372 (Ligat ha'Al) and 384 (Serie A) were back to `confirmed`. 82 (Bundesliga) and 564 (La Liga) were still `manual_override`; the current round had no fixture of theirs. |
| 21:30:05 | The same three mappings were written again by the active structured-sync path, confirming the overwrite was recurrent. |
| 21:42:43 | Pre-change production snapshot captured for all Sportmonks team/competition/fixture mappings plus pg_cron jobs; SHA-256 `c533c332117e39aa724e19cb169d142f6472c79450c7789d4a7164e221810cd9`. |
| 21:56:46 | After M1 application and verification, mappings 8, 372 and 384 were re-promoted in one guarded operator transaction with exact canonical-id predicates; exactly 3 rows changed. All five target competitions were then `manual_override`. |

No Match Ledger observation had been written, and no historical ingest or
backfill had run.

## Why

- Production Supabase pg_cron job 11 (`*/15 * * * *`) POSTs to
  `/api/internal/kapiloto/precompute`. Whenever fewer than 16 fresh structured
  snapshots exist, the route calls `syncKapilotoStructuredRound`
  (`app/api/internal/kapiloto/precompute/route.ts`). The Vercel cron
  `/api/internal/cron/structured-sync` (`22 5 * * *`) calls it daily.
  `SPORTMONKS_API_TOKEN` is set in production.
- For each pre-kickoff game Sportmonks resolves,
  `SupabaseSportmonksSyncStore.saveResolvedFixture`
  (`lib/providers/sportmonks-supabase-store.ts`) upserts the fixture, both team
  mappings and the competition mapping with `ON CONFLICT DO UPDATE` and
  `mapping_status = 'confirmed'`. That resets `manual_override` and can
  re-point `team_id` / `competition_id` / the fixture mapping.
- `loadRoundGames` reads Sportmonks fixture mappings without a status or
  confidence filter. Once V3 has mapped a fixture by name (0.9), the next sync
  fetches it by that id (`provided_id`) and rewrites the fixture and both team
  mappings at confidence 1. A2-A trusted `confirmed` at confidence 1.

## Containment (applied production state)

- Automated UPDATEs of existing Sportmonks rows, and of any `manual_override`
  row, in the three mapping tables are skipped by a `BEFORE UPDATE` trigger.
  V3's upsert succeeds as a no-op; INSERT of a missing mapping and DELETE are
  unchanged.
- `service_role` can no longer execute
  `public.match_ledger_ingest_provider_fixture(jsonb)`.
- Operators opt in per transaction with
  `set local kapiloto.identity_operator = 'on'`.

## Production verification completed

- Migration history contains `20261030211645_kapiloto_v4_identity_mapping_guard`.
- All three identity guard triggers exist and are enabled:
  - `provider_team_mappings_identity_guard`
  - `provider_competition_mappings_identity_guard`
  - `provider_fixture_mappings_identity_guard`
- A production UPDATE against a guarded Sportmonks mapping returned 0 rows and
  left the row unchanged.
- `service_role`, `anon` and `authenticated` cannot execute
  `public.match_ledger_ingest_provider_fixture(jsonb)`.
- The three reset competition mappings were re-promoted with exact canonical-id
  predicates and an asserted row count of 3.
- Both `match_ledger_mapping_conflicts('sportmonks')` and
  `match_ledger_provider_ref_conflicts('sportmonks')` were empty immediately
  after the change.
- Continue observing at least two natural precompute cycles and the next 05:22
  UTC structured sync. Existing guarded Sportmonks rows must not change.

V3 code alignment was then deployed to production in commit
`aa5568a78b67646496ad3159617bfb90284bb69e`: Sportmonks identity mapping
writes are insert-only and remain weak evidence at confidence 0.9. The D-057
database trigger remains the hard safety boundary.

Historical ingest stays paused until Stage 1 (V4 attestations) lands.
