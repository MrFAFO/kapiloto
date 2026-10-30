# Kapiloto V4 Foundation 1E-A2-A: provider-native Match Ledger ingest

Decision: D-056. Migration: `supabase/migrations/20261030101247_kapiloto_v4_provider_ingest.sql`.
Code: `lib/kapiloto-v4/provider-ingest.ts`, `sportmonks-ledger.ts`,
`team-match-stats.ts`, `training/team-match-stats.ts`.

## Scope

A2-A defines **contracts only**:

- a captured Sportmonks bundle with an explicit fetch status per data family;
- a pure, offline parser from that bundle to a provider match observation;
- a database RPC that resolves provider identities and writes a 1A ledger
  observation, or quarantines;
- an ingest audit;
- the canonical per-team match-stats read in two availability classes.

A2-A does not:

- call a provider;
- run or schedule a backfill;
- enumerate leagues;
- hardcode a competition list;
- activate anything in V3.

The operator-run capture and pilot are A2-B.

The 1A contracts are unchanged. That covers `match_ledger_record_observation`,
the as-of reads, the content hash and `first_seen_at`. The ingest RPC resolves
identities and then calls the 1A RPC with a canonical
`kapiloto-match-ledger-observation-v1` payload.

## Captured bundle (`kapiloto-sportmonks-ledger-capture-v1`)

```text
{
  contract_version: "kapiloto-sportmonks-ledger-capture-v1",
  captured_at,            // ISO instant; becomes retrieved_at
  capture_mode,           // scheduled_sync | backfill | manual_import
  provider_endpoint,      // string <= 200 or null
  raw_payload_sha256,     // SHA-256 of ONE raw response body, supplied by the capturer, or null
  fixture: { id, league_id, season_id, starting_at_timestamp | starting_at,
             state.developer_name, participants[{ id, meta.location }],
             scores[{ description, score.goals, score.participant }],
             neutral_venue? /* only when the payload states it */ },
  families: {
    lineups | formations | statistics | xg: {
      fetch_status: "fetched" | "not_requested" | "failed",
      rows: [...],                 // must be empty unless fetched
      raw_response_sha256: string | null   // audit only
    }
  }
}
```

`raw_payload_sha256` is never computed by the parser, because only the
capturer holds the raw response bytes. It passes through as supplied (64
lowercase hex) and stays null otherwise. Per-family response hashes go to the
audit item only. They are never ledger content and never promoted to the raw
hash.

## Missingness

The fetch status is the only signal of whether a data family was provided. An
empty row list never counts as "provided".

| Situation | Status in `kapiloto-team-match-stats-v1` |
| --- | --- |
| Match went to extra time (AET / penalties) | `not_separable`: Sportmonks stats cover the whole match, not 90 minutes; the parser emits none |
| Family fetched, allow-listed key present, valid value, developer name verified | `observed` |
| Family fetched, key absent, or the provider row carries an explicit null value (capture flag `stat_value_null`) | `not_observed` |
| Allow-listed type with a different developer name, no developer name / no `type` include, or an invalid value | never persisted: the capture fails to parse (`stat_type_drift`, `stat_type_metadata_missing`, `stat_value_invalid`), so it can never surface as `not_observed` |
| Family `not_requested` (not asked for / not in plan), or no recorded family status (a plain 1A write) | `family_not_provided` |
| Family `failed` | never persisted: the RPC quarantines `family_fetch_failed`; retry, or re-capture it as `not_requested` |

Family statuses are stored per observation version in the sealed sidecar
`match_ledger_observation_family_fetches` (`fetched` / `not_requested` only),
so the read reproduces the statuses exactly. Missing is never zero.

## Parser rules (`kapiloto-sportmonks-ledger-mapping-v1`)

The mapping version is also the ledger `ingest_version`.

- **State.** `FT`, `AET` and `FT_PEN` map to `finished`. In-play states map to
  `live`, and `HT` to `halftime`. `NS`, `TBA` and `DELAYED` map to
  `upcoming`. `POSTPONED` maps to `postponed`. `SUSPENDED` and `INTERRUPTED`
  map to `suspended`. `CANCELLED` and `ABANDONED` map to `cancelled`.
  `AWARDED`, `WO`, `AWAITING_UPDATES`, `PENDING` and `DELETED` map to
  `under_review`, so a settlement-type result is never a field result.
  Unknown states are a parse error.
