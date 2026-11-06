# Kapiloto V4 — M2B real PostgreSQL rehearsal evidence

Date: 2026-11-07 (Israel) / 2026-11-06 UTC  
Scope: D-058 / D-061 pre-activation concurrency and recovery-barrier evidence  
Environment: disposable Supabase Free project, PostgreSQL 17, synthetic data only

## Safety boundary

- Production was not used for any write or concurrency experiment.
- The disposable project was loaded with the Kapiloto schema needed by V4. Historical production-specific seed migrations were intentionally omitted.
- No production rows, keys or provider captures were copied into the rehearsal database.
- The simulated M2B grant was made only in the disposable project.
- At the end of the rehearsal both V1 and V2 provider-ingest RPCs were revoked from `service_role`.

The rehearsal used `pg_cron` only as a way to obtain genuinely separate
PostgreSQL backends inside the disposable Supabase project. A probe recorded
different backend PIDs for concurrent jobs, so this is not the single-backend
PGlite model.

## Preconditions

The synthetic world contained:

- one synthetic competition;
- two synthetic teams;
- one finished canonical fixture with a Sportmonks fixture mapping;
- manual-override competition/team mappings;
- active V4 team and competition attestations;
- one immutable provider-ingest run whose
  `scope.provider_fixture_ids` contained exactly the synthetic fixture id.

A direct call as `service_role` succeeded before the concurrency experiments,
proving that the synthetic V2 payload and trust state were valid.

The current M2C verification SQL also ran successfully against Supabase's real
role set while ingest was paused. This clears the role-set uncertainty from
M-3.

## A2 — M2C while V2 is already inside the function

A clean one-shot run coordinated four PostgreSQL backends:

1. C took the unordered canonical team-pair advisory lock.
2. A started V2 as `service_role`.
3. O captured locks after A had passed EXECUTE and the provider-identity gate.
4. B ran the exact M2C revoke body.

Observer evidence at `2026-11-06T23:53:45.167435Z`:

- backend `50641`: provider-identity `ShareLock` **granted**;
- backend `50641`: team-pair `ExclusiveLock` **waiting**;
- backend `50642`: team-pair `ExclusiveLock` **granted**;
- `pg_blocking_pids(50641) = {50642}`.

M2C evidence at `2026-11-06T23:53:45.673790Z`:

- V2 executable by `service_role`: `false`;
- V1 executable by `service_role`: `false`.

The already-running V2 call then completed at
`2026-11-06T23:53:48.184197Z` with `status = unchanged` and the same
observation version. A fresh V2 call started after a completed M2C was also
tested separately and failed with SQLSTATE `42501` (permission denied).

This proves the intended boundary: revoking EXECUTE does not abort a call that
already passed its EXECUTE check; new calls are denied, and drain must be
verified using the provider-identity lock rather than privileges alone.

## A4 / M-1 — waiting ShareLock is visible to the fixed verifier

C held the provider-identity lock exclusive while A called V2 as
`service_role`. The fixed verifier from this PR ran on another backend.

GitHub/Supabase job evidence (run ids 593 and 594) reported:

> backend 50656 is waiting for the Sportmonks provider-identity ShareLock; a V2
> ingest call already passed its EXECUTE check and is waiting at the identity
> boundary

The same verification also reported the intentionally open M2B grant and the
temporary rehearsal cron caller. Those additional failures were expected.

This directly proves M-1: filtering only `pg_locks.granted = true` misses a
V2 caller that already passed EXECUTE but is waiting to acquire the shared
provider-identity lock.

## B1 — revoke times out cleanly behind an in-flight ingest

A V2 transaction held the provider-identity `ShareLock` on backend `49877`.
A team revoke was attempted while that transaction intentionally stayed open.

Result:

- revoke failed with SQLSTATE `55P03`;
- context: `pg_advisory_xact_lock` inside
  `private.lock_provider_identity(..., true)`;
- no new revoke event was written by the failed attempt;
- the active attestation projection remained present.

This proves the runbook must treat `55P03` as a clean failed revoke attempt,
wait for drain, and retry. Increasing the revoke timeout is not the recovery
procedure.

## B2 — queued revoke completes after ingest commits

A called V2 under active attestation generation
`fadf2862-ac24-4849-a1b9-89ab4e937cdf` and held the transaction open.
B started the revoke one second later.

Evidence:

- A result: `status = unchanged`, attempt 7;
- B result: `status = revoked`;
- revoke event version: 4;
- revoke `recorded_at = 2026-11-06T23:50:37.745231Z`.

The impact report then marked the latest observation under that generation as
`generation_state = revoked` and `is_latest_version = true`.
`match_ledger_observation_as_of_v2(...)` returned SQL `NULL`, so the revoked
generation was no longer visible through the trusted V2 read.

## B3 — revoke first, then ingest fails closed

B revoked the next active team generation and deliberately held its
transaction open. A started V2 after the revoke had executed but before B
committed, so A waited at the provider-identity barrier.

After B committed:

- B result: `status = revoked`, attestation version 6;
- A result: `status = quarantined`;
- A reason: `team_attestation_missing`;
- no active attestation projection remained.

This proves the exclusive identity-revoke lock is the barrier: a V2 caller
queued behind the revoke re-reads trust after the barrier and fails closed.

## Double-PASS drain verification

With ingest paused and all rehearsal sessions drained, the fixed M2C verify
file was executed twice with a six-second interval. Neither execution raised
an error.

The six-second interval is deliberately longer than V2's five-second
`lock_timeout` and is now part of the runbook.

## Remaining limits

This rehearsal intentionally does **not** claim more than it proved:

- A1's second V2 call inside a transaction that was already open before M2C was
  not separately characterized on real PostgreSQL. Safety does not depend on
  that result; the drain lock is authoritative.
- The optional PostgREST/JWT experiment A3 was not run.
- No provider capture, production run, production grant or production Match
  Ledger write occurred.
- H-2 remains open: production still needs a reviewed explicit-fixture capture
  path plus an operator runner.
- H-3 remains open: production migration auto-deploy/apply behaviour must be
  confirmed before the M2B grant migration exists on main.
- The tiny-pilot allowlist must be re-checked immediately before activation.

## Verdict

**Real PostgreSQL rehearsal gate: PASS WITH THE PR-R FIXES.**

**M2B production activation: still NO-GO** until H-2, H-3, the reviewed
allowlist/runtime assertions and the separate grant-only migration are closed.
