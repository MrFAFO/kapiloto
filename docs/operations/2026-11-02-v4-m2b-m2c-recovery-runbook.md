# Kapiloto V4 — M2B/M2C Recovery Runbook

Status: **pre-activation runbook; rehearsed on synthetic data (D-061)**  
Scope: Sportmonks V4 Match Ledger tiny pilot and later staged backfills  
Related: D-058, D-060, D-061, M2A/M2B/M2C

## Purpose

This runbook is the operator procedure for stopping V2 provider ingest and
for recovering from a team or competition identity mistake without deleting
historical Match Ledger evidence.

It keeps three actions separate:

1. **M2C pause.** Stop new provider ingest immediately (privilege revoke only).
2. **Trust and fixture recovery.**
   1. Revoke the bad trust and withdraw every affected chain.
   2. Repair the fixture and mapping.
   3. Re-attest, then re-ingest under a new reviewed run.
3. **Migration bookkeeping.** Record the M2C revoke that was already applied
   in migration history, under a fresh timestamp.

M2C itself never mutates identity, mapping, fixture or Match Ledger data.

## Execution model

- **Operator SQL.** Operators run SQL in the Supabase SQL editor as the
  database owner role.
  - One pasted execution is one transaction.
  - Every write step uses a reviewed file in `docs/operations/sql/`, pasted
    verbatim. The rehearsal (`lib/kapiloto-v4/recovery-runbook-db.test.ts`)
    executes the same files.
  - Each template reads `kapiloto_recovery.*` parameters. Set them in the same
    execution, immediately before the template:

    ```sql
    select set_config('kapiloto_recovery.provider_fixture_id', '<id>', true),
           set_config('kapiloto_recovery.fixture_id', '<uuid>', true);
    -- then paste the template body
    ```

- **What the templates check.** Every write template does three things:
  - It takes the same locks as V2 ingest, in the same order.
  - It re-checks the reviewed state under those locks (compare-and-set). A
    mismatch raises, and the execution rolls back.
  - It is idempotent: once a step is done, re-running it reports
    "nothing changed".
- **Separate executions for identity changes.** An attest or revoke call
  (`provider_identity_*`) must be its own execution. It must be the first write
  of its transaction (`provider_identity_begin_change`), so it is never batched
  with a mapping correction.
- **Who runs ingest.**
  - Production ingest runs only as `service_role` through the PostgREST RPC.
  - It never runs as the owner. The owner keeps EXECUTE whatever M2C does.
  - The recovery re-ingest (§I) is the one owner-run ingest, and it is
    deliberate.
- **Why no recovery RPC.** Recovery deliberately adds no RPC or migration:
  - A service_role-callable recovery RPC would let application code unmap or
    relabel fixtures.
  - The templates keep that capability with operators.
  - The hard invariants are already enforced by 1A and V2 (§Guarantees), so a
    misused template still cannot create a duplicate live chain.

## Non-negotiable rules

- Never re-enable the V1 ingest RPC.
- Never delete or rewrite Match Ledger observation history, attestation
  events, fixture mints or ingest runs.
- Never create a parallel canonical fixture by hand for a chain that V2
  minted. Correct the minted fixture in place (§E1).
- A wrong identity is repaired as revoke, then mapping correction, then
  re-attest, each in a separate execution.
- A wrong observation chain is retracted with a new **withdrawal version**.
  Every chain sealed under a revoked generation is withdrawn before it is
  re-ingested.
- Every recovery re-ingest uses a **new immutable run**. Its
  `scope.provider_fixture_ids` allowlist names exactly the recovered fixtures.
- Do not commit a timestamped M2C migration before it is needed. A normal
  Supabase migration push must never pause ingest by accident.

## Incident classes

| Class | What is wrong | Revoke? | Fixture repair |
|---|---|---|---|
| I1 | A provider team is attested and mapped to the wrong canonical team | yes, the team | §E1 (in place), else §E2/§E3 |
| I2 | A provider league is attested and mapped to the wrong canonical competition | yes, the competition | §E1 (in place); a duplicate is a stop condition |
| I3 | The provider's data for one fixture is wrong; identity is right | **no** | withdraw with `trust = trusted`, or let the next provider version supersede it |