- **Scores.**
  - The 90-minute score is `2ND_HALF`, which is cumulative.
  - For `FT` only, `CURRENT` is used when `2ND_HALF` is absent; if both
    exist they must agree.
  - For `AET` and `FT_PEN`, both are required: `2ND_HALF` is the 90-minute
    score and `CURRENT` the after-extra-time score (it excludes penalties).
  - Penalties come from `PENALTIES` (alias `PENALTY_SHOOTOUT`) and are
    optional.
- **Lineups.**
  - Type 11 maps to `starter`, type 12 to `bench`, anything else to
    `unknown`.
  - Positions 24, 25, 26 and 27 map to GK, DF, MF and FW.
  - `formation_position` 1-11 is kept for starters only, and
    `formation_field` must look like `^\d{1,2}:\d{1,2}$`.
  - A shirt number or grid slot duplicated within a team is dropped, never
    guessed.
  - A duplicate player, or more than 11 starters, is a parse error.
  - Starters have `appeared = true`; others `null`. Minutes and substitution
    minutes are `null`, and completeness is `partial`.
  - `lineup_status` is `complete` only with exactly 11 starters.
- **Formations.** Must match `^[1-6](-[1-6]){1,5}$`; otherwise null with
  the capture flag `formation_invalid`.
- **Not mapped yet.** Substitutions, events and coaches are `not_provided`.
- **Stats.** Kept only from fetched families, for these verified type ids.
  All are full-time, `definition_version = 'sm-2024-08'`. Every allow-listed
  row in its family must validate, also for extra-time matches whose stats are
  not stored:
  - a different `type.developer_name` fails the capture with
    `stat_type_drift`;
  - a missing or empty developer name, or no `type` object, fails it with
    `stat_type_metadata_missing` (the capture must request the type include);
  - a non-numeric, negative, fractional count or above-100 percent value
    fails it with `stat_value_invalid`;
  - an explicit null value is kept out with the capture flag
    `stat_value_null`;
  - an allow-listed id in the other family is ignored with the capture flag
    `stat_type_outside_family`;
  - type ids outside the allow-list are outside the contract and ignored.

| Type | Developer name | `stat_key` | Family | Unit |
| --- | --- | --- | --- | --- |
| 5304 | EXPECTED_GOALS | `expected_goals` | xg | expected_goals |
| 5305 | EXPECTED_GOALS_ON_TARGET | `expected_goals_on_target` | xg | expected_goals |
| 7943 | EXPECTED_NON_PENALTY_GOALS | `expected_non_penalty_goals` | xg | expected_goals |
| 42 | SHOTS_TOTAL | `shots_total` | statistics | count |
| 86 | SHOTS_ON_TARGET | `shots_on_target` | statistics | count |
| 45 | BALL_POSSESSION | `possession_pct` | statistics | percent |
| 34 | CORNERS | `corners` | statistics | count |

  The three xG concepts are separate keys and never collapse into
  `expected_goals`.

  Sources:
  - <https://docs.sportmonks.com/v3/definitions/types/statistics/fixture-statistics>
  - <https://docs.sportmonks.com/v3/definitions/types/expected>
  - Score semantics: <https://docs.sportmonks.com/v3/tutorials-and-guides/tutorials/includes/scores>

  The definitions are seeded by the migration. If the A2-B pilot finds a
  payload that disagrees with the documentation, the fix is a new
  `definition_version` in a new migration, never an edit.
- **Errors and flags.** Malformed captures and provider contract drift raise
  `SportmonksLedgerParseError` with a closed code, and no observation is
  produced. The caller records the error through
  `provider_ingest_record_failure`. Recoverable issues the parser normalized
  away become capture quality flags (see "Two kinds of quality flags").

## Provider match observation and the ingest RPC

`public.match_ledger_ingest_provider_fixture(jsonb)` accepts
`kapiloto-provider-match-observation-v1`. The payload carries:

- provider refs: league, season, home team, away team;
- players by provider id;
- stats by provider type;
- `family_fetches`;
- `family_response_sha256`, which is audit only;
- `fixture_mint {allowed, kickoff_before}`;
- `run_id`, which is optional;
- `capture_quality_flags`, which is audit only (required; may be empty).

It is security invoker, `search_path = ''`, READ COMMITTED only, and granted
to `service_role` only.

**Phase 1** decides without writing anything except the optional audit item,
and quarantines in this order:

1. `family_fetch_failed`.
2. `not_finished`, and `finished_too_early`: the 1A ledger refuses a
   finished observation within 105 minutes of kickoff.
3. Competition through a confirmed or `manual_override` mapping, else
   `competition_unmapped`.
4. Teams the same way, else `team_unmapped`. Both provider teams on one
   canonical team gives `team_identity_conflict`.
5. Any unverified player mapping gives `player_mapping_unverified`.
6. Fixture: see the next section.
7. Drift against the latest version of (fixture, provider). A withdrawal
   skips this step: the next observation is a new attachment.
   - A latest version written for another provider fixture id gives
     `provider_fixture_id_drift`. This happens when a mapping was re-pointed,
     for example by a V3 upsert; the new id must not continue the other id's
     version chain.
   - No annotations gives `provider_refs_unrecorded`.
   - Different refs give `provider_ref_drift`.
   - A family `fetched` before and `not_requested` now gives
     `family_status_downgrade`.

**Phase 2** writes:

- the fixture attachment or mint;
- players;
- the 1A observation;
- the sealed refs and family statuses.

If the 1A RPC answers `unchanged` while a family status was upgraded, the
content cannot carry the new status. Phase 2 is rolled back (savepoint) and
the result is the quarantine `family_status_drift`. Any other exception aborts
the whole call: no mint, player or ledger row survives.

Global lock order. Every ingest takes its locks in this order, on every
path; a test checks it from the executed nested plans:

1. 1A provider-fixture advisory lock, exclusive.
2. The competition mapping row, `FOR SHARE`.
3. Both team mapping rows in one statement, ordered by `provider_team_id
   COLLATE "C"`, `FOR SHARE`.
4. The incoming provider fixture mapping row, if it exists, `FOR SHARE`.
5. Only when that mapping does not exist:
   - the unordered team-pair advisory lock
     `kapiloto_canonical_fixture_pair:<lower team id>:<higher team id>`,
     exclusive;
   - then every existing mapping row of this provider on a candidate
     fixture, ordered by `provider_fixture_id COLLATE "C"`, `FOR SHARE`.
6. Writes in the attach or mint branch. Their foreign-key checks take the
   standard `FOR KEY SHARE` on the referenced competition, team and fixture
   rows.
7. 1A fixture/provider advisory lock, exclusive.
8. Players identity advisory lock, exclusive. Player mappings are V4 rows
   whose writes take this lock, so they are stable once it is held.

See "Mapping row locks" for why these modes and this order.

Result: `{status, reason_code, fixture_id, observation_id, attempt_no,
fixture_resolution, observation_version, provider_refs_status, players_minted}`.

### Canonical identity rules

- **Competitions and teams are never created** by A2-A code. Operators
  reconcile them in A2-B. Teams and competitions have no merge support
  (D-050), so a wrong team cannot be repaired later.
- **Fixture resolution.**
  - An existing provider fixture mapping wins:
    - if `confirmed` or `manual_override`, its orientation and competition
      are validated (`fixture_mapping_conflict` otherwise);
    - if `unverified`, the result is `fixture_mapping_unverified`.
  - Otherwise, the candidates are ALL canonical fixtures of the same two teams,
    in either orientation, within ±180 days. A candidate is never hidden
    because it already carries a mapping from this provider.
  - Each candidate falls into at most one guard window:
    - R: reversed orientation, within ±48 h, any competition (teams never
      meet twice in 48 hours; two-legged ties are further apart);
    - N: same orientation and competition, within ±48 h;
    - U: same orientation, competition null, within ±14 days;
    - X: same orientation, another known competition, within ±48 h;
    - P: same orientation and competition, status postponed, suspended,
      cancelled or under review, within ±180 days;
    - W: same orientation and competition, within ±14 days.
  - Each candidate also has a provider identity state:
    - none: no mapping from this provider, and no ledger history of another
      provider fixture id;
    - other: mapped to a different provider fixture id (any mapping status,
      including `unverified`), or its latest ledger version for this provider
      is an observation of a different provider fixture id;
    - same: mapped to this very provider fixture id. The primary lookup found
      no mapping, so only a concurrent non-ingest writer can cause this; it
      gives `fixture_mapping_conflict`.
  - Quarantine, with precedence:
    - any guarded candidate with identity `other` gives
      `fixture_provider_identity_conflict`;
    - N > 1 gives `fixture_candidate_ambiguous`;
    - R gives `fixture_orientation_conflict`;
    - X gives `fixture_competition_conflict`;
    - U gives `fixture_competition_unknown`;
    - P gives `fixture_possible_postponement`;
    - W gives `fixture_possible_reschedule`.
  - Otherwise the fixture is attached iff N = 1. The single candidate then
    carries no identity of this provider.
  - Neither provider id is ever re-pointed, and nothing is name-matched. The
    quarantine detail lists the window counts and the conflicting provider
    fixture ids.
