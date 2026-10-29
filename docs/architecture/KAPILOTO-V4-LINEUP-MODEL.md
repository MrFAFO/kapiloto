# Kapiloto V4 Foundation 1D: lineup forecast baseline and Prediction Registry V2

Decision: D-054. Migration:
`supabase/migrations/20261029085303_kapiloto_v4_lineup_prediction_registry_v2.sql`
(additive; the 1A/1B/1C migrations are unchanged and pinned by hash in
`lib/kapiloto-v4/boundaries.test.ts`). Code: `lib/kapiloto-v4/lineup-model.ts`,
`lineup-scoring.ts`, `lineup-snapshot.ts`, `canonical-json.ts`, and the V2
section of `prediction-registry.ts`.

1D adds a deterministic, explainable **benchmark baseline** for one team's
lineup in one fixture, plus the registry contract needed to persist it
without changing what any existing snapshot means. It is not calibrated, not
wired into V3, and not a joint XI model.

## Layering

Each layer is separate and testable on its own:

1. **Load** raw, cutoff-filtered inputs: `loadLineupSquadInputs` →
   `public.squad_state_inputs_as_of(fixture, team, cutoff, history_max_fixtures)`
   (1C; all leakage filtering happens in the database). The history window
   passed to the read is the policy's `maxFixtures`, the same value the
   registry re-runs the read with at commit.
2. **State**: the pure `buildFixtureSquadState(inputs, policy)` (1C).
3. **Model**: the pure `buildLineupForecast(lineupModelInput(inputs, state), parameters)`.
4. **Payload**: the pure `buildLineupForecastSnapshot(...)` →
   `buildPredictionSnapshotV2Payload(...)`.
5. **Persist**: `recordLineupForecastSnapshot(rpc, snapshot)` validates the
   snapshot, the frozen state artifact and the lineup output contract, then
   calls `public.prediction_record_snapshot_v2` (service_role only).

## Prediction Registry V2

### Contract and kinds

`kapiloto-prediction-snapshot-v2` is a new contract version. V1 is unchanged:

* `public.prediction_record_snapshot` (V1 RPC), `private.prediction_canonical_inputs`,
  `private.prediction_input_bundle_sha256` and `private.prediction_output_sha256`
  are not modified. The commit-time check `private.check_prediction_input_bundle()`
  is replaced by a version-dispatching function whose V1 branch is the 1B
  logic verbatim.
* Every existing row becomes `prediction_kind = 'match_outcome'`,
  `subject_team_id = null` (column defaults). A check constraint keeps every
  V1 row a match outcome with no subject team.
* The 1/X/2 rule is unchanged for match outcomes: the new
  `prediction_snapshots_kind_outcome_check` has the original rule verbatim as
  its match-outcome branch.
* Golden tests (`registry-v1-golden.test.ts`) assert the V1 canonical
  input-bundle hash, the V1 output hash and an end-to-end V1 recording
  against constants captured on `main` (`f3e1e16`) before the migration
  existed, and V1 idempotent replay.

`prediction_kind`:

| Kind | Contracts | 1/X/2 | `subject_team_id` | `predicted` requires |
| --- | --- | --- | --- | --- |
| `match_outcome` | V1, V2 | p1+pX+p2 = 10000 | null | probabilities, no abstain reason |
| `lineup_forecast` | V2 only | all null | required; home or away of the fixture | `payload.lineup_estimate`, no abstain reason |

An abstained lineup forecast needs an `abstain_reason` (the model status when
it could not project) and may keep its `lineup_estimate`. `abstained` is never
used to store a forecast that was made. A subject team is frozen like every
other snapshot column and is validated by trigger to play the fixture. One
forecast is one team: the home and away forecasts are two snapshots.

### Frozen input families

V2 snapshots use every V1 link family and add:

| Table | Row | Rules |
| --- | --- | --- |
| `prediction_membership_inputs` | `(snapshot_id, membership_id → team_player_memberships, input_role, input_first_seen_at)` | membership version first seen ≤ cutoff; lineup: subject team only, role `squad_membership`; match outcome: a fixture team |
| `prediction_tenure_inputs` | `(snapshot_id, tenure_id → team_coach_tenures, input_role, input_first_seen_at)` | tenure version first seen ≤ cutoff; lineup: subject team only, role `squad_coach_tenure`; match outcome: a fixture team |
| `prediction_squad_state_context` | one row per lineup forecast | the versions, provider priority, history window, the exact squad-state bytes and their SHA-256 (below) |

