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

1. **Load** raw, cutoff-filtered inputs: `loadSquadStateInputs` →
   `public.squad_state_inputs_as_of` (1C; all leakage filtering happens in the
   database).
2. **State**: the pure `buildFixtureSquadState(inputs, policy)` (1C).
3. **Model**: the pure `buildLineupForecast(lineupModelInput(inputs, state), parameters)`.
4. **Payload**: the pure `buildLineupForecastSnapshot(...)` →
   `buildPredictionSnapshotV2Payload(...)`.
5. **Persist**: `recordLineupForecastSnapshot(rpc, snapshot)` validates and
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
| `prediction_squad_state_context` | one row per lineup forecast | the versions, provider priority, history window and squad-state SHA-256 (below) |

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
target-fixture claim with its exact resolution, every tenure, the context and
the bindings.

### Squad-state context and hash

`prediction_squad_state_context` stores `subject_team_id`,
`squad_state_inputs_contract` (`kapiloto-squad-state-inputs-v1`),
`squad_state_contract` (`kapiloto-squad-state-v1`), `squad_state_builder_version`,
`squad_features_version` (`kapiloto-squad-features-v1`),
`history_selection_policy_version`, `availability_normalization_version`,
`target_date_policy` (`kapiloto-target-date-utc-v1`), the explicit
`provider_priority` array (1-20 distinct provider keys), `history_max_fixtures`
(1-10) and `squad_state_sha256`. Version columns only accept the current 1C
versions.

`squad_state_sha256 = SHA-256(canonicalJson(FixtureSquadState))`, where
canonical JSON sorts object keys at every level, keeps array order, drops
`undefined` and refuses non-finite numbers (`lib/kapiloto-v4/canonical-json.ts`).

The database cannot run the TypeScript builder, so it does not recompute the
state. At commit it verifies that the stored payload describes the frozen
context: `lineup_estimate.fixture_id` = the snapshot fixture,
`lineup_estimate.subject_team_id` = the subject team,
`lineup_estimate.squad_state_sha256` = the context hash, `status = 'projected'`
when predicted, and every `lineup_estimate.players[].canonical_player_id` has
an identity binding. These checks apply whenever a `lineup_estimate` is
stored, including on an abstention.

**Reconstruction** is done in TypeScript: `verifySquadStateReconstruction(inputs, policy, sha)`
rebuilds the state from inputs read with `squad_state_inputs_as_of` at the
snapshot's cutoff and the context's policy, and compares hashes. The as-of
read at the same cutoff returns exactly the frozen link set (asserted in
`registry-v2-db.test.ts`). One limit applies: as-of reads resolve identities
retroactively (D-050) and group claims canonically (D-052). After a later
identity merge, the rebuilt state uses the survivor and its hash differs on
purpose. The frozen bindings and observed ids still prove which ids the live
model used.

### Canonicalization and hashing

* V1: exactly the 1B canonical bundle (`ledger`, `documents`, `claims`,
  `claim_observations`, `references`, `identities`).
* V2: `private.prediction_canonical_inputs_v2` = the V1 canonical bundle of the
  V1 families, plus sorted `memberships`, sorted `tenures` and the normalized
  `squad_state_context` object (or null). Unknown keys are refused at every
  level. `private.prediction_input_bundle_sha256_v2` hashes it.
* The commit-time check rebuilds the bundle from the link rows (including the
  three new tables) and compares it with the stored hash, dispatched by
  contract version.
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
(context present, hash of links). All new rows are immutable (no update,
delete or truncate).

### Security

The three new tables have RLS enabled, no policies, and no
`anon`/`authenticated`/`PUBLIC` grants. Every new function is revoked from
app roles. Only `prediction_record_snapshot_v2` and the two V2 canonical
helpers (called by name from the invoker RPC and check) are granted to
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
`invalid_input` (wrong parameter version, malformed squad-state hash, or
`selected_history` not exactly the state's selected observations). On any
non-projected status there is no team intercept, no modal XI, and projected,
appearance and minutes values are null. Raw per-player values are kept.

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

From accepted (`verified`/`verified_degraded`) `expected_lineup` claims:

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
* `cross_evidence_conflict`: accepted `unavailable`/`suspended` together with
  an applied `starts`/`on_bench` report. Claim adjustments **and** the cap are
  suppressed, and the player falls back to B0
  (`claim_adjustments_suppressed_cross_conflict`). `unavailable`/`suspended`
  with `not_in_squad`, or `doubtful` with `starts`, is consistent and both
  apply.

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

* Starter mean: mean of explicit `minutes_played` on the player's selected
  history rows with `lineup_role = starter`, each capped at 90. Fallback 75.
* Substitute mean: mean of explicit `minutes_played` on non-starter rows with
  `appeared = true`, capped at 90. Fallback 18.
* `E[min] = p_start · E_start + max(0, p_app − p_start) · E_sub`, stored in
  tenths, clamped to 0..900; null unless projected.
* Sample counts and `used_*_minutes_fallback` flags are stored. Unknown
  minutes are never zero.

### Output and quality

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
* The squad-state hash ties the payload to the frozen context, and the model
  refuses a `selected_history` that is not the state's.

## Identity merges

Outputs carry D-050 canonical ids; each player is bound with its canonical id
(active at recording time; merged ids are refused) and an observed raw id
when it differs. A snapshot recorded before a merge keeps its bindings and
replays as `unchanged`. A re-run after the merge binds the survivor and
yields a different squad-state hash.

## Known limitations

* Parameters are uncalibrated placeholders for benchmarking.
* A player never seen in a matchday squad (e.g. roster-only) has a known
  non-start record but no known appearances, so `p_app_raw` is the 0.5 prior
  and is flagged `appearance_prior_only`. Interpret appearance probabilities
  for such players with that flag.
* No position, formation or joint-XI structure; no bench probability; no
  coach effect; no time decay inside the 10-match window.
* The database verifies hash consistency and as-of version integrity, not
  the derivation itself.
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