**Revoke blast radius.**

- Revoking a generation makes every observation sealed under it untrusted,
  permanently.
- Re-attesting the same canonical id still leaves those observations
  `attestation_generation_stale`. Each must be withdrawn and re-ingested.
- So never revoke a correct attestation as a precaution. M2C is the
  precaution.

## A. Immediate M2C pause

1. Execute `docs/operations/sql/kapiloto-v4-m2c-revoke-body.sql` **alone**.
   - It revokes EXECUTE on both provider ingest RPCs (V2 and the frozen V1)
     from `public, anon, authenticated, service_role`.
   - In the expected state only the service_role grant on V2 exists; the other
     revokes are no-ops.
   - Executing it alone matters: an error later in the same execution would
     roll the revoke back.
2. Execute `docs/operations/sql/kapiloto-v4-m2c-verify.sql` as a separate
   execution. Re-run it until it reports PASS. It fails while any of these
   holds:
   - either ingest RPC is owned by anything other than the reviewed Supabase
     operator roles (`postgres` or `supabase_admin`);
   - any non-operator role can execute either RPC, including through role
     membership, PUBLIC or an explicit/default grant;
   - a SECURITY DEFINER function or a pg_cron job calls either RPC (both run
     as their owner and would bypass the revoke);
   - the Sportmonks provider-identity `ShareLock` is still held by any backend
     (the authoritative V2-ingest drain signal), or pg_stat_activity still
     shows an ingest call.

**In-flight semantics.**

- PostgreSQL checks EXECUTE once per call, when the call starts. A call
  already running when the revoke commits finishes, and may commit.
- Every later call is refused, including a statement prepared before M2C.
- So at most the calls already in flight (one fixture each) land after M2C.
  The verification's drain check shows when they are done.
- The identity revoke in §C is the real barrier. It takes the provider
  identity lock exclusive, which waits for every in-flight V2 ingest (they
  hold it shared). Any ingest that starts after that sees no active
  attestation and quarantines.
- That is why the impact report run after §C is the authoritative scope.

Do not start identity or data repair until the verification passes.

## B. Scope the incident before changing identity

```sql
select * from public.provider_identity_revocation_impact('sportmonks', 'team', '<provider_team_id>');
-- or ('sportmonks', 'competition', '<provider_competition_id>')
select * from public.provider_identity_attestation_conflicts('sportmonks');
select * from public.match_ledger_provider_ref_conflicts_v2('sportmonks');
```

Also run `docs/operations/sql/kapiloto-v4-recovery-affected-forecasts.sql`. It
lists Prediction Registry snapshots whose frozen inputs used affected
observations. Those snapshots stay valid immutable records and replay without
re-reading. Record them so their evaluation can be annotated or excluded.

Save every result with the incident record.

## C. Revoke the incorrect attestation (the barrier)

```sql
select public.provider_identity_revoke_team(jsonb_build_object(
  'provider', 'sportmonks',
  'provider_team_id', '<provider_team_id>',
  'expected_team_id', '<currently attested canonical uuid>',
  'reason', '<incident ref>: <reason>',
  'revoked_by', '<operator>'));
```

A competition uses `public.provider_identity_revoke_competition` with
`provider_competition_id` and `expected_competition_id`. Both RPCs stay
executable by service_role under M2C.

**If the revoke reports that the ref has no active attestation:**

- Check `private.provider_team_identity_attestation_events` (or the
  competition table) for the generation's `revoke` event.
- If it is there, the revoke already happened; continue.

**Then re-run the impact report.** That output is the authoritative list. For
every `observation_under_generation` row, record:

- `observation_id` and `fixture_id`;
- `provider_fixture_id`;
- `is_latest_version`.

All of those chains are now invisible to V2 reads (`generation_revoked`). Every
chain whose latest version is that observation must be withdrawn in §D. That
means all chains under the generation, not only the one that triggered the
incident.

## D. Withdraw every affected chain