- **Mint.** Allowed only when no guarded candidate exists (including one
  already identified with another provider fixture id),
  `fixture_mint.allowed` is true and `kickoff_at < kickoff_before`.
  - The database hardcodes no window.
  - A2-B derives the bound with `fixtureMintKickoffBefore(now, lookback)`,
    which is now − (V3 scoring lookback + 1 day). With V3's 21-day
    `scoringLookbackDays`, that is 22 days.
  - A minted fixture therefore never enters V3's finished-fixture scan.
  - A run may record `fixture_mint_kickoff_before`, and an item bound above
    it is refused.
  - Minted fixtures are `finished`, with the 90-minute score,
    `neutral_venue` defaulting to false, and a confirmed mapping. They are
    recorded in `match_ledger_fixture_mints`.
- **Players.**
  - `confirmed` or `manual_override` mappings resolve to the current
    survivor.
  - With no mapping, a canonical player is bootstrapped. The provider name
    becomes the canonical name, or `Sportmonks player <id>`. The mapping is
    confirmed, confidence 1, `mapping_basis = 'provider_native_bootstrap'`,
    and a `provider_spelling` alias is added with source
    `sportmonks_bootstrap`.
  - With an `unverified` mapping, the result is the quarantine
    `player_mapping_unverified`. Nothing is written or promoted, and no
    second mapping is created. It is checked in phase 1 and again under the
    identity lock in phase 2, where it raises. After an explicit operator
    promotion, the same capture ingests.
  - Duplicates across providers are repaired by D-050 merges.

### Why the pair lock and the candidate query close the race

1. **Lock first.** A call reaches the candidate search only when its own
   provider fixture id has no mapping. It first takes the transaction-scoped,
   exclusive lock of the unordered canonical team pair. Only then does it run
   the candidate query.
2. **Every creation happens under the lock.** Attach and mint happen only in
   this branch, in the same transaction, before commit. So every ingest-made
   mapping or minted fixture for a team pair is written while that pair's lock
   is held, and becomes visible when the holder commits.
3. **The next holder sees it.** Under READ COMMITTED the candidate query is a
   new statement after the lock is granted. A second caller for the same
   pair, with any provider fixture id, orientation or competition, therefore
   sees the first caller's committed mapping or fixture.
4. **The revised query classifies it.** The mapped fixture is classified as
   identity `other` instead of being filtered out, so the second caller
   quarantines rather than mints.
5. **Why the old key was not enough.** The previous key,
   `(competition, home, away)`, did not serialize two calls for the same
   teams that resolve to different competitions or orientations.

Writers that do not take this lock are not covered: the V3 Sportmonks store
and the Toto import. The `same` state and the 1A mapping checks are the
fail-closed backstop, and the existing mapping rows are additionally row-locked
(next section). The PGlite test proves the sequential half (the first
transaction commits under the lock, the second takes the same key and cannot
mint). True parallel blocking needs two connections and is not testable on
PGlite's single connection.

### Mapping row locks

V3 stays active and upserts `provider_team_mappings` on `(provider,
provider_team_id)`, `provider_competition_mappings` and
`provider_fixture_mappings`. An upsert can repoint `team_id` or
`competition_id`, change `mapping_status`, or move a fixture mapping. Under
READ COMMITTED, every statement of the RPC takes a fresh snapshot. So without
row locks, an identity resolved early in the call could be changed by a V3
commit before the immutable observation commits, and later statements could
mix old and new mapping states.

**Mode: `FOR SHARE`, held to commit.**
- Every V3 mapping row the call resolves is locked this way:
  - the competition row;
  - both team rows;
  - the existing mapping for the incoming provider fixture id;
  - the existing mapping rows of candidate fixtures, which are the
    identity-conflict evidence.
- Each row is locked before its state is checked, so a quarantine holds the
  lock too.