For a lineup forecast, the existing families are constrained too (trigger
`check_prediction_lineup_scope`, after the 1B cutoff checks):

* ledger links use `squad_history_selected` (the observation 1C selected) or
  `squad_history_alternative` (considered but not selected), must have a team
  record for the subject team, and may never be the target fixture's own
  ledger data (not even a pre-kickoff lineup capture). Each must be what
  `squad_state_inputs_as_of` could return at the cutoff: a finished
  observation (not a withdrawal, not an upcoming match), kicking off before
  the target, and the latest version of its (fixture, provider) first seen at
  or before the cutoff;
* claim links must be target-fixture claims with team = subject or no team,
  with role `squad_availability_claim` (`player_availability`) or
  `squad_lineup_claim` (`expected_lineup`), and carry the resolution the as-of
  read returns: the latest version first seen at or before the cutoff (a later
  version is refused by 1B, a superseded one by 1D), or none only if the claim
  had none by then;
* membership and tenure links must be the latest version of their key first
  seen at or before the cutoff, and asserted (never a retraction), exactly as
  the as-of reads return them;
* identity bindings: `lineup_subject_team` for the team, `lineup_candidate` for
  every player in the output (canonical id as used, one raw observed id when
  it differs), `lineup_coach_candidate` for coach candidates.

`buildLineupForecastSnapshot` freezes everything whose presence could change
the 1C state: every considered ledger observation (selected and
alternatives), every membership row the as-of read returned, every
target-fixture claim with its exact resolution, every tenure, the context, the
state artifact and the bindings.

### Complete 1C capture (database-authoritative)

Individually valid links are not enough: a caller could omit an inconvenient
row and still get a valid hash for the smaller bundle. So at commit, for every
lineup forecast, the database re-runs

```
public.squad_state_inputs_as_of(fixture_id, subject_team_id, research_cutoff_at, history_max_fixtures)
```

and requires the frozen link sets to equal what it returns, exactly:

* history observation ids = all ledger links (selected and alternatives);
* membership ids = membership links;
* tenure ids = tenure links;
* `(resolution_claim_id ?? claim_id, resolution_id)` pairs = claim links (the
  same claim-id rule as the TypeScript snapshot builder).

Any omitted provider alternative, membership, tenure, claim or resolution,
and any extra valid row the read would not return (for example history
outside the frozen window), is refused. The check runs inside the recording
transaction (the deferred bundle constraint is forced before the RPC returns),
so it is atomic with the write. Because every compared input is first seen at
or before the cutoff, re-running the read at commit returns the same raw rows
as when the forecast was built; a canonical-claim regrouping by a merge in
between fails closed.

The frozen state artifact is cross-checked against the same links: its
`provenance.ledger_observation_ids` must equal the `squad_history_selected`
links, and its `considered_observation_ids`, `membership_ids` and
`tenure_ids` must equal the ledger, membership and tenure links.

### Squad-state context, exact artifact and replay

`prediction_squad_state_context` stores `subject_team_id`,
`squad_state_inputs_contract` (`kapiloto-squad-state-inputs-v1`),
`squad_state_contract` (`kapiloto-squad-state-v1`), `squad_state_builder_version`,
`squad_features_version` (`kapiloto-squad-features-v1`),
`history_selection_policy_version`, `availability_normalization_version`,
`target_date_policy` (`kapiloto-target-date-utc-v1`), the explicit
`provider_priority` array (1-20 distinct provider keys), `history_max_fixtures`
(1-10), `squad_state_canonical_json` and `squad_state_sha256`. Version columns
only accept the current 1C versions.

