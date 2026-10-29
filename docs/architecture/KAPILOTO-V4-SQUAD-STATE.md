# Kapiloto V4 Foundation 1C: roster membership and pre-match squad state

Status: implemented (storage, deterministic derivation, audit only). Decision D-053.
Migration: `supabase/migrations/20261029074019_kapiloto_v4_roster_squad_state.sql`.
Contracts: `lib/kapiloto-v4/roster.ts`, `lib/kapiloto-v4/squad-state.ts`.

1C answers: "Immediately before fixture F, what squad state could Kapiloto
legitimately construct for team T from information it actually had at
cutoff C?" It is the deterministic input layer for a future availability →
expected lineup → minutes → replacements → lineup strength chain. **1C outputs
no lineup probability of any kind.**

The applied 1A/1B migrations are not modified; a test pins their content
hashes. Nothing in V1/V2/V3 reads these objects.

## Layers (never collapsed)

| Layer | Source | 1C object |
| --- | --- | --- |
| Roster membership assertion | A source says P belongs to T in a date interval | `team_player_memberships` |
| Historical participation | Match Ledger (1A) | selected history in the squad state |
| Availability evidence | `player_availability` claims (1B) | `candidate.availability` |
| Reported lineup evidence | `expected_lineup` claims (1B) | `candidate.reported_lineup` |
| Squad-state features | Deterministic summaries of the above | `FixtureSquadState` (in memory, not persisted) |
| Expected-lineup model | — | **Not part of 1C** |

## Roster membership

`team_player_memberships` mirrors `team_coach_tenures`:

- **Immutable, versioned assertions.** `membership_key` is the stable
  identity; `membership_version` is assigned under a per-key advisory lock
  (READ COMMITTED). A correction is a new version, and so is a retraction
  (`assertion_status = 'retracted'`). Nothing is ever updated or deleted.
- **Information time.** `first_seen_at` is stamped by
  `private.kapiloto_information_clock()`. A writer cannot supply or backdate
  it. It never precedes the previous version or the source document version
  (`document_version_id`).
- **Uncertain dates.** Starts and ends are inclusive intervals
  (`starts_on_earliest..starts_on_latest`, optional
  `ends_on_earliest..ends_on_latest`, both null while open). They are never
  made exact.
- **Provenance.** Each assertion records `source_kind`, `provider`,
  `provider_record_id`, `source_reference`, `source_fingerprint`, an
  optional `document_version_id`, `retrieved_at` and `ingest_version`.
- **Identity (D-050).**
  - Writes name surviving canonical players only, under the shared identity
    lock. A stale merged id is refused, never silently canonicalized.
  - A key never changes team or person. A later version of a membership
    first asserted for a since-merged player A names A's survivor B.
  - Reads report `observed_player_id` (stored) and `canonical_player_id`
    (current survivor).
- **Overlaps.** Overlapping or uncertain assertions from different sources
  are allowed. Nothing infers transfer or loan truth from them.

**`team_player_memberships_as_of(team, cutoff, date)`** applies:
1. `first_seen_at <= cutoff`;
2. the latest version per key;
3. a retracted latest version drops the membership;
4. only then the date bounds.

| Coverage | Rule (date `d`) |
| --- | --- |
| `outside` | `d < starts_on_earliest`, or `d > ends_on_latest` |
| `certain` | `d >= starts_on_latest` and (open, or `d <= ends_on_earliest`) |
| `possible` | otherwise: `d` falls inside a bound's uncertainty |

## Inputs and the pure builder

`squad_state_inputs_as_of(fixture, team, cutoff, history_fixture_limit)`
(service_role only) returns cutoff-filtered **raw** inputs
(`kapiloto-squad-state-inputs-v1`). It fails closed only when the fixture
cannot be resolved, the team does not play it, or the cutoff is after the
canonical kickoff (actual when known). It returns:

- **history:** every provider's latest visible version (`first_seen_at <=
  cutoff`; a withdrawal hides the pair) of the team's finished fixtures that
  kicked off before the target, never the target itself. Player and coach
  ids come with their current survivors.
- **memberships:** the as-of read above, for the target date.

**Target date (`kapiloto-target-date-utc-v1`).** Membership and tenure
coverage use the UTC calendar date of the canonical kickoff. This is
deterministic, but not necessarily the competition-local football date: a
kickoff shortly after local midnight in Israel (UTC+2/+3) falls on the
previous UTC calendar day.
The inputs and the state report `target_date_policy`. Competition or team
time zones are a future schema concern.
- **claims:** target-fixture `player_availability` / `expected_lineup`
  canonical claim groups (D-052) known at the cutoff, about a player, for
  this team or with no team, each with its as-of belief.
- **tenures:** `team_coach_tenures_as_of(team, cutoff)`.

`loadSquadStateInputs` calls it through a minimal RPC caller.
`buildFixtureSquadState(inputs, policy)` is a pure, deterministic function
with no database calls. Its output (`kapiloto-squad-state-v1`) carries:

- the fixture context (side, opponent, canonical kickoff, cutoff);
- the builder, selection and normalization versions;
- exact provenance: selected and considered ledger observation ids,
  membership ids, canonical and member claim ids, resolution ids, tenure ids,
  and canonical player and coach ids.

## History selection (`kapiloto-history-selection-v1`)

1A history is provider-scoped; 1C fuses it so a fixture is never counted
twice. The policy takes an **explicit provider priority**. Providers not
listed are not used. For each historical fixture:

1. usable = player family `complete` or `partial` with player rows, from a
   listed provider (`not_provided` and empty lineups are excluded);
2. `complete` beats `partial`;
3. then provider priority;
4. exactly one observation is chosen, and player rows are never combined
   across providers.

Each choice records its reason (`only_usable_observation`,
`complete_over_partial`, `provider_priority`), every alternative with why it
lost, and `provider_fallback` when a higher-priority provider was present but
not chosen. The latest 10 selected fixtures (by kickoff) are used. A better
observation first seen after the cutoff cannot replace an earlier visible
one. There is no reliability learning and no averaging.

## Candidate universe

A player is a candidate if ANY of these hold:
- a visible membership is `certain` or `possible` at the target date;
- he appears in the selected history;
- there is a target-fixture availability claim about him;
- there is a target-fixture lineup claim about him.

Candidates are keyed by canonical id, so a merged duplicate is one
candidate with all its observed ids. `presence` is one of
`roster_and_history`, `roster_only`, `historical_only` or `claim_only`.
Nobody is pruned to 11, 18, 20 or 23. A claim with no team is attributed only
if the player is already in the roster/history universe; otherwise it is
listed in `quality.unattributed_claim_ids`.

## Player history features (`kapiloto-squad-features-v1`)

All features are raw deterministic counts over the selected fixtures. There
is no weighting, no learned score and no form rating. **Each feature has its
own knownness; unknown is never a zero and never enters a denominator.**
Every 3/5/10 window carries `available_matches` = the matches in the window
where that feature is known (never padded to the window size).

| Knownness | Known when | Unknown when |
| --- | --- | --- |
| Start | starter (1) or bench (0) row; absence from a `complete` lineup (0, see below) | `lineup_role = unknown`; absence from a `partial` lineup |
| Appearance | starter (1); a row with `appeared` true/false | non-starter with `appeared = null`; any absence |
| Minutes | `minutes_played` stated; 0 when the row says `appeared = false` | missing `minutes_played` otherwise; any absence |
| Squad | the player has a row (positive) | any absence: a squad negative is never inferred in V1 |

**What `lineup_status = 'complete'` proves (decision B, fail closed).**
- **What the database enforces:** 1A enforces only that a `complete` lineup
  has exactly 11 starters. The 1A docs describe `complete` both as "a claim
  of full representation" and as "exactly 11 starters".
- **What nothing guarantees:** no ingester enumerates the bench. A database
  test (`squad-state-db.test.ts`) shows 1A accepts a `complete` lineup of 11
  starters and no bench rows at all.
- **What 1C infers:** absence from a `complete` lineup is used only for what
  is structurally proven, "did not start". It never manufactures "not in the
  squad", "did not appear" or "0 minutes".
- **Future upgrade:** an explicit matchday-squad completeness signal would be
  needed to infer squad negatives.

**Feature audit.**

| Feature | Kind | Missing data |
| --- | --- | --- |
| `squad_appearances`, `matches_with_known_status` | positive count (rows) | absence never counted as a negative |
| `starts` / `start_known_matches`, `starts_last` | rate with start-known denominator | `unknown` role or partial absence excluded |
| `appearances` / `appearance_known_matches`, `appearances_last` | rate with appearance-known denominator | `appeared = null` or absence excluded |
| `minutes_total` / `minutes_known_matches`, `minutes_last` | sum with minutes-known denominator | missing minutes excluded, never 0 |
| `full_regulation_starts` / `starts_with_known_minutes` | rate with explicit-minutes denominator | a start without stated minutes never counts |
| `bench_unused` | explicit known negative (`appeared = false`) | — |
| `bench_appearance_unknown` | explicit unknown count | — |
| `sub_on`, `sub_off` | lower bound from listed substitutions | missing substitution data is not zero |
| `early_exits_before_60` | lower bound: explicit `exited_minute < 60` | a missing exit is never assumed |
| `consecutive_starts` | streak | stops at a known non-start or an unknown start |
| `captain_starts` | lower bound: `is_captain = true` | null is not "not captain" |
| position / formation-slot histograms, `last_*_kickoff` | positive observations | — |

**Full regulation starts.** A start counts only with explicit
`minutes_played >= 90` and no stated exit before minute 90: the player was on
the pitch for all of regulation time. It is not "full match": whether an
extra-time match was played to 120 is not derived. A starter with no stated
minutes and no exit never counts, because a missing exit is not evidence of
playing on.

## Replacement patterns

Every observed substitution pair (canonical off → canonical on) across the
selected history is kept with:
- its count;
- its minutes and median minute;
- exact fixture/observation provenance, including the observed raw ids.

It is an observed historical pattern, not a tactical claim, a probability or
a graph embedding.

## Availability and reported-lineup evidence

**Scope.** Only target-fixture claims visible at the cutoff count, using
D-052 canonical claim groups. The raw claim value, canonical and member claim
ids, resolution id and status, resolution time, quality flags and claim kind
are all kept.

| Resolution | Standing |
| --- | --- |
| `verified`, `verified_degraded` | accepted evidence (flags kept) |
| `unresolved` | evidence, never a hard conclusion |
| `quarantined`, `contradicted`, `fabricated` | audit only; never drives state |

**Normalization table (`kapiloto-availability-normalization-v1`).** Keys are
compared after trimming, lower-casing, and turning spaces/hyphens into
underscores:

| Category | Raw values |
| --- | --- |
| `available` | available, fit, fully_fit, cleared |
| `doubtful` | doubtful, doubt, questionable, fitness_test, late_fitness_test |
| `unavailable` | out, unavailable, injured, ruled_out, ill, illness |
| `suspended` | suspended, suspension, banned |
| `returning` | returning, returned_to_training, back_in_training, nearing_return |
| `unknown` | anything else, including "rotation risk"; the raw value is kept |

A negated claim is never guessed into a category; it stays `unknown`.

**Conflicts.** If accepted evidence implies two different categories,
`availability_conflict = true` and `accepted_category = null`. Both claims
stay visible. There is no publisher priority and no reliability weighting.

**Reported lineups.** `expected_lineup` claims (`starts`, `on_bench`,
`not_in_squad`) are stored as evidence with the same standing rules. There is
no selected lineup field, and a report never overrides history.

## Coach state

Coach state is built from visible tenures (coverage at the target date) and
the selected history:

| Provenance | When |
| --- | --- |
| `ledger_and_tenure` | the latest selected match's coach is the only active-tenure coach |
| `ledger_only` | ledger coach, no active tenure |
| `tenure_only` | one active-tenure coach, no ledger coach |
| `conflict` | ledger and tenure disagree, or several active-tenure coaches |
| `unknown` | neither family has evidence |

On `conflict`, `current_coach_id` is null and every candidate is listed;
Kapiloto never invents a coach. Coach ids are canonical (D-050), so a merged
coach agrees with its survivor. Matches per coach in history are reported,
but no tactical regime effect is inferred.

## Data quality

`quality` reports, independently per family:
- usable, complete and partial history matches; excluded fixtures; provider
  fallbacks;
- active roster assertions and candidates with roster coverage;
- candidates without recent history;
- unresolved availability claims and availability conflicts;
- the coach conflict;
- unattributed claims.

A missing family never collapses the state to "insufficient data".

## Leakage guarantees

Every source is filtered in the database on its `first_seen_at` (memberships,
ledger versions, claims and claim groups, resolutions, tenures) before any
selection:
- a membership backfilled later, or corrected or retracted after the cutoff,
  does not change an earlier read;
- a later or better ledger version does not replace an earlier visible one;
- the target fixture is never history, and its result is invisible even at a
  cutoff equal to kickoff;
- a cutoff after the canonical kickoff is refused.

Identity is current (D-050): a later merge changes canonical reads, never
raw rows.

## Prediction Registry gate (1D prerequisite)

1C does not power any persisted prediction, and the Prediction Registry is
unchanged. **Before any 1D lineup model is activated for a persisted
prediction, the Prediction Registry must gain a versioned way to freeze exact
roster-membership and coach-tenure inputs** (for example a new link-table
family under a new snapshot contract version). It must not change the meaning
or hash of existing `kapiloto-prediction-snapshot-v1` records. The existing
input-bundle hash contract must not be silently extended.

**Satisfied by Foundation 1D (D-054).** `kapiloto-prediction-snapshot-v2`
freezes every input that can change this state: selected and alternative
ledger observations (`squad_history_selected` / `squad_history_alternative`),
memberships (`squad_membership`), target-fixture claims with their exact
resolution (`squad_availability_claim` / `squad_lineup_claim`), tenures
(`squad_coach_tenure`), identity bindings, and a squad-state context with the
1C versions, the explicit provider priority, the history window and
`squad_state_sha256 = SHA-256(canonical JSON of FixtureSquadState)`. The V1
contract and its hashes are unchanged. See
`docs/architecture/KAPILOTO-V4-LINEUP-MODEL.md`.

## Not in Foundation 1C

Expected XI, starting, bench or minutes probabilities; availability or
lineup HMMs; player strength/RAPM; lineup strength; tactical style or regime
effects; the matchup or match engine; calibration; market blending;
source/journalist reliability learning; the VOI planner; query bandits;
prompt changes; Toto optimization; UI; cron; roster/provider backfill;
production activation. There is no machine learning in 1C.
