# Kapiloto V4 — M2B/M2C Recovery Runbook

Status: **pre-activation runbook; must be rehearsed before M2B**  
Scope: Sportmonks V4 Match Ledger tiny pilot and later staged backfills  
Related: D-058, D-060, M2A/M2B/M2C

## Purpose

This runbook is the operator procedure for stopping V2 provider ingest and
recovering from an identity/fixture mistake without deleting historical Match
Ledger evidence.

It intentionally separates three actions:

1. **M2C pause** — stop new V2 ingest immediately.
2. **Trust/fixture recovery** — revoke bad trust, withdraw the bad chain, repair
   mappings, re-attest, and re-ingest under a new reviewed run.
3. **Migration bookkeeping** — only after the emergency revoke succeeds, create
   a fresh timestamped migration that records the already-applied M2C revoke.

M2C itself never mutates identity or Match Ledger data.

## Non-negotiable rules

- Never re-enable the V1 ingest RPC.
- Never delete or rewrite Match Ledger observation history.
- Never edit an attestation generation in place.
- A wrong identity is repaired by **revoke -> mapping correction -> re-attest**,
  in separate transactions.
- A wrong observation chain is retracted with a new **withdrawal version**.
- Do not re-point a provider fixture mapping while the bad observation remains
  the current visible provider version.
- Every recovery re-ingest uses a **new immutable run** with an explicit
  `scope.provider_fixture_ids` allowlist.
- Do not commit a timestamped M2C migration before M2B. A normal future
  Supabase migration push must never pause ingest accidentally.
- A wrongly minted fixture is not deleted automatically. It remains historical
  evidence; after withdrawal it may remain as an orphan and appear as
  `mint_without_mapping`.

## Pre-activation rehearsal acceptance

Before M2B can be GO, the repository must prove on synthetic DB data that:

- a simulated M2B grant can be paused by the reviewed M2C body;
- M2C changes only EXECUTE privilege;
- revocation immediately removes the affected generation from V2 reads;
- the impact report identifies the affected observation and fixture artifacts;
- the bad chain can be withdrawn;
- the provider mapping can be repaired only after revoke;
- re-attestation opens a new generation;
- re-ingest under a new allow-listed run attaches to the reviewed correct
  canonical fixture;
- the old withdrawn fixture never becomes visible again through V2 reads;
- V1 ingest remains revoked throughout.

The automated rehearsal is:
`lib/kapiloto-v4/recovery-runbook-db.test.ts`.

## A. Immediate M2C pause

Use the pre-reviewed body:

`docs/operations/sql/kapiloto-v4-m2c-revoke-body.sql`

The production operator action is exactly:

```sql
revoke execute on function public.match_ledger_ingest_provider_fixture_v2(jsonb)
  from service_role;
```

Immediately verify:

```sql
select
  has_function_privilege(
    'service_role',
    'public.match_ledger_ingest_provider_fixture_v2(jsonb)',
    'execute'
  ) as v2_ingest_enabled,
  has_function_privilege(
    'service_role',
    'public.match_ledger_ingest_provider_fixture(jsonb)',
    'execute'
  ) as v1_ingest_enabled;
```

Required result: both `false`.

If V2 still returns `true`, stop. Do not start identity or data repair.

## B. Scope the incident before changing identity

For a suspected team:

```sql
select *
from public.provider_identity_revocation_impact(
  'sportmonks',
  'team',
  '<provider_team_id>'
);
```

For a suspected competition:

```sql
select *
from public.provider_identity_revocation_impact(
  'sportmonks',
  'competition',
  '<provider_competition_id>'
);
```

Also capture:

```sql
select * from public.provider_identity_attestation_conflicts('sportmonks');
select * from public.match_ledger_provider_ref_conflicts_v2('sportmonks');
```

Save the result with the incident record before repair. The impact report is
historical evidence and may continue to list the revoked generation after a
successful recovery.

## C. Revoke the incorrect attestation

Team:

```sql
select public.provider_identity_revoke_team(
  jsonb_build_object(
    'provider', 'sportmonks',
    'provider_team_id', '<provider_team_id>',
    'expected_team_id', '<currently_attested_canonical_uuid>',
    'reason', '<incident reason>',
    'revoked_by', '<operator>'
  )
);
```

Competition uses `public.provider_identity_revoke_competition` with
`provider_competition_id` and `expected_competition_id`.

After revoke, verify that the affected current observation is immediately absent
from the attestation-aware V2 read. Do not use this as a substitute for the
withdrawal; revoke is trust containment, not historical correction.

## D. Withdraw every bad current fixture chain