**The exact state bytes are frozen.** `squad_state_canonical_json` is
`canonicalJson(state)`, the exact bytes the model consumed. Canonical JSON
sorts object keys at every level, keeps array order, drops `undefined` and
refuses non-finite numbers (`lib/kapiloto-v4/canonical-json.ts`). The column
is `text`, never `jsonb`, so no reserialization can change the bytes. It is
bounded (2 B to 1 MiB), and a table check requires
`squad_state_sha256 = SHA-256(convert_to(squad_state_canonical_json, 'UTF8'))`.
The lineup payload must reference the same SHA. On insert, a trigger parses
the artifact and requires it to describe this snapshot and context: fixture,
subject team, cutoff, contract/builder/inputs/features/normalization
versions, target-date policy, history-selection policy version, provider
priority and window.

**Historical replay** does not depend on today's identities:

* `parseSquadStateArtifact(text, sha)` retrieves the exact state. It throws
  unless the bytes hash to the frozen SHA and are canonical JSON.
* `lineupReplayInput(frozenState, sha, history)` pairs it with the
  forecast's selected ledger observations: immutable rows, read again by id
  through the as-of read. Each row's canonical player id is taken from the
  **frozen** state (the candidate whose observed ids contain the row's raw
  id), not from today's D-050 survivors.
* `buildLineupForecast(replayInput, storedEstimate.parameters)` then
  reproduces the stored `lineup_estimate` exactly. The identity-merge test
  proves this after a later A→B merge.

Current-day reads are separate. `verifySquadStateReconstruction` rebuilds a
state from today's 1C inputs. It matches the artifact only while no later
identity merge changed what the as-of read resolves; after a merge it differs
on purpose, and the artifact remains the record.

The database cannot run the TypeScript builder, so it verifies consistency,
not derivation. At commit it checks:

* complete capture;
* artifact provenance;
* the stored `lineup_estimate`: fixture, subject team and squad-state hash
  match; `status = 'projected'` when predicted; the output contract
  (below); the output players are exactly the artifact's
  `provenance.canonical_player_ids` (none only on invalid parameters); and
  every output player has an identity binding.

These checks apply whenever a `lineup_estimate` is stored, including on an
abstention.

### Stored output contract (database)

`private.prediction_lineup_estimate_issue` enforces the
`kapiloto-lineup-output-v1` contract for direct service_role writes. It
validates the stored scientific record, not the model formula:

* output contract `kapiloto-lineup-output-v1`, model
  `kapiloto-lineup-model-v1`, a known status;
* `players` and `modal_xi` are arrays; every player has a canonical UUID;
  no duplicate players; raw probabilities and start caps are integers in
  0..10000.

When `projected`:

* parameters `kapiloto-lineup-parameters-v1`;
* `team_start_total_bp = 110000` and an integer team intercept;
* exactly 11 unique modal ids, each exactly one output player, and every
  `in_modal_xi` flag agreeing with `modal_xi`;
* projected start and appearance are integers in 0..10000 and minutes
  integers in 0..900 tenths;
* start ≤ cap and start ≤ appearance ≤ cap;
* player starts sum to exactly 110000.

Otherwise: no modal XI, no team total or intercept, and every projected
start, appearance, minutes value is null with `in_modal_xi` false.

### Canonicalization and hashing

* V1: exactly the 1B canonical bundle (`ledger`, `documents`, `claims`,
  `claim_observations`, `references`, `identities`).
* V2: `private.prediction_canonical_inputs_v2` = the V1 canonical bundle of the
  V1 families, plus sorted `memberships`, sorted `tenures` and the normalized
  `squad_state_context` object (or null). Unknown keys are refused at every
  level. `private.prediction_input_bundle_sha256_v2` hashes it.
* The commit-time check rebuilds the bundle from the link rows (including the
  three new tables and the artifact text) and compares it with the stored
  hash, dispatched by contract version.
* The output hash is the unchanged `private.prediction_output_sha256`.

### RPC, idempotency, atomicity

`public.prediction_record_snapshot_v2(jsonb)` is a copy of the V1 RPC with the
V2 contract, `prediction_kind`, `subject_team_id` and the new families:
security invoker, `search_path = ''`, READ COMMITTED required, advisory lock
per idempotency key, all links written in the snapshot's statement, and the
deferred bundle constraint forced before returning. Any failure rolls back
everything.