For each chain, run `docs/operations/sql/kapiloto-v4-recovery-withdraw-chain.sql`
with these parameters:

- `incident_ref`;
- `fixture_id`;
- `provider_fixture_id`;
- `observation_id` (from the authoritative impact report);
- `trust = untrusted`;
- a specific `reason`.

Under the 1A provider-fixture and fixture/provider locks, the template refuses
when:

- the chain no longer ends in the reviewed observation;
- the observation is still trusted (revoke first).

It then appends a 1A withdrawal version (`capture_mode = manual_import`,
`ingest_version = kapiloto-v4-recovery-runbook-v1`, DB-stamped information
time). Nothing is deleted. An already withdrawn chain reports "already
withdrawn".

**Why a withdrawal, not just a new observation version.**

- An identical re-ingest under a new generation is quarantined as
  `attestation_generation_stale`.
- A chain that must move to another canonical fixture can only do so once its
  old chain is withdrawn. 1A refuses a second live chain for one provider
  fixture id.
- Old versions stay in the table for audit and strict as-of replay. V2 reads
  never surface them again, because they are sealed to the revoked
  generation.

## E. Repair the canonical fixture

Decide per chain:

**E1 — the chain minted its fixture** (`fixture_mint` row in the impact
report). This is the default.

- Run `docs/operations/sql/kapiloto-v4-recovery-correct-minted-fixture.sql`.
  It changes only that row's competition/home/away to the reviewed identity.
  - The new values are side-preserving: the provider home side stays home.
  - Kickoff, status and provider-side scores stay as minted.
  - The provider fixture mapping and the mint row stay. The re-ingest then
    validates the mapping as the unique candidate (`existing_mapping`).
- The template refuses unless all of these hold:
  - the row still has the reviewed old identity;
  - it was minted by this provider fixture id;
  - nothing but this provider fixture's mapping, its immutable
    `provider_ingest_items` audit rows for the same Sportmonks fixture id,
    and the V4 ledger references it; the template scans every foreign key to
    `fixtures` and separately checks the soft `provider_ingest_items.fixture_id`
    reference;
  - every ledger chain on it is withdrawn;
  - no other canonical fixture already represents the corrected match.
- Why in place:
  - One mint per provider fixture id is final (A2-A), so the corrected chain
    has to land on this row.
  - A hand-made parallel fixture would leave a phantom finished match in V3's
    `fixtures`.
  - For a competition correction, that orphan (same teams and kickoff, other
    competition) blocks every re-ingest (`fixture_competition_conflict`). That
    makes the incident unrecoverable without a canonical merge.

**E2 — the chain attached to the canonical fixture of a different real
match.**

- Leave that fixture untouched.
- Run `docs/operations/sql/kapiloto-v4-recovery-unmap-provider-fixture.sql`.
  It deletes exactly the one mapping row that names both the provider fixture
  id and the reviewed fixture, and only after that chain is withdrawn.
- The re-ingest then resolves the corrected identity normally (attach, or a
  mint: no mint exists for this provider fixture id).