For every affected current provider/fixture chain, write a Match Ledger
withdrawal version through the Foundation 1A observation RPC using the existing
`kapiloto-match-ledger-observation-v1` withdrawal contract.

The withdrawal must preserve:
- canonical fixture id of the bad chain;
- provider = `sportmonks`;
- exact provider fixture id;
- operator/recovery ingest version;
- DB-stamped information time;
- a specific withdrawal reason.

Never DELETE the observation row.

After withdrawal, the latest provider version for that fixture must be
`observation_kind = 'withdrawal'`.

## E. Repair fixture mapping

Only after the bad chain is withdrawn, remove/re-point the provider fixture
mapping using a compare-and-set predicate that names both the expected provider
fixture id and the expected old canonical fixture id.

Example for removing the bad pointer before candidate re-resolution:

```sql
delete from public.provider_fixture_mappings
where provider = 'sportmonks'
  and provider_fixture_id = '<provider_fixture_id>'
  and fixture_id = '<expected_wrong_fixture_uuid>';
```

Require exactly one affected row. Zero rows means state changed under the
operator; stop and re-inspect. More than one is an invariant failure.

Do not delete `match_ledger_fixture_mints`. A mint is immutable audit
provenance.

## F. Repair team/competition mapping

Mapping correction and re-attestation must be separate transactions.

For a team, update the existing provider mapping to the reviewed canonical team
and keep `mapping_status = 'manual_override'`.

The Stage 0 operator override mechanism must be used; do not weaken or disable
the mapping guard.

Then re-run duplicate/canonical evidence review before attestation.

## G. Re-attest

Call `provider_identity_attest_team` or
`provider_identity_attest_competition` with fresh reviewed evidence.

Required property: the new active attestation has a new
`attestation_generation_id`. Re-attesting the same provider ref must never
rehabilitate observations sealed under the revoked generation.

## H. Create a fresh reviewed recovery run

Create a new immutable `provider_ingest_runs` row.

The run:
- uses provider `sportmonks`;
- uses the reviewed V2 ingest version;
- contains only the exact recovery fixture ids in
  `scope.provider_fixture_ids`;
- uses a reviewed mint bound;
- cannot be widened after creation.

Do not reuse the original run.

## I. Re-ingest

Re-fetch/rebuild the provider capture and call only:

`public.match_ledger_ingest_provider_fixture_v2(jsonb)`

for the reviewed recovery run.

For a wrongly minted chain, create/verify the correct canonical fixture first.
The recovery ingest must **attach** to that fixture; it must not mint another
parallel representation of the same match.

Inspect the actual persisted rows, not only the RPC return value.

## J. Recovery validation

Recovery is accepted only when all are true:

- old bad fixture latest version is a withdrawal;
- V2 as-of on the bad fixture returns no observation;
- corrected fixture has a new V2 observation sealed to the new active
  attestation generation;
- current provider fixture mapping points to the corrected fixture;
- V1 and V2 ingest privileges remain paused unless a separately reviewed M2B
  activation is intentionally performed;
- current-scope blocking identity conflicts are zero;
- current-scope provider-ref conflicts are zero;
- any `mint_without_mapping` row is understood as the withdrawn historical
  orphan and recorded for later canonical cleanup decision;
- re-ingesting the exact corrected content is idempotent (`unchanged`).

Do not declare recovery complete merely because the provider RPC returns
`recorded`.

## K. Record M2C in migration history

After the emergency revoke has already succeeded in production:

1. generate a **fresh current timestamp**;
2. create a migration under `supabase/migrations/` with that timestamp;
3. copy the reviewed M2C revoke body exactly;
4. commit/merge it immediately;
5. verify the production migration history and repository agree.

Never rename it to an older pre-reviewed timestamp. The pre-reviewed artifact is
the SQL body, not a migration version.

## Stop conditions

Stop recovery and require a new review if any of these occurs:

- M2C privilege check does not become false;
- impact report contains an unexpected provider fixture or canonical entity;
- compare-and-set fixture mapping repair affects anything other than exactly one
  expected row;
- a current active attestation exists after revoke;
- re-attestation does not create a new generation;
- recovery ingest wants to mint when a reviewed canonical fixture should exist;
- any current blocking conflict remains;
- corrected re-ingest is not idempotent;
- a production path attempts to use the V1 ingest RPC.

## Relationship to M2B

Passing this rehearsal does **not** activate M2B.

M2B remains a separate grant-only production action after:
- Winner round 264301 settlement;
- deferred identity reconciliation and full R7;
- clean readiness/conflict reports;
- A2-B amended/re-run;
- reviewed tiny-pilot run allowlist;
- this runbook rehearsal and M2C body review.