An exact replay returns `unchanged`. Reusing the key with any material
difference is refused: kind, subject team, any header field (including
model identifiers such as the parameter version), provider priority or
history window, membership/tenure/considered-ledger/claim/resolution sets,
the squad-state hash, identity bindings, or the lineup payload.

Direct writes cannot bypass this. Links added after the snapshot statement
are refused as sealed. V2 link rows on V1 snapshots are refused. A
single-statement write of snapshot plus links is still verified at commit
(context present, complete capture, artifact, output contract, hash of
links). All new rows are immutable (no update, delete or truncate).

### Security

The three new tables have RLS enabled, no policies, and no
`anon`/`authenticated`/`PUBLIC` grants. Every new function is revoked from
app roles. Only `prediction_record_snapshot_v2`, the two V2 canonical
helpers and the two output-contract helpers (called by name from the invoker
RPC and check, which also calls `squad_state_inputs_as_of`) are granted to
`service_role`. Nothing is `SECURITY DEFINER`. Tests: `security.test.ts`,
including an end-to-end V2 recording as `service_role`.

## Lineup model (`kapiloto-lineup-model-v1`)

Versions: model `kapiloto-lineup-model-v1`, parameters
`kapiloto-lineup-parameters-v1` (an injectable, versioned object copied into
every output), output contract `kapiloto-lineup-output-v1`. Pure and
deterministic: no database, no randomness, no clock, no model calls.

### Statuses

`projected`; `insufficient_candidates` (fewer than 11 candidates);
`insufficient_start_capacity` (sum of integer caps < 110000 bp);
`invalid_input` (invalid parameters, malformed squad-state hash,
`selected_history` not exactly the state's selected observations, or a solver
range that does not bracket the intercept), with `invalid_reasons`. On any
non-projected status there is no team intercept, no modal XI, and projected,
appearance and minutes values are null. Raw per-player values are kept,
except when the parameters themselves are invalid: then `players` is empty,
because no per-player value computed from them is trustworthy.

### Parameter validation (fail closed)

`validateLineupParameters` checks the complete object, and any failure makes
the forecast `invalid_input`. Nothing is clamped.

* `version` = `kapiloto-lineup-parameters-v1` and `team_starters` = 11 (a V1
  invariant; the model always projects 11).
* Priors: alpha and beta finite and > 0.
* Availability: exactly the five quantified categories, each finite in [0, 1].
* Pseudo-counts: both standings × three predicates × four counts, each a
  non-negative integer. The V1 values are integers, and halving them for
  `verified_degraded` stays integral.
* Minutes fallbacks: finite, in [0, 90].
* Solver: `0 < logit_epsilon < 0.5`, finite `lambda_min < lambda_max`, and an
  integer number of iterations in 1..1000.
* No unknown keys.

After solving, the start marginals must sum to 11 within 1e-6, so a range
that does not bracket the root is refused rather than projected. Valid
injected parameters remain possible; their output still satisfies the V1
output contract.

### B0: historical Beta-Binomial posterior

From `candidate.history` (1C per-feature knownness, last 10 selected fixtures):

```
p_start_raw = (starts_last.last_10.value + α_s + s⁺) / (starts_last.last_10.available_matches + α_s + β_s + s⁺ + s⁻)
p_app_raw   = (appearances_last.last_10.value + α_a + a⁺) / (appearances_last.last_10.available_matches + α_a + β_a + a⁺ + a⁻)
```

with α = β = 1 (`start_prior`, `appearance_prior`) and pseudo-counts
s⁺/s⁻/a⁺/a⁻ = 0 unless M1 applies. Unknown is never zero: denominators are
the matches where that feature is known. Players with no known start/appearance get
the prior (0.5) and `start_prior_only` / `appearance_prior_only` flags.

### Availability mapping (uncalibrated)

From 1C accepted evidence only (`accepted_category`, `availability_conflict`):

| Category | Probability (cap) |
| --- | --- |
| available | 0.98 |
| doubtful | 0.60 |
| unavailable | 0.02 |
| suspended | 0.00 |
| returning | 0.75 |
| unknown / no accepted evidence | null, no cap |
| conflicting accepted categories | null, no cap, `availability_conflict` |

