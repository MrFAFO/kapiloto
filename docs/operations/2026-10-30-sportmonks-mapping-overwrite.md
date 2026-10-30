# 2026-10-30: V3 overwrote promoted Sportmonks competition mappings

Status: contained in the repository by migration
`20261030211645_kapiloto_v4_identity_mapping_guard.sql` (D-057). **Not yet
applied to production.** No production data has been changed by this branch.

## What happened

| Time (UTC) | Event |
| --- | --- |
| ~20:34:57 | Operator promoted Sportmonks competition mappings 8, 82, 372, 384 and 564 to `manual_override` in one transaction (5 rows), after the A2-B pilot verified provider id, entitlement and provider name. |
| 20:45:05 | Mappings 8 (Premier League), 372 (Ligat ha'Al) and 384 (Serie A) were back to `confirmed`. 82 (Bundesliga) and 564 (La Liga) were still `manual_override`; the current round had no fixture of theirs. |

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

## Containment (this branch)

- Automated UPDATEs of existing Sportmonks rows, and of any `manual_override`
  row, in the three mapping tables are skipped by a `BEFORE UPDATE` trigger.
  V3's upsert succeeds as a no-op; INSERT of a missing mapping and DELETE are
  unchanged.
- `service_role` can no longer execute
  `public.match_ledger_ingest_provider_fixture(jsonb)`.
- Operators opt in per transaction with
  `set local kapiloto.identity_operator = 'on'`.

## Operator steps after the migration is applied (each needs separate approval)

1. Before applying, export every Sportmonks row of the three mapping tables
   and the pg_cron job list, and keep the export with this note.
2. After applying, confirm the guard in a rolled-back transaction:

   ```sql
   begin;
   update public.provider_competition_mappings
   set mapping_status = 'unverified'
   where provider = 'sportmonks' and provider_competition_id = '82';
   -- expect UPDATE 0
   rollback;
   ```

3. Re-promote the three reset mappings only after checking each still points
   at the canonical competition the verified API-Football mappings use
   (migration `20261027183935`). The `competition_id` in the `WHERE` makes a
   re-pointed row update 0 rows instead of being promoted:

   ```sql
   begin;
   set local kapiloto.identity_operator = 'on';
   update public.provider_competition_mappings
   set mapping_status = 'manual_override', last_verified_at = now()
   where provider = 'sportmonks'
     and (provider_competition_id, competition_id) in (
       ('8',   'ccdbb89d-e575-4e15-820d-f5d1ecdc3a85'::uuid),
       ('372', '06b70ffa-847c-44d2-a346-3683ac9115c3'::uuid),
       ('384', 'a2b7daf8-1d1d-4b79-8801-b47ad6cde38c'::uuid));
   -- expect UPDATE 3; otherwise roll back and investigate
   commit;
   ```

4. Watch at least two precompute cycles and the next 05:22 UTC structured
   sync. All five competition mappings must stay `manual_override`, and
   existing Sportmonks rows must keep their `last_verified_at`.

Historical ingest stays paused until Stage 1 (V4 attestations) lands.
