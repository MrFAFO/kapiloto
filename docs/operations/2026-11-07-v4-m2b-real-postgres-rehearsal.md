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

## Reusable harness (PR-R)

The manual pg_cron rehearsal above is now encoded as an operator-run harness.
It can be repeated on any disposable database:

- `tools/kapiloto-v4-m2b-real-postgres-rehearsal.ts`: a thin entry point that
  turns the validated target into `pg` client connections;
- `lib/kapiloto-v4/test-support/real-postgres-rehearsal.ts`: the guards,
  experiments, cleanup and evidence.

### What it does

**Separate backends.** Each session is its own `pg` client connection: direct,
or through the Supabase session pooler on port 5432. Before an experiment
starts, the harness checks two things:

- every session pid is distinct;
- `pg_stat_activity` shows each pid with that session's own `application_name`.

No pg_cron job is created, so the M2C verification output carries no cron
noise.

**Experiments.** The harness runs P0 (preflight: record, then an unchanged
replay), A2, A4, B1, B2 and B3, each in a fresh synthetic world.

- Every competing statement starts only after the observer sees the expected
  holder or waiter in `pg_locks` / `pg_blocking_pids`.
- Polling sleeps only pace the observer.
- Every step has a bound: handshake 3 s, statement 20 s, idle-in-transaction
  60 s, whole run 5 min. V2's 5 s function `lock_timeout` stays in force; if a
  waiter hits it, the experiment is reported `inconclusive`.

**Reviewed SQL only.** M2C is always
`docs/operations/sql/kapiloto-v4-m2c-revoke-body.sql` and verification is
always `docs/operations/sql/kapiloto-v4-m2c-verify.sql`, executed verbatim. The
harness holds no copy of either file. Its only privilege change is the
simulated M2B grant, which is the exact grant-only M2B statement.

### Before any write: refusal guards

Production cannot pass these guards. The harness refuses to run in any of these
cases:

- **Runner:** it is running in CI.
- **Process environment:**
  - it holds a provider or service secret;
  - it sets PG* connection defaults;
  - the DSN is reused under another variable.
- **Target:**
  - the DSN is not the declared project's direct host or a Supabase session
    pooler on 5432;
  - the declared ref is the checkout's linked project or the application's
    configured project;
  - TLS is not verified against `KAPILOTO_REHEARSAL_PG_CA_FILE`, unless
    explicitly acknowledged as `disposable-only`.
- **Database content**, checked read-only (all must be zero):
  - auth users;
  - rounds;
  - teams, competitions, ingest runs and team attestations that the harness
    did not create.
- **Database state:**
  - a function under test (V2, V1, the identity attest/revoke RPCs, the identity
    lock helpers, the impact report, the V2 read, the information clock) does not
    match this checkout's migration text;
  - V2 and the identity RPCs no longer keep `lock_timeout=5s`;
  - ingest is not paused, or the M2C verification does not PASS;
  - an M2B migration is in the history;
  - another harness session is connected.

### Always ends paused

Once anything has been written, the run always ends with the reviewed M2C body
and a double verification PASS, whatever failed. The steps are:

1. Terminate this run's sessions.
2. Execute the M2C body.
3. Run the verification twice, at least 6.5 s apart.

### Evidence

The evidence is JSON: guards, function hashes, per-experiment backend pids,
timed steps, lock snapshots, SQLSTATEs, verification runs, and the cleanup
result. It is redacted: no DSN, password, host, project ref or key. Only a
SHA-256 of the ref is recorded.

### Running it

Use a freshly migrated disposable project: seed migrations omitted, no other
data. The project used for the manual rehearsal above holds unprefixed
synthetic rows, so the harness refuses it by design.

Run from a clean shell. First do a read-only check:

```bash
env -i PATH="$PATH" HOME="$HOME" \
  KAPILOTO_REHEARSAL_DATABASE_URL='postgres://postgres.<ref>:<password>@<region>.pooler.supabase.com:5432/postgres' \
  KAPILOTO_REHEARSAL_PROJECT_REF='<ref>' \
  KAPILOTO_REHEARSAL_PG_CA_FILE='./supabase-ca.crt' \
  npm run rehearsal:v4-m2b-real-postgres -- --check-only
```

Then repeat without `--check-only`, adding
`--out artifacts/kapiloto-v4-m2b-rehearsal/<date>.json`. Exit codes:

- `0`: pass or checked;
- `1`: fail or inconclusive;
- `2`: refused.

### Status

The harness is unit-tested offline in
`lib/kapiloto-v4/real-postgres-rehearsal.test.ts`. The tests use PGlite and
cover:

- the target guards;
- redaction;
- the reviewed SQL source;
- function identity against the migration chain;
- the synthetic world recording through V2's existing-mapping path;
- a single-backend database failing closed and being returned to the paused
  state.

It is pinned by `lib/kapiloto-v4/boundaries.test.ts`.

**The reusable harness's own first real multi-backend run has still not been
recorded.** On 2026-11-08 neither of its connection paths was usable from the
operator machine. The same experiments were therefore run live through the
pg_cron fallback below, which reproduces their evidence. Attach a harness run
here before treating the harness itself as rehearsed.

## 2026-11-08 live multi-backend run (pg_cron fallback)

Environment: disposable Supabase Free project `kapiloto-m2b-harness-20261107`
(eu-central-1, PostgreSQL 17.11). It is freshly migrated (40 migrations, none
named M2B) and holds synthetic data only. The run was operator-initiated. Its
time window was 2026-11-08T00:30:58Z – 00:43:40Z.

**Outcome: PASS.** P0, A2, A4, B1, B2 and B3 all passed:

| Experiment | Outcome | Assertions |
|---|---|---|
| P0 | pass | 10/10 |
| A2 | pass | 19/19 |
| A4 | pass | 18/18 |
| B1 | pass | 19/19 |
| B2 | pass | 14/14 |
| B3 | pass | 10/10 |

All 30 pre-write guards passed. Cleanup left ingest paused and verified twice.

### Why the fallback, not the harness

- **Direct connection:** `db.<ref>.supabase.co` publishes only an AAAA record,
  and the operator machine has no IPv6 default route. A plain TCP connect fails
  immediately with `ENETUNREACH`. The harness guards were not loosened to work
  around this.
- **Session pooler:** the project's tenant lives on
  `aws-1-eu-central-1.pooler.supabase.com:5432`. That host answers a startup
  message for `postgres.<ref>` with a SASL request, while `aws-0` answers "tenant
  not found". TLS verify-full against Supabase Root 2021 CA succeeds. The
  current database password was not available to the operator session, so the
  operator chose the pg_cron fallback instead. The earlier Supavisor
  "password authentication failed" was therefore not re-tested. A password
  rotation was not shown to be necessary.

### How the fallback works

- **Controller.** The controller reaches the database only through the
  Supabase CLI's Management API query endpoint, pinned to the disposable
  project ref. It runs from an empty work directory; the CLI's own cache names
  only the disposable project. Every write script begins with a guard that
  raises unless all of the following are zero, so production cannot pass:
  - auth users;
  - rounds;
  - non-rehearsal teams, competitions, runs and team attestations;
  - M2B migrations.
- **Sessions.** Every session (the observer/driver O and actors A, B, C, N1,
  N2, R) is a one-shot pg_cron job (libpq mode). All of an experiment's jobs
  start at the same minute boundary. Two independent records show they are
  separate PostgreSQL backends:
  - each experiment's pids are distinct, and `pg_stat_activity` shows each pid
    with its own `application_name`;
  - `cron.job_run_details.job_pid` matches every session's pid (every run
    `succeeded`).