Unresolved, quarantined, contradicted and fabricated evidence never affects
the model. `verified_degraded` evidence is used and flagged
(`availability_verified_degraded`).

### M1: reported-lineup pseudo-counts

From accepted (`verified`/`verified_degraded`), **affirmed** `expected_lineup`
claims. A negated report ("will not start") is never guessed into a predicate.
It is ignored and flagged `negated_lineup_report_ignored`, just as 1C keeps
negated availability claims unknown.

| Predicate | verified | verified_degraded |
| --- | --- | --- |
| `starts` | +4 start successes, +4 appearance successes | +2, +2 |
| `on_bench` | +4 start failures, +2 appearance successes | +2 start failures, +1 appearance success |
| `not_in_squad` | +8 start failures, +8 appearance failures | +4, +4 |

If more than one predicate is accepted for a player: no adjustment,
`lineup_evidence_conflict`. With one predicate and mixed standings the
`verified` counts apply. Reasons are recorded as
`lineup_report_<predicate>_<standing>`.

### Conflicts

* `availability_conflict`: no availability probability, no cap.
* `lineup_evidence_conflict`: no claim adjustment.
* `cross_evidence_conflict` is decided on the **raw accepted evidence sets**,
  not on what survived each family's summarization:
  `hasUnavailableLikeAccepted` (any accepted availability evidence normalized
  to `unavailable` or `suspended`) **and** `hasSquadPresenceReportAccepted`
  (any affirmed accepted `starts` or `on_bench` report). It holds even when
  availability also has an accepted `available` claim, when the reports also
  include `not_in_squad` or both `starts` and `on_bench`, and when either
  per-family conflict is already set. When it holds:
  * every evidence item and every per-family flag is kept;
  * all lineup pseudo-counts and the availability cap are suppressed
    (`claim_adjustments_suppressed_cross_conflict`, `applied = null`);
  * raw start and appearance revert to B0 history only;
  * availability is still displayed by its own family semantics, but never
    caps.

  `unavailable`/`suspended` with only `not_in_squad`, or `doubtful` with
  `starts`, is consistent, and both families apply.

### Start cap

`cap_i` = the quantified availability probability, else 1. Stored as
`start_cap_bp = floor(cap · 10000)`.

### Team projection

One team intercept λ:

```
p_i(λ) = min(cap_i, sigmoid(logit(clamp(p_start_raw_i, ε, 1-ε)) + λ)),   Σ p_i(λ) = 11
```

ε = 1e-6 is used only for logit stability. Σ p_i(λ) is monotone in λ, and λ
is found by 200 bisection steps on [-60, 60] (deterministic). Requires ≥ 11
candidates and Σ caps ≥ 11. `team_lambda_micro = round(λ·10⁶)`.

### Integer basis points (the 110000 invariant)

Projected start probabilities are integers that sum to exactly 110000 bp:
floor each `p_i · 10000` (never above `start_cap_bp`), then hand the
remaining points one at a time to the largest fractional remainders among
players below their cap, ties by canonical id ascending. A floating-point
overshoot takes points back from the smallest remainders, ties by id
descending. `team_start_total_bp` is 110000 whenever projected.

### Modal XI

The 11 highest projected start probabilities, ties by canonical id; stored
sorted. It is a modal 11-player set, **not** a joint XI distribution, and it
applies no position or formation constraint.

### Appearance

`p_app = max(p_start, min(start_cap_bp, round(p_app_raw · 10000)))` in
integer bp. There is deliberately **no bench or squad-selection probability**
(1C has no reliable negative squad observations).

### Regulation minutes (0-90)

Conditional minutes use only role-known observations (1C knownness):

* Starter mean: explicit `minutes_played` on selected history rows with
  `lineup_role = starter`, each capped at 90. Fallback 75.
* Substitute mean: explicit `minutes_played` on rows with `lineup_role = bench`
  and `appeared = true`, capped at 90. Fallback 18.
* `lineup_role = unknown` enters neither family, even with `appeared = true`
  and stated minutes.
* `E[min] = p_start · E_start + max(0, p_app − p_start) · E_sub`, stored in
  tenths, clamped to 0..900; null unless projected.