- PostgreSQL's row-lock table:
  - `FOR SHARE` conflicts with `FOR NO KEY UPDATE` and `FOR UPDATE`.
  - Every `UPDATE` takes at least `FOR NO KEY UPDATE`.
  - `INSERT ... ON CONFLICT DO UPDATE` locks the existing row the same way
    before updating it.
  - `DELETE` takes `FOR UPDATE`.
- So a concurrent V3 upsert, update or delete of a locked row waits until the
  ingest commits or rolls back. At lock time, READ COMMITTED re-reads the
  latest committed row version, so the call resolves the current state and
  that state then cannot change under it.
- **Why not weaker:** `FOR KEY SHARE` would only block deletes and key
  updates. `team_id`, `competition_id` and `mapping_status` are not key
  columns, and an `UPDATE` of non-key columns takes `FOR NO KEY UPDATE`,
  which `FOR KEY SHARE` allows. That is exactly the repoint this must
  prevent.
- **Why not stronger:** `FOR SHARE` locks never conflict with each other, so
  concurrent ingests never wait on mapping rows. A test reads the heap tuple
  header bits (lock-only, with the exclusive and key-share bits both set) to
  show that the ingest transaction holds `FOR SHARE` on exactly these rows,
  and nothing else, until commit.

**Deterministic order and deadlocks.**
- Both team rows are locked by one statement whose `LockRows` node runs above
  a `Sort` on `provider_team_id COLLATE "C"`. A home=A/away=B ingest and a
  home=B/away=A ingest therefore acquire the rows in the same order. A test
  shows the identical plan for both orientations, with only the IN-list
  literal swapped.
- Between ingests, the row locks are all shared and cannot deadlock. The
  exclusive advisory locks are taken in one global order: provider fixture,
  then team pair, then 1A fixture, then identity. An ingest waiting for the
  team-pair lock holds only its own provider-fixture lock and shared row
  locks, which the holder never needs.
- The order is forced by data dependencies:
  - The team-pair key needs the canonical team ids, so the team rows (step 3)
    must be locked before the pair lock (step 5).
  - The candidate mapping rows must be read after the pair lock, or a mapping
    committed by an earlier pair holder could be missed.
- A deadlock is still possible against a V3 transaction that takes exclusive
  row locks on several mapping rows in its own order, because V3 takes none
  of our locks. PostgreSQL's deadlock detector then aborts one of the
  transactions. If that is the ingest, the whole call rolls back and the run
  records a failed or retryable attempt. Nothing partial is written.

**Defense in depth.** After the 1A write, the call re-checks that all of these
still match:
- the competition mapping;
- both team mappings;
- the incoming provider fixture mapping (to the fixture written, confirmed or
  manual).

Otherwise it raises, and everything rolls back. Against concurrent writers the
row locks already guarantee this. The check turns any bypass into a full
rollback instead of a ledger observation under a stale identity: a writer in
the ingest's own transaction, or a future refactor that drops a lock. A test
simulates such a bypass with a same-transaction trigger, for a team repoint, a
status demotion, a competition repoint, and a fixture mapping repoint or
delete.

**Residual concurrency while V3 is unchanged.** These cases are fail-closed or
serial-equivalent; none produces a wrong ledger observation:

1. **A new mapping row inserted concurrently by a non-ingest writer.** There
   is no row to lock, and V3 does not take the team-pair lock.
   - If it is for the incoming provider fixture id, the ingest's own insert
     violates the `(provider, provider_fixture_id)` primary key.
   - If it is for the fixture being attached, the insert violates
     `unique (fixture_id, provider)`.
   - Either way the statement errors after the conflicting transaction
     commits, and the whole call rolls back.
   - If it lands on a candidate the call did not attach to, the result is
     what a serial schedule with the ingest first would produce: a mint needs
     no guarded candidate at all, so a new mapping on a candidate cannot turn
     a mint into a wrong attach.
2. **V3 updates after the ingest commits.** The locks end at commit. A later
   repoint does not touch the stored observation, which keeps the identity
   resolved under the locks. The next ingest of that fixture quarantines:
   - `fixture_mapping_conflict` for repointed teams or competitions;
   - `provider_fixture_id_drift` or `fixture_provider_identity_conflict` for
     repointed fixture mappings.

   A V3 `ON CONFLICT (fixture_id, provider) DO UPDATE` on a mapping the
   ingest just inserted waits for the ingest to commit and then repoints it.
   That is the documented V3 hazard, detected the same way.