- **Interleavings use observed lock state only.**
  - Each actor holds a session advisory id lock, which is how the driver maps
    actor names to pids.
  - The driver holds an exclusive gate lock for each step, then a READY lock.
  - Actors wait until READY appears in `pg_locks`, then block on each gate.
  - Every handshake polls the harness's `LOCK_SNAPSHOT_SQL` (`pg_locks` and
    `pg_blocking_pids`) until the expected holder or waiter appears, with a 3 s
    bound. Sleeps only pace those polls.
- **Reused harness pieces.** Synthetic worlds are created by the harness's own
  `createRehearsalWorld`. Guards and observer reads are the harness's SQL text,
  extracted from its source at run time.
- **Reviewed SQL only.**
  - M2C is always `docs/operations/sql/kapiloto-v4-m2c-revoke-body.sql`, and
    verification is always `docs/operations/sql/kapiloto-v4-m2c-verify.sql`,
    both executed verbatim. The installed copies were compared byte-for-byte
    with the files.
  - The only privilege change is the harness's `SIMULATED_M2B_GRANT`.
- **Pre-run change (operator-approved).** The migrations had created two
  pg_cron jobs in the disposable project that `net.http_post` to production
  endpoints: `kapiloto-live-sync-every-2-min` and
  `kapiloto-research-worker-every-2-min`. Both were gated off (0 rounds, 0
  research runs, no pg_net responses). They were unscheduled before any
  rehearsal write. Their vault secrets were generated inside the project by
  those migrations (`gen_random_bytes(32)`); they were not read or changed.

### Results (run tag 910373)

- **P0.** A `service_role` V2 call recorded through the existing mapping under
  the world's attestation generations. An identical replay on a separate
  backend returned `unchanged`.
- **A2.** M2C ran while a V2 call was already inside the function.
  - C held the canonical team-pair lock. A's V2 call held the identity
    `ShareLock` (granted) and waited for the pair lock behind C
    (`pg_blocking_pids` = C).
  - The M2C body committed in 32 ms on backend B (00:35:00.592–.624Z) while A
    was still inside V2. EXECUTE was then false for both V2 and V1.
  - The verification at 00:35:00.661Z FAILED with exactly two problems: the
    rehearsal's own `kapiloto_rehearsal.actor` wrapper, and
    `backend <A> still holds the Sportmonks provider-identity ShareLock`. It
    reported no ACL, cron or activity problem.
  - After C committed, A's in-flight call completed `recorded` (00:35:00.99Z).
  - Two brand-new backends then got SQLSTATE `42501`
    (`permission denied for function match_ledger_ingest_provider_fixture_v2`).
  - Once the wrapper was dropped, the verification PASSED twice, 11.3 s apart.
- **A4 (M-1).** M2C ran while a V2 call waited at the identity boundary.
  - C held the identity lock EXCLUSIVE. A waited for the identity `ShareLock`
    (not granted, blocked by C).
  - After the M2C body committed (EXECUTE false/false), the verification
    FAILED: wrapper plus
    `backend <A> is waiting for the Sportmonks provider-identity ShareLock`.
  - C released the lock; A completed `recorded`. New backends got `42501`.
  - The verification then PASSED twice, 11.7 s apart.
- **B1.** A's open V2 transaction held the identity `ShareLock`.
  - B's `provider_identity_revoke_team` queued for the identity lock EXCLUSIVE
    (blocked by A, no `backend_xid`). The team trust state was unchanged while
    it waited (events 1, projection 1).
  - After 5,004 ms the revoke failed with SQLSTATE `55P03`
    (`canceling statement due to lock timeout`). Its context was
    `pg_advisory_xact_lock` in `private.lock_provider_identity(text,boolean)`
    via `private.provider_identity_begin_change`. It wrote no event and left the
    projection.
  - After A committed:
    - the trusted V2 read returned A's observation;
    - the impact report showed it under the active generation.
  - The retry on a new backend returned `revoked`. The impact report then
    showed A's observation as latest under the revoked generation, and the V2
    read returned `NULL`.