* Sample counts and `used_*_minutes_fallback` flags are stored. Unknown
  minutes are never zero.

### Output and quality

`validateLineupForecastOutput(output, {fixtureId, subjectTeamId, squadStateSha256})`
is the TypeScript form of the stored-output contract. On top of the database
rules above, it checks the parameter version and `invalid_reasons`
consistency. `recordLineupForecastSnapshot` runs it, and checks that the
output players are the artifact's candidates, before calling the RPC.

Per player: canonical and observed ids, presence, history counts
(successes/trials, minutes sample counts), availability status/category/bp,
applied lineup evidence, raw start/appearance bp, start cap bp, projected
start bp, appearance bp, expected minutes tenths, minutes means and fallback
flags, `in_modal_xi`, adjustments, conflict flags, quality flags. Team:
status, λ, total bp, modal XI, the parameter object, the squad-state hash,
and `quality` (candidate count, known start/appearance samples, prior-only
players, minutes-fallback players, availability unknown/conflict counts,
lineup and cross conflicts, provider fallback count, coach conflict).

The payload is stored as `payload.lineup_estimate`. It is bounded by the
registry's 262,144-byte payload limit; a realistic squad is well under 64 KiB
(tested).

## Benchmark metrics (`lineup-scoring.ts`)

Pure, never fitted, never persisted:

* start Brier: mean `(p − y)²` over players whose start truth is known;
* start log loss: probabilities clipped to [1e-6, 1 − 1e-6];
* modal-XI hit count: intersection size 0..11, only when exactly 11 actual
  starters are known;
* minutes MAE: only where actual regulation minutes are explicitly known
  (capped at 90).

Each returns the sample count. Unknown truth is excluded, never scored as zero.

## Leakage protections

* All inputs come from 1C as-of reads (`first_seen_at ≤ cutoff`, cutoff ≤
  kickoff, target fixture excluded from history).
* The registry refuses any membership, tenure, ledger observation, claim or
  resolution first seen after the cutoff, any post-kickoff cutoff, the target
  fixture's ledger data, opponent memberships/tenures/claims, claims of other
  fixtures and history not involving the subject team.
* It also refuses stale or non-history versions that the as-of read would
  never return: superseded ledger, membership, tenure or resolution versions,
  withdrawals, retractions and upcoming-match captures.
* The registry re-runs the 1C as-of read at commit and refuses any frozen set
  that differs from it (complete capture).
* The squad-state hash ties the payload to the frozen artifact bytes, and the
  model refuses a `selected_history` that is not the state's.

## Identity merges

Outputs carry D-050 canonical ids; each player is bound with its canonical id
(active at recording time; merged ids are refused) and an observed raw id
when it differs. A snapshot recorded before a merge keeps its bindings and
replays as `unchanged`. Its frozen artifact still hashes to its SHA, and
replaying it reproduces the stored forecast exactly. A re-run after the merge
binds the survivor and yields a different squad-state hash.

## Known limitations

* Parameters are uncalibrated placeholders for benchmarking.
* A player never seen in a matchday squad (e.g. roster-only) has a known
  non-start record but no known appearances, so `p_app_raw` is the 0.5 prior
  and is flagged `appearance_prior_only`. Interpret appearance probabilities
  for such players with that flag.
* No position, formation or joint-XI structure; no bench probability; no
  coach effect; no time decay inside the 10-match window.
* The database verifies complete capture, artifact/provenance consistency,
  hash consistency, as-of version integrity and the output contract, not the
  derivation itself. A consistently forged state that keeps the same header,
  provenance and candidate ids is detectable only by a TypeScript replay or
  rebuild.
* Deterministic for a given runtime. `Math.exp`/`Math.log` are not required by
  the language to be correctly rounded, so a different JavaScript engine could
  in principle shift a basis point. The stored payload, not a recomputation, is
  the record.

## Not in Foundation 1D

Machine learning or fitted coefficients, calibration, joint XI sampling,
position/formation models, bench or squad-selection probabilities, injury
HMMs, player strength or lineup strength, match engine integration, market
blending, V3 wiring, UI, cron, backfill, production activation and remote
migration application.