3. **Candidate fixture rows are not row-locked.** Their kickoff, status and
   competition decide the guard windows, but a V3 update to them commutes
   with the ingest's writes: the outcome equals the ingest-first serial order.
   The fixture an observation is written to is protected against deletion by
   the ledger's foreign key (`FOR KEY SHARE`).
4. **V3 creating a new canonical fixture concurrently with a mint.** Toto
   import and round-scoped structured sync do not take the team-pair lock.
   Minting is bounded to kickoffs older than V3's scoring lookback plus one
   day, while V3 creates fixtures for current rounds, so the windows are
   disjoint in practice. They are not enforced by a lock. A duplicate created
   this way is detected by the next ingest of either provider id
   (`fixture_provider_identity_conflict`).

**Test limitations.**
- The tests prove which row locks the ingest transaction holds (pageinspect
  tuple bits) and the order in which every lock is taken (auto_explain nested
  plans, in execution order).
- PGlite is a single-user backend and does not enforce row-lock conflicts
  between transactions. Even a prepared transaction's `FOR SHARE` did not
  refuse `FOR UPDATE NOWAIT` in a probe. So the blocking of a concurrent V3
  writer rests on PostgreSQL's row-lock conflict table above, and no test
  claims to demonstrate it.

### Provider refs and family statuses

`match_ledger_observation_provider_refs` holds `league`, `season`,
`team_home` and `team_away`. `match_ledger_observation_family_fetches` holds
one status per family. Both are:

- sealed to the statement that wrote the observation version
  (`ingest_statement_at = statement_timestamp()`);
- restricted to observations, not withdrawals;
- immutable, with no truncate.

They are not part of the 1A content hash. They describe one version, so a
later payload is compared with the latest version's sidecar rather than
re-hashed.

## Audit

- `provider_ingest_runs` is the immutable run header:
  - provider and purpose (`backfill` | `test`);
  - `ingest_version`;
  - `entitlement_snapshot_sha256`, from `providerEntitlementSnapshotSha256`,
    contract `kapiloto-provider-entitlement-snapshot-v1`;
  - `scope`;
  - `fixture_mint_kickoff_before`.
- `provider_ingest_items` is append-only, one row per attempt per provider
  fixture:
  - `attempt_no` increments under the provider-fixture lock;
  - status is `recorded`, `unchanged`, `quarantined` or `failed`;
  - quarantined and failed items carry a reason code;
  - each item also has `observation_id`, a soft `fixture_id` (no foreign
    key, so an immutable audit row never blocks a V3 fixture delete) and a bounded
    `detail`.
- `provider_ingest_record_failure` appends `failed` items for fetch or parse
  failures.

### Two kinds of quality flags

- **Ledger and model quality flags** are the `quality_flags` column of
  `kapiloto-team-match-stats-v1`: `went_to_extra_time`,
  `family_fetches_unrecorded`, `xg_not_requested` and
  `statistics_not_requested`. They are derived at read time from persisted
  ledger state and the sealed family statuses, so they are the same for
  everyone reading that version.
- **Capture quality flags** are per ingest attempt. They are recoverable
  issues the parser normalized away, from a closed set:
  - `duplicate_formation_position`;
  - `duplicate_shirt_number`;
  - `formation_invalid`;
  - `lineup_role_unknown`;
  - `stat_type_outside_family`;
  - `stat_value_null`;
  - `stats_not_separable_extra_time`.
- How capture quality flags travel and are stored:
  - The parser emits them sorted and unique.
  - The RPC requires `capture_quality_flags` as an array of at most 32 known
    flags, and normalizes it to sorted and distinct.
  - Every run-bound attempt that reaches the ingest RPC stores them in
    `provider_ingest_items.detail.capture_quality_flags`. That covers
    `recorded`, `unchanged` and every structured quarantine.
  - They never reach the 1A payload, the content hash, the sealed sidecars
    or the stats read, and never create a version.
  - Two captures with the same ledger content can therefore carry different
    flags on different attempts.
- Provider contract drift is never a capture flag: it is a parse failure
  (see the parser rules).

## Team match stats (`kapiloto-team-match-stats-v1`)

There is one row per team per selected finished fixture, from one provider per
call. Each row has:

- **identity:** fixture, team, opponent, side, neutral venue, competition,
  season key, provider league/season refs;
