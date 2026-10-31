# Kapiloto V4 Foundation 1E-A2-A: provider-native Match Ledger ingest

Decision: D-056. Migration: `supabase/migrations/20261030101247_kapiloto_v4_provider_ingest.sql`.

Stage 1 (D-058) adds V2 ingest, attestation trust and V2 reads next to these
contracts; see "Stage 1 M2A" below. The A2-A trust table below describes the
frozen V1 functions.
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
3. Competition: no mapping gives `competition_unmapped`; a mapping that is not
   `manual_override` gives `competition_untrusted` (see "Historical ingest
   trust boundary").
4. Teams: a missing mapping on either side gives `team_unmapped`; a mapping
   that is neither `manual_override` nor `confirmed` at `mapping_confidence =
   1` gives `team_untrusted`. Both provider teams on one canonical team gives
   `team_identity_conflict`.
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

### Historical ingest trust boundary

V3 keeps its existing, looser resolution rules: it writes `confirmed` mappings
for identities it resolved by name, at `mapping_confidence = 0.9`, and at
confidence 1 when it fetched the fixture by an id it already had. That id can
come from V3's own earlier name-resolved mapping, so V3's confidence 1 is not
independent evidence (see "Stage 0 containment" below). Historical corpus ingestion
intentionally uses a stricter boundary, because a wrong team, competition or
fixture identity silently corrupts every model trained on it, and teams and
competitions cannot be merged later.

| Mapping | Trusted for historical ingest | Otherwise |
| --- | --- | --- |
| Team (`provider_team_mappings`) | `manual_override`, or `confirmed` with `mapping_confidence = 1` | `team_untrusted` (missing row: `team_unmapped`) |
| Competition (`provider_competition_mappings`, no confidence column) | `manual_override` only | `competition_untrusted` (missing row: `competition_unmapped`) |
| Existing fixture mapping for the incoming id | `manual_override`, or `confirmed` with `mapping_confidence = 1` | `fixture_mapping_untrusted` (`unverified`: `fixture_mapping_unverified`) |

- The rules live in `private.provider_mapping_trusted(status, confidence)` and
  `private.provider_competition_mapping_trusted(status)`. The RPC's
  resolution, its post-write re-check and the provider-ref reconciliation all
  call them, so they cannot diverge.
- Ingest never promotes a mapping. The A2-B operator preflight reviews the
  Sportmonks competitions in scope and promotes verified rows to
  `manual_override`. The five pilot competitions were promoted on
  2026-10-30, and V3 reset three of them to `confirmed` within ten minutes
  (`docs/operations/2026-10-30-sportmonks-mapping-overwrite.md`).
  Production Sportmonks team and fixture mappings at `confirmed` with
  confidence 1 may be V3 name matches raised to 1, so they are suspect until
  re-attested, and ingest is paused (D-057).
- The fixture row was added to the boundary because V3's Sportmonks store
  writes the fixture mapping in the same name-resolution path at confidence
  0.9, and the existing-mapping path does not compare kickoffs: a heuristic
  mapping to another meeting of the same two clubs in the same competition
  would otherwise pin a match's history to the wrong canonical fixture.
- Row locks, lock order and the post-write re-check are unchanged; the
  re-check now enforces exactly these trust rules.

### Stage 0 containment: V3 mapping write guard and ingest pause (D-057)

V3's structured sync (the daily cron and the 15-minute precompute job)
upserts every Sportmonks mapping it touches with `ON CONFLICT DO UPDATE`. That
re-points identities, resets `manual_override` to `confirmed`, and raises a
name match from 0.9 to 1 the next time V3 fetches the fixture by its own
mapped id. Migration `20261030211645_kapiloto_v4_identity_mapping_guard.sql`
contains it without changing V3 code.

- **Guard.** `private.guard_v3_identity_mapping_update()` is a row-level
  `BEFORE UPDATE` trigger on `provider_team_mappings`,
  `provider_competition_mappings` and `provider_fixture_mappings`. It fires
  for every Sportmonks row and for every `manual_override` row of any
  provider, and returns `NULL`, so that row's update is skipped:
  - V3's upsert (PostgREST `merge-duplicates`) still succeeds, with no error
    and zero rows changed. None of V3's mapping upserts select, count or
    expect a returned row, and its next write (`fixtures.last_synced_at`) is
    not guarded, so structured sync and snapshots continue.
  - The identity column, `mapping_status`, `mapping_confidence`,
    `provider_name` and `last_verified_at` of those rows no longer change
    automatically: no re-point, no `manual_override` reset, no 0.9 → 1.
  - INSERT is unchanged, so V3 can still add a missing mapping (an
    untrusted name match). DELETE is unchanged, including foreign-key
    cascades from `teams`, `competitions` and `fixtures`.
  - Other providers' rows behave as before unless they are
    `manual_override`.
  - The skipped update still locks the row, so "Mapping row locks" holds
    as written.
- **Operator override.** An operator changes a guarded row only inside a
  transaction that sets the flag locally; it ends with the transaction:

  ```sql
  begin;
  set local kapiloto.identity_operator = 'on';
  update public.provider_competition_mappings set ... where ...;
  commit;
  ```

  PostgREST callers cannot set it: no exposed function sets configuration
  parameters.
- **Ingest pause.** `service_role` no longer has EXECUTE on
  `public.match_ledger_ingest_provider_fixture(jsonb)`, because `confirmed`
  at confidence 1 is reachable by a V3 name match seen twice. Stage 1
  (D-058) replaces that trust rule with V4-owned attestations in a separate
  V2 ingest; the V1 grant never returns, and V2 is granted only by M2B.
  `provider_ingest_record_failure` stays available.
- The guard function is not executable by `anon` or `authenticated` and is
  not SECURITY DEFINER; a trigger function needs no EXECUTE grant to fire.

### Stage 1 M2A: identity attestations and V2 ingest (D-058)

Migration: `supabase/migrations/20261031100000_kapiloto_v4_identity_attestations.sql`.
Code: `lib/kapiloto-v4/identity-attestations.ts`, `provider-ingest.ts`,
`team-match-stats.ts`, `training/team-match-stats.ts`. Architecture:
`KAPILOTO-V4-IDENTITY-ATTESTATIONS-RFC.md`.

**M2A does not enable ingest.** Supabase default privileges grant every new
public function to `service_role`, so
`match_ledger_ingest_provider_fixture_v2(jsonb)` is revoked explicitly from
`public`, `anon`, `authenticated` and `service_role`. The V1 ingest stays
revoked permanently. Only the separate grant-only M2B migration may grant V2.

**Trust rule.** A team or competition identity is trusted only when the
current mapping is `manual_override` AND agrees with the active V4
attestation. Confidence is never consulted; `confirmed` (even at 1) and
`unverified` are never trusted. Stage 0 keeps `manual_override` stable against
automated writers and V3 inserts are always `confirmed`, so deleting an
attested mapping and letting V3 re-insert it cannot restore trust.

**Attestation state** (schema `private`):

- `provider_team_identity_attestations` / `provider_competition_identity_attestations`:
  current projections; primary key per provider ref, unique per canonical
  entity (one id in each direction); canonical FK `ON DELETE NO ACTION`.
- `provider_team_identity_attestation_events` / `provider_competition_identity_attestation_events`:
  immutable history. `attest` opens a generation, `evidence_refresh` continues
  it, `revoke` closes it. Re-attesting after a revoke opens a NEW generation,
  even for the same canonical id. Versions are monotonic per provider ref
  across cycles. Events keep canonical ids without a foreign key.
- The projection always equals its latest non-revoke event (trigger-checked);
  provider ref, canonical id and generation never change in place.
- Evidence (`kapiloto-provider-identity-attestation-evidence-v1`):
  `contract_version`, non-empty `sources`, `reviewed_by`,
  `duplicate_audit_sha256`, at most 64 KiB. Identical basis + evidence is an
  idempotent no-op; changed evidence refreshes within the generation. Evidence
  is audit data, never an authorization input.

**Attest/revoke RPCs** (`provider_identity_attest_team`, `_revoke_team`,
`_attest_competition`, `_revoke_competition`): SECURITY INVOKER, empty
`search_path`, function-level `lock_timeout = 5s`, Sportmonks only, READ
COMMITTED. Each must be the first write of its transaction
(`pg_current_xact_id_if_assigned()` is null), so one identity changes per
transaction and a mapping correction can never share a transaction with an
attest (that would deadlock against an in-flight ingest). Order: exclusive
provider identity lock, mapping row `FOR SHARE`, projection rows
`FOR UPDATE`, then guarded writes. Attest needs an existing `manual_override`
mapping on the requested canonical id and refuses to re-point an active
attestation or give a canonical entity a second provider id. Revoke needs the
expected canonical id and a reason; it never touches the V3 mapping.

**Write guards.** Projection INSERT/UPDATE/DELETE and event INSERT need the
transaction-local flag the RPC sets only around its own DML (cleared on
success and on exception) AND the exclusive provider identity advisory lock
held by the same backend. Events reject UPDATE/DELETE/TRUNCATE. This stops
accidental writes by application code; it does not make a deliberately
malicious `service_role` (BYPASSRLS, able to set the flag and take the lock)
cryptographically unable to manufacture rows.

**Observation provenance.**
`public.match_ledger_observation_identity_attestations` seals, per V2-recorded
observation version, the league/home/away attestation event and generation,
provider ref and canonical id. Typed FKs: `team_attestation_event_id` for team
refs, `competition_attestation_event_id` for the league, exactly one set. A
BEFORE INSERT check requires the V2 ingest flag, the shared provider identity
lock, a matching sealed provider ref, and the projection's current (latest)
event of the same generation and canonical id. Sealed to the writing
statement; immutable. Plain 1A writes have none.

**V2 ingest** (`match_ledger_ingest_provider_fixture_v2`): the A2-A contract,
phases and player semantics, plus:

- a run is mandatory: it must exist, belong to the provider and carry a
  non-empty `scope.provider_fixture_ids`; an unlisted fixture is an audited
  quarantine (`fixture_outside_run_scope`) before any write. The run row is
  immutable. This contains accidents; it is not a boundary against a malicious
  `service_role`, which can create another run;
- trust codes: `competition_unmapped`, `competition_mapping_not_manual_override`,
  `competition_attestation_missing`, `competition_attestation_mismatch`,
  `team_unmapped`, `team_mapping_not_manual_override`,
  `team_attestation_missing`, `team_attestation_mismatch`;
- an existing provider fixture mapping is a pointer, not trust. `unverified`
  quarantines. Otherwise the team-pair lock is taken (on BOTH paths now), the
  full A2-A candidate classification runs, the mapped fixture row is locked
  `FOR SHARE`, and the mapping is accepted only if its fixture has the attested
  orientation, the attested non-null competition, a kickoff within 48 h, a
  status other than postponed/suspended/cancelled/under_review, is the only
  candidate carrying the incoming id, is the only valid `N` candidate, and no
  other candidate is guarded or identity-conflicting. The validated row is
  never counted as a conflict with itself. Codes: `fixture_mapping_team_conflict`,
  `_orientation_conflict`, `_competition_conflict`, `_kickoff_conflict`,
  `_status_conflict`, `_provider_identity_conflict`, `_candidate_ambiguous`,
  `_competition_unknown`, `_possible_postponement`, `_reschedule_conflict`,
  `fixture_mapping_conflict`. A bad mapping never falls back to another
  candidate. This closes the Toto-reschedule case: the orphaned old fixture
  and the re-dated one are both `N` (ambiguous), or the old one fails the
  kickoff check;
- the no-mapping path keeps the A2-A attach/mint rules; the attach target is
  re-read `FOR SHARE` (`fixture_candidate_changed` if its facts moved);
- generation continuity: when the latest version's sealed generations are not
  the current ones and 1A finds the football content unchanged, the call
  quarantines `attestation_generation_stale` (phase 2 rolled back) instead of
  returning `unchanged`. Changed content records a new version under the
  current generations. A family-status upgrade with no content change is the
  A2-A `family_status_drift` quarantine and takes precedence; neither writes;
- a second mint for the same provider fixture id (A2-A mint provenance is
  unique per `(provider, provider_fixture_id)`) quarantines
  `fixture_mint_exists` with the minted fixture id in the detail, before any
  write;
- the post-write re-check covers mappings, projections (same generations),
  the fixture mapping, the fixture's facts and the candidate window.

Lock order: provider-fixture advisory, provider identity (shared), competition
mapping, competition projection, team mappings, team projections (sorted),
incoming fixture mapping, team-pair advisory, candidate mapping rows, selected
fixture row, writes, 1A fixture/provider advisory, players identity. Attest
takes the provider identity lock exclusive first and none of the ingest-only
locks, so the two cannot form a cycle. The function-level 5 s `lock_timeout`
bounds every wait of a V2 call, including the provider-fixture advisory lock:
two concurrent V2 calls for the same provider fixture id no longer serialize
as V1 did; the second fails after 5 s and the caller retries. Accepted
residual: the Toto import
takes no pair lock and can insert a brand-new duplicate fixture while an
existing-mapping ingest is in flight (no row exists to lock); that equals
"ingest first, import second", and the next attempt quarantines.

**V2 reads.** `match_ledger_team_match_stats_as_of_v2` and
`_for_training_v2` return the V1 row shape over an attestation-gated row set
(`kapiloto-team-match-stats-v2`). The V1 selection, availability and
supersession rules run first; the selected version must then have sealed
league/home/away refs and sidecars whose typed event belongs to the sealed
generation, that generation must still be the current projection, and the
current mapping must be an agreeing `manual_override` row. An untrusted
selected version drops the fixture; it never falls back to an earlier version.
Every provider is gated the same way: plain 1A writes, A2-A (V1) ingests and
providers without Stage 1 attestations return zero V2 rows. A revoke removes a
generation at once; re-attesting the same team opens a new generation and does
not bring old observations back. `match_ledger_retrospective_training_exclusions_v2`
keeps `later_correction` / `later_withdrawal` and adds `attestation_missing`,
`generation_revoked` (revoked, nothing active), `attestation_generation_stale`
(revoked and re-attested), `mapping_missing`, `mapping_not_manual_override`
and `mapping_disagrees`. Recovery written as a later version is available only from
its real `first_seen_at`: availability policy V1 backdates version 1 only.

**Reports.**

- `provider_identity_attestation_conflicts(provider)`: entity level, works
  with zero observations. Blocking: `attested_mapping_missing`,
  `attested_mapping_disagrees`, `attested_mapping_not_manual_override`,
  `shadow_mapping_for_attested_canonical` (warning when the shadow row is
  `unverified`). Warning: `mint_without_mapping` (`entity_kind = 'fixture'`,
  `provider_ref` = the provider fixture id, `mapping_canonical_id` = the minted
  fixture): a fixture this provider's ingest minted no longer has its provider
  fixture mapping, i.e. a withdrawn chain under recovery. Info:
  `mapping_unattested`.
- `match_ledger_provider_ref_conflicts_v2(provider)`: observation level, per
  ref: `*_mapping_missing`, `*_mapping_not_manual_override`,
  `*_attestation_missing`, `*_mapping_attestation_mismatch`,
  `*_attested_canonical_drift`, `*_attestation_generation_stale`, and
  `fixture_competition_drift`.
- `provider_identity_revocation_impact(provider, entity_kind, provider_ref)`:
  observation versions sealed under each generation (active/revoked, latest
  or not), their fixture mappings and A2 mints, and unattested observations
  naming the ref or its canonical ids.

**De-authorized V1 contracts.** Present for inspection, not executable by
`service_role`: `match_ledger_team_match_stats_as_of`,
`match_ledger_team_match_stats_for_training`,
`match_ledger_retrospective_training_exclusions`,
`match_ledger_provider_ref_conflicts`. `match_ledger_mapping_conflicts` is
unchanged.

**Reads not covered by Stage 1 (M2B gate).** `squad_state_inputs_as_of`,
`match_ledger_observation_as_of`, `match_ledger_provider_team_matches_as_of`,
`match_ledger_provider_player_matches_as_of` and the lineup/squad-state
snapshot paths that depend on them are unchanged and not attestation-aware. A
boundary test proves no production app, script or cron path calls them (or
any V4 ingest/read RPC). M2B stays NO-GO until they are versioned or kept
disabled under that gate.

**Recovery.** Revoke (V2 reads are safe at once), read the impact report,
withdraw affected chains through the 1A withdrawal, delete or re-point the
fixture mapping as an operator with the expected old value in the predicate,
correct the team/competition mapping in its own transaction, attest the right
identity (new generation), re-ingest under an allow-listed run. Tested end to
end for attaching to an existing correct canonical fixture.

A chain V2 wrongly **minted** is never minted again: the applied A2-A
`match_ledger_fixture_mints` is unique per `(provider, provider_fixture_id)`,
and V2 quarantines `fixture_mint_exists`. Recovery of a minted chain is: the
operator creates the reviewed canonical `fixtures` row (correct teams,
competition, kickoff, `finished`), and the re-ingest attaches to it (tested).
The wrongly minted fixture remains a historical orphan with a withdrawn chain
and no provider mapping; the readiness report lists it as
`mint_without_mapping` until an operator decision about the orphan row.

### Canonical identity rules

- **Competitions and teams are never created** by A2-A code. Operators
  reconcile them in A2-B. Teams and competitions have no merge support
  (D-050), so a wrong team cannot be repaired later.
- **Fixture resolution.**
  - An existing provider fixture mapping wins:
    - if trusted (see the table above), its orientation and competition are
      validated (`fixture_mapping_conflict` otherwise);
    - if `unverified`, the result is `fixture_mapping_unverified`; if
      `confirmed` below confidence 1, `fixture_mapping_untrusted`.
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
mix old and new mapping states. Since D-057 an automated update of a
Sportmonks or `manual_override` row is skipped outright; the row locks remain
the guarantee against operator updates, deletes and any other writer.

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
delete. Since D-057 its updates run as an identity operator; without the
flag the same update is skipped and the call records under the real
identity.

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
   ingest just inserted waits for the ingest to commit; since D-057 its
   update of that Sportmonks row is then skipped. An operator repoint is
   detected the same way.
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
`team_home` and `team_away`, each with the canonical id it resolved to when
the version was written (`canonical_id`: the competition for `league`, the
team for the team refs, null for `season`; a trigger checks the team ids
against the version's team records). `match_ledger_observation_family_fetches`
holds one status per family. Both are:

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
  - **Known-superseded content is excluded, never rewritten.** If the version
    selected for a fixture at the training cutoff is not the chain's latest
    version today, the fixture is left out of that training query. The later
    version (a correction or a withdrawal) exists but is not yet effective at
    the cutoff. Because effective times are monotone in the version number,
    that is the same as "a later version exists". The later version is never
    backdated. Once the cutoff reaches its actual `first_seen_at`, normal
    selection returns it.
  - Exclusions are auditable separately from stat missingness:
    `match_ledger_retrospective_training_exclusions(provider,
    competition_ids, from, training_cutoff, policy)` (TS:
    `loadRetrospectiveTrainingExclusions`, training module only) lists one
    row per excluded chain with the same filters as the training read, the
    selected and latest versions, and `exclusion_reason` `later_correction`
    (latest version is an observation) or `later_withdrawal` (latest version
    is a withdrawal). It is not football data.
  - Why omission rather than a row with an "unusable" status: a status column
    in the training stream would be silently consumed by any caller that does
    not filter it, while omission fails closed by default and the report keeps
    the count.
  - Rows are `evaluation_class = 'retrospective'`, and backdated rows are
    `availability_basis = 'retrospective_backfill'`.
  - In short, `kapiloto-retrospective-training-availability-v1` means:
    assumed availability only for the original backfill observation, and
    known-superseded historical content is excluded rather than rewritten.
  - The strict actual read, the Prediction Registry and Squad State are
    unchanged and never use this policy.
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

It never updates an existing `fixtures` row. The A2-A migration adds no
trigger, constraint or index to V3 tables; the D-057 guard (see "Stage 0
containment") is the one deliberate exception.

Known V3 hazards are documented, not fixed in A2-A:

- The V3 Sportmonks store upserts `provider_team_mappings` on
  `(provider, provider_team_id)`, which could re-point a mapping. Since
  D-057 its update of an existing Sportmonks row is skipped, so it can only
  add a missing mapping.
- The same store upserts `provider_fixture_mappings` on
  `(fixture_id, provider)`; since D-057 it cannot move an existing
  Sportmonks fixture mapping, and a V3 write for a fixture A2 minted still
  collides on `(provider, provider_fixture_id)`.
- The Toto import creates teams by exact lower-cased name.

While an ingest runs, the competition, team and fixture mapping rows it
resolved are held `FOR SHARE`, so a V3 upsert of them waits for the ingest to
finish (see "Mapping row locks").

The 1A `match_ledger_mapping_conflicts()` read detects fixture-mapping drift.
A2-B must reconcile team identities before ingesting a competition.

## Provider-ref reconciliation

`public.match_ledger_provider_ref_conflicts(provider)` is read only (`STABLE`,
`service_role`; TS: `loadProviderRefConflicts`). For every observation
version with sealed refs, it compares each sealed `league` / `team_home` /
`team_away` ref and its recorded canonical id with today's mapping under the
historical trust rules. Columns:

- `issue_code`;
- `observation_id`, `observation_version`, `is_current_version`;
- `fixture_id`, `provider_fixture_id`;
- `ref_kind`, `provider_ref`;
- `recorded_canonical_id`, `current_canonical_id`;
- `current_mapping_status`, `current_mapping_confidence`.

| Issue code | Meaning |
| --- | --- |
| `team_mapping_missing` | no current mapping for the sealed provider team id |
| `team_mapping_untrusted` | current mapping fails the team trust rule |
| `team_mapping_drift` | current mapping points to a different canonical team |
| `competition_mapping_missing` | no current mapping for the sealed provider league id |
| `competition_mapping_untrusted` | current mapping is not `manual_override` |
| `competition_mapping_drift` | current mapping points to a different canonical competition |
| `fixture_competition_drift` | the canonical fixture's current `competition_id` differs from (or no longer carries) the sealed competition |

- "missing" excludes the other two codes for the same ref; "untrusted" and
  "drift" are independent and can both appear.
- Rows are ordered by fixture, observation version, ref kind and code.
- Teams have no merge semantics, so team ids are compared as stored.
- Observations written without sealed refs (plain 1A writes) are outside this
  report. Fixture-mapping drift stays in the unchanged 1A
  `match_ledger_mapping_conflicts()`.
- Detection only: nothing is mutated.

## A2-B (not in this change)

A2-B covers:

- an operator CLI that captures bundles, hashing the exact response bytes and
  setting fetch statuses honestly;
- a verified entitlement snapshot and a run header;
- team and competition reconciliation, including the preflight that promotes
  verified Sportmonks competitions to `manual_override`, and
  `match_ledger_provider_ref_conflicts` as a pilot and backfill gate;
- a small pilot that checks the seeded definitions against real payloads.

No migration is required unless the pilot finds a documentation/payload
mismatch, which would be fixed with a new `definition_version`.

### Pilot gates (not A2-A database invariants)

These must be verified on real Sportmonks payloads during the A2-B pilot
before they become rules. A2-A deliberately does not enforce them:

- cross-stat checks that are sensible but unverified: possession summing to
  98-102, `shots_on_target <= shots_total`, `npxG <= xG`;
- whether genuine zero statistics arrive as explicit zero rows or as omitted
  rows (A2-A infers nothing about provider-side zero semantics);
- lineup type ids 11 (starter) and 12 (bench);
- position ids 24-27 (GK/DF/MF/FW);
- `2ND_HALF` being the cumulative 90-minute score (checked against `CURRENT`
  for FT matches; relied on alone for AET/FT_PEN);
- participant `meta.location` as the home/away source.

## Security

- All five new tables have RLS enabled, no policies, and no
  `anon`/`authenticated` grants.
- The four public functions and the private helpers they call by name are
  executable by `service_role` only. While ingest is paused (D-057),
  `match_ledger_ingest_provider_fixture` is not executable even by
  `service_role`.
- There is no SECURITY DEFINER.
- Audit, annotation and mint rows are immutable.