- **B2.** The impact report taken before the barrier could not see A's
  uncommitted observation.
  - B's revoke queued behind A, then completed `revoked` once A committed.
  - A's observation was first seen at 00:41:00.127576Z, before the revoke event
    was recorded at 00:41:00.228614Z.
  - The impact report shows it latest under the revoked generation, and the V2
    read returned `NULL`.
- **B3.** B's revoke executed and its open transaction held the identity lock
  EXCLUSIVE. A's V2 call queued for the `ShareLock` behind B.
  - After B committed, A returned `quarantined` / `team_attestation_missing`.
  - Footprint: 0 observations, exactly 1 new quarantined ingest item, no active
    projection.

### Cleanup and final state

Cleanup ran in this order:

1. All rehearsal jobs were unscheduled.
2. The `kapiloto_rehearsal` schema was dropped.
3. The reviewed M2C body ran.
4. The verification PASSED twice, at 00:43:20.75Z and 00:43:32.54Z.

A separate read-only check afterwards confirmed the paused state:

- **Privileges:**
  - `service_role` can execute neither V2 nor V1;
  - `anon` and `authenticated` cannot execute V2.
- **Fallback leftovers:**
  - no fallback schema;
  - 0 cron jobs;
  - 0 rehearsal sessions;
  - 0 identity locks.
- **Verification:** the reviewed verify file passes.
- **Unchanged guard counts:**
  - 0 auth users;
  - 0 rounds;
  - 0 M2B migrations;
  - 0 pg_net responses.

The synthetic rows remain: 12 prefixed teams, 6 marked runs and 5
observations. They carry the harness's own prefix and run marker, so they do
not block a later harness run on this project.

### Evidence

Evidence lives in `docs/operations/evidence/2026-11-08-v4-m2b-pgcron-fallback/`:

- **`evidence.json`** — guards, function identity, per-experiment pids, cron
  run records, handshake snapshots, actor results with SQLSTATEs and context,
  verification runs, and cleanup.
  - SHA-256 `87899adcf1fb6460d4af04ae11ea8d5242bf8ae297e38c49c4e0e961dff9493a`
    (LF line endings).
  - It contains no DSN, password, host, project ref, key or vault value; only a
    SHA-256 of the ref is recorded.
- **`install.sql`** — the fallback's database objects, with
  `sql_sources.install` = `524c794e…`.
- **`controller.ts.txt`** — the controller as run, with its two project-ref
  string constants replaced by `"<disposable-project-ref>"` and
  `"<production-project-ref>"` (SHA-256 `8e71987f…`). Putting the two refs
  back reproduces `sql_sources.controller_run_ts` = `5c875c88…`. It is stored
  as text: it is not part of the build, and it imports the harness from the
  session worktree layout.

### How the fallback differs from the harness

- **One transaction per session.** Each session runs in one pg_cron
  transaction. The results it records become visible only when it commits, and
  every result is evaluated after the driver finishes.
- **C ends by committing, not rolling back.** In A4, C commits instead of
  rolling back. C writes nothing, so either way only releases the identity
  lock.
- **Retries and fresh calls use new backends.**
  - B1's retry is a new backend, not the same session.
  - "New V2 call after M2C" is shown on two brand-new backends. The harness also
    retries on the session whose earlier call completed.
- **The wrapper is visible to the verification.** The fallback's actor
  function calls V2 by name, so the verification during A2/A4 also lists it. It
  is dropped before every PASS run. It is not hidden from the verifier.
- **The M2C body runs inside the M2C actor's transaction.** That transaction
  otherwise only waits for its gate and records its result. Cleanup's M2C ran
  alone, through the Management API.

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

**Real PostgreSQL rehearsal gate: PASS WITH THE PR-R FIXES.** The 2026-11-08
pg_cron fallback run reproduced P0, A2, A4, B1, B2 and B3 live on separate
backends and passed.

**Reusable harness live run: still owed.** It needs a direct connection from
an IPv6-capable network, or the session pooler with the disposable project's
current database password.

**M2B production activation: still NO-GO** until H-2, H-3, the reviewed
allowlist/runtime assertions and the separate grant-only migration are closed.