- **provenance:** provider, observation id/version, capture mode, ingest
  version, kickoff, `first_seen_at`, `effective_available_at`,
  `availability_basis`, `availability_policy`, `evaluation_class`;
- **outcome:** match status, goals for/against at 90 minutes,
  `went_to_extra_time`, penalties for/against;
- **stats:** `stats_for` and `stats_against` with exactly the seven keys,
  each `{value, status, definition_id, provider_stat_type, definition_version,
  period}`;
- **quality:** `lineup_status`, `statistics_status`, `quality_flags`
  (`went_to_extra_time`, `family_fetches_unrecorded`, `xg_not_requested`,
  `statistics_not_requested`).

The two availability classes:

- **Strict (actual):** `match_ledger_team_match_stats_as_of(provider,
  competition_ids, from, cutoff)`, through `loadTeamMatchStats`.
  - It applies the 1A as-of rule: per (fixture, provider), the highest
    version first seen at or before the cutoff, with withdrawals hiding the
    fixture, finished only, and kickoff before the cutoff.
  - `evaluation_class = 'actual'`.
- **Retrospective training:**
  `match_ledger_team_match_stats_for_training(..., training_cutoff, policy)`,
  through `lib/kapiloto-v4/training/team-match-stats.ts`.
  - Policy `kapiloto-retrospective-training-availability-v1` is mandatory
    and exact.
  - Only version 1 of a (fixture, provider) pair qualifies, with
    `capture_mode = 'backfill'`, kind observation and status finished. It
    becomes effective at `min(first_seen_at, kickoff_at + 24h)`.
  - Every later version and every withdrawal keeps its actual
    `first_seen_at`. Effective times therefore never decrease across
    versions, and a correction never reaches an earlier cutoff.
  - Rows are `evaluation_class = 'retrospective'`, and backdated rows are
    `availability_basis = 'retrospective_backfill'`.
  - Not exported from `lib/kapiloto-v4/index.ts`. A boundary test forbids
    importing it from non-training code, including squad state, lineup
    model, lineup snapshot, prediction registry and the index.

### What retrospective rows may and may not support

They may support:

- fitting and backtesting model structure on history ("as if each match
  report were available a day after kickoff");
- comparing models under the same approximation, labelled `retrospective`.

They must not support:

- claims of live or prospective performance;
- reconstructing what Kapiloto or the provider knew at the time;
- being cited as Prediction Registry inputs. The registry already refuses
  ledger inputs first seen after the cutoff, and a backfilled observation is
  first seen at ingest time;
- being mixed with strict rows in one evaluation without the
  `evaluation_class` split.

## Interaction with V3

The ingest RPC writes two V3 tables:

- `fixtures`: minted rows only, with kickoffs outside V3's scoring lookback;
- `provider_fixture_mappings`: an attached or minted fixture gets a confirmed
  Sportmonks mapping.

It never updates an existing `fixtures` row and adds no trigger, constraint or
index to V3 tables.

Known V3 hazards are documented, not fixed in A2-A:

- The V3 Sportmonks store upserts `provider_team_mappings` on
  `(provider, provider_team_id)`, which can re-point a mapping.
- The same store upserts `provider_fixture_mappings` on
  `(fixture_id, provider)`; a V3 write for a fixture A2 minted collides on
  `(provider, provider_fixture_id)`.
- The Toto import creates teams by exact lower-cased name.

While an ingest runs, the competition, team and fixture mapping rows it
resolved are held `FOR SHARE`, so a V3 upsert of them waits for the ingest to
finish (see "Mapping row locks").

The 1A `match_ledger_mapping_conflicts()` read detects fixture-mapping drift.
A2-B must reconcile team identities before ingesting a competition.

## A2-B (not in this change)

A2-B covers:

- an operator CLI that captures bundles, hashing the exact response bytes and
  setting fetch statuses honestly;
- a verified entitlement snapshot and a run header;
- team and competition reconciliation;
- a small pilot that checks the seeded definitions against real payloads.

No migration is required unless the pilot finds a documentation/payload
mismatch, which would be fixed with a new `definition_version`.

## Security

- All five new tables have RLS enabled, no policies, and no
  `anon`/`authenticated` grants.
- The four public functions and the private helpers they call by name are
  executable by `service_role` only.
- There is no SECURITY DEFINER.
- Audit, annotation and mint rows are immutable.