**E3 — the chain minted a fixture, but another canonical fixture already
represents the real match** (the §E1 template refuses with "already represent
the corrected match").

- **Team incidents (I1):**
  - Unmap as in §E2. The re-ingest attaches to the existing fixture.
  - The minted row stays as a withdrawn orphan, reported as
    `mint_without_mapping`.
  - Record it for a later canonical cleanup decision: it is a phantom row in
    `fixtures`.
- **Competition incidents (I2): stop.** The orphan would block the re-ingest.
  Resolving it needs a separately reviewed canonical fixture merge.

Never delete `match_ledger_fixture_mints` rows or ledger rows.

## F. Correct the team/competition mapping

Run `docs/operations/sql/kapiloto-v4-recovery-correct-identity-mapping.sql`
with these parameters:

- `entity_kind`;
- `provider_ref`;
- `expected_canonical_id`;
- `canonical_id`.

It runs as its own execution:

- It takes the provider identity lock exclusive first, as attest and revoke
  do.
- It refuses while the ref is still actively attested, and unless the mapping
  still names the reviewed old id.
- It sets the reviewed canonical id and `manual_override` through the D-057
  operator opt-in.

Then re-run the duplicate/canonical evidence review for the attestation
evidence.

## G. Re-attest

Call `provider_identity_attest_team` or `provider_identity_attest_competition`
with fresh reviewed evidence, as its own execution.

- The new active attestation must have a **new** `attestation_generation_id`.
- The event history stays append-only:
  1. attest (old generation);
  2. revoke (old generation, with reason);
  3. attest (new generation).
- Re-attesting, and later evidence refreshes of the new generation, never
  rehabilitate observations sealed under the revoked generation. They stay
  `attestation_generation_stale`.

## H. Create a fresh recovery run

Insert a new immutable `provider_ingest_runs` row (built with
`buildProviderIngestRunRow`):

- `provider = 'sportmonks'`, `purpose = 'backfill'`;
- the reviewed V2 ingest version;
- `scope.provider_fixture_ids`: exactly the recovered provider fixture ids;
- `scope.recovery`: `incident_ref`, `revoked_attestation_generation_ids`,
  `withdrawn_observation_ids` (audit only; V2 reads only the allowlist);
- `fixture_mint_kickoff_before = null`.

The payloads use `fixture_mint.allowed = false` unless a reviewed §E2 chain
needs a mint. Do not reuse the original run. Reusing a provider fixture id in a
new run is safe: runs never own fixture ids.

## I. Re-ingest

Rebuild the provider capture into a V2 payload
(`buildProviderMatchObservationPayload`) with the recovery `run_id`. Call
**only** `public.match_ledger_ingest_provider_fixture_v2(jsonb)`.

**Under M2C**, the operator calls it as the owner. `service_role` stays paused,
and nothing re-enables the pipeline. **Resuming service_role ingest** is a new,
separately reviewed grant-only migration after recovery review; it is never
done by deleting the M2C migration.

Inspect the persisted rows, not only the RPC return value. Then re-run the
exact payload: it must return `unchanged`.

## J. Validation

Recovery is accepted only when all of these hold:

- `docs/operations/sql/kapiloto-v4-recovery-verify-chain.sql` passes for every
  recovered provider fixture id. It checks:
  - the mapping points to the reviewed fixture;
  - exactly one live chain exists, on that fixture;
  - that chain is trusted and visible to the V2 as-of read;
  - every other chain that carried the id ends in a withdrawal and is
    invisible;
  - there is no current-version provider-ref conflict.
- `provider_identity_attestation_conflicts('sportmonks')` has:
  - no `blocking` row;
  - no `warning` row except a recorded §E3 orphan (`mint_without_mapping`).
- `match_ledger_provider_ref_conflicts_v2('sportmonks')` has no
  `is_current_version` row. Historical rows of withdrawn versions remain by
  design: `*_attestation_generation_stale`, `*_attested_canonical_drift` and
  `fixture_competition_drift`. Filtering on the current version is enough,
  because a chain counts as current only through its latest version, and a
  withdrawn chain has none.
- The impact report still lists the revoked generation; it is historical
  evidence.
- The affected-forecasts report is attached to the incident record.
- `kapiloto-v4-m2c-verify.sql` still passes, unless a separately reviewed
  re-activation was intentionally applied.

Do not declare recovery complete merely because the provider RPC returns
`recorded`.

## K. Record M2C in migration history

M2C executes as an operator statement first, because speed matters. It must
then reach migration history, so that a database rebuilt from migrations is
paused too:

1. Generate a **fresh current timestamp**, later than every applied version.
2. Create `supabase/migrations/<timestamp>_kapiloto_v4_m2c_pause_provider_ingest.sql`
   containing the reviewed body byte for byte.
3. Record that version as applied in production, using the same mechanism PR
   #43 used:
   - apply it through the Supabase migration tool, which re-runs the
     idempotent revoke and records the version; or
   - mark it applied with `supabase migration repair --status applied <version>`.
4. Commit and merge the file under the version production recorded (rename
   it if the tool chose the timestamp).
5. Verify that `supabase_migrations.schema_migrations` and the repository
   agree, and that the boundaries test pins the new migration.

If the Supabase migration tool is available in the emergency, applying the
body through it (step 3) can replace the raw execution. It executes and
records in one step, so there is no history gap.

Never rename the migration to an older timestamp. Never re-activate by
deleting or reverting the M2C migration: re-activation is a new grant-only
migration.

## Resumability

| Step | Re-run after success | After a failure |
|---|---|---|
| A M2C body | no-op | nothing applied; re-run |
| C revoke | refuses ("no active attestation"); confirm the revoke event and continue | nothing applied |
| D withdraw | "already withdrawn" | nothing applied (single transaction) |
| E1 correct fixture | "already carries the corrected identity" | nothing applied |
| E2/E3 unmap | "has no fixture mapping"; refuses if the id already points elsewhere, so it can never undo a recovery | nothing applied |
| F mapping | "already mapped" | nothing applied |
| G attest | `unchanged` for identical evidence | nothing applied |
| I re-ingest | `unchanged` | quarantine or exception; nothing written |

A step run out of order fails closed:

- the fixture correction refuses a live chain;
- the unmap refuses an un-withdrawn chain;
- the mapping correction refuses an active attestation;
- an early re-ingest quarantines `team_attestation_missing`.

A raw unmap without a withdrawal makes the re-ingest raise and roll back,
because 1A allows only one live chain per provider fixture id. All of these
are rehearsed.

## Stop conditions

Stop and require a new review if any of these occurs:

- the M2C verification does not pass;
- the impact report contains an unexpected provider fixture or canonical
  entity;
- any template refuses, other than an expected "nothing changed";
- a current active attestation exists after revoke;
- re-attestation does not create a new generation;
- an I2 chain hits §E3 (a duplicate canonical fixture for the corrected
  competition);
- the recovery ingest wants to mint where §E1 or an existing fixture applies;
- any current blocking conflict remains;
- the corrected re-ingest is not idempotent;
- a production path attempts to use the V1 ingest RPC.

## Guarantees (enforced in the database, not by this runbook)

- **One live chain per provider fixture id.** 1A refuses a new observation
  while another fixture's latest version for that id is an observation.
- **Mints are final.** One mint per provider fixture id. Mint rows, runs,
  ledger rows, attestation events and observation sidecars are immutable.
- **Trust is sealed.** Each V2 observation names its attestation events and
  generations. V2 reads trust it only while those generations are current and
  the `manual_override` mappings agree. A revoked generation is never current
  again.
- **Runs are bounded.** V2 ingest refuses any fixture outside the run's
  immutable allowlist.

## Rehearsal coverage

- `lib/kapiloto-v4/m2c-pause-db.test.ts`:
  - the body text;
  - a simulated M2B grant paused with zero data change (content digest of
    every touched table);
  - the verification failing on each open path, owner drift, and inherited
    role privilege;
  - advisory-lock drain, in-flight and prepared-statement semantics.
- `lib/kapiloto-v4/recovery-runbook-db.test.ts`:
  - the end-to-end I1 rehearsal (two chains, in-place correction, service_role
    paused throughout);
  - I2 in place, plus the superseded parallel-fixture path and foreign soft
    ingest-audit reference shown blocked;
  - I1 §E3 orphan;
  - I3 trusted withdrawal without a revoke;
  - out-of-order failure and resume;
  - the affected-forecasts report.
- `lib/kapiloto-v4/boundaries.test.ts`:
  - only the reviewed migrations touch ingest privileges;
  - V2 is never granted;
  - this SQL stays out of `supabase/migrations` and contains no DDL.

PGlite runs one backend. Concurrent interleavings rest on PostgreSQL's
per-call EXECUTE check and lock conflict tables. The tests prove which locks
are held, not that a second session waits.

## Relationship to M2B

Passing this rehearsal does **not** activate M2B. M2B remains a separate
grant-only production action after all of these:

- Winner round 264301 settlement;
- deferred identity reconciliation and full R7;
- clean readiness/conflict reports;
- A2-B amended and re-run;
- a reviewed tiny-pilot run allowlist;
- review of this runbook, the M2C body and its verification.
