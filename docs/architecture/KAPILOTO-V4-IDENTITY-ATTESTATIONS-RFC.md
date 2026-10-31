# Kapiloto V4 Stage 1 RFC — Provider Identity Attestations

Status: **M2A implemented and applied to production; M2B remains gated**  
Scope: V4 historical-ingest trust only  
Related decisions: D-056, D-057  
Current production state: D-057 Stage 0 containment is applied; Sportmonks V3 identity writes are insert-only; historical provider ingest remains paused.

Production application: M2A migration `20261031100000_kapiloto_v4_identity_attestations.sql` was applied on 2026-10-31 from merge commit `5327dc371751a75b79d2c2612471b55b7c6436af`. Post-checks confirmed `private` is not Data-API exposed, both V1/V2 ingest remain revoked from `service_role`, and no attestation or Match Ledger observation was created by deployment.

This RFC defines the Stage 1 trust architecture that must exist before any real Match Ledger provider ingest resumes.

It is deliberately stricter than V3. The goal is not to make V3 identity resolution more sophisticated. The goal is to ensure that V4 historical data can never inherit trust merely because an automated V3 writer populated or refreshed a mapping row.

---

## 1. Problem statement

A2-A originally trusted:

- competition mappings only when `manual_override`;
- team and existing fixture mappings when `manual_override`, or `confirmed` at `mapping_confidence = 1`.

That was invalidated by the 2026-10-30 production incident:

- V3 Sportmonks sync could repeatedly update existing mappings;
- `manual_override` could be downgraded to `confirmed`;
- a name-resolved mapping at 0.9 could become 1 after V3 fetched by the provider id it had previously written itself;
- the same write path ran through both the daily structured-sync and the 15-minute proactive precompute path.

D-057 contains that failure mode:

- database triggers suppress automated UPDATEs of protected mappings;
- V3 Sportmonks writes are now insert-only and remain weak evidence at confidence 0.9;
- historical ingest is paused.

Containment is not a final trust model. A V4 historical corpus must rely on evidence owned by V4, not on V3's operational mapping columns.

---

## 2. Design goals

Stage 1 must provide all of the following:

1. **Independent trust ownership.** V4 attestation state is the trust root. V3 mapping confidence is never sufficient.
2. **Stable mapping prerequisite.** For Stage 1 Sportmonks trust, the current team/competition mapping must be `manual_override` **and** agree with the V4 attestation. `manual_override` is necessary but never sufficient. Stage 0 makes this one mapping state stable against V3 automation; a V3-created `confirmed` row can therefore never regain trust by itself.
3. **Trust enforced on write and read.** The ingest RPC gates new writes, and model-facing V2 readers exclude observations that lack sealed attestation provenance or whose attestation generation is later revoked/replaced.
4. **Mapping + attestation agreement.** Current provider mapping and current V4 attestation must resolve the same canonical entity.
5. **Injectivity at the trusted boundary.** One provider team id may attest one canonical team, and one canonical team may have at most one active attested id for that provider. Same for competitions.
6. **Explicit re-pointing.** A canonical re-point requires revoke -> mapping correction -> re-attest in separate transactions. It never occurs through an upsert.
7. **Auditable provenance.** Every attest/refresh/revoke action is immutable, and every V2-ingested observation seals the exact attestation generation/event used for league/home/away identity.
8. **Recoverability.** Revocation immediately removes affected observations from model-facing V2 reads; an impact report and rehearsed recovery runbook identify and repair affected mappings/fixture chains.
9. **Stable concurrency semantics.** Ingest and attestation mutation serialize through a provider-level advisory lock plus deterministic row locks.
10. **Fixture trust independent of V3 confidence.** Existing fixture mappings are operational pointers only. They are accepted only if the same candidate algorithm would uniquely select that fixture from attested teams/competition/orientation/kickoff/status.
11. **Players remain separate.** Player bootstrap/merge semantics from 1A/A2-A are unchanged.
12. **Additive/versioned migration discipline.** Stage 1 adds V2 ingest/read/report functions; V1 contracts remain present and are not silently redefined.
13. **Activation is separate and bounded.** M2A builds trust while ingest remains disabled. M2B later grants only the V2 ingest RPC, whose run scope explicitly allow-lists provider fixture ids.

---

## 3. Non-goals

Stage 1 does not:

- perform the 15-team reconciliation;
- create missing canonical teams automatically;
- auto-attest existing Sportmonks mappings;
- grandfather `confirmed + confidence=1`;
- create fixture attestations;
- redesign player or coach identity;
- amend the A2-B payload pilot;
- start a historical backfill;
- change V3 probability/research behavior;
- re-enable `match_ledger_ingest_provider_fixture(jsonb)` for `service_role`.

---

## 4. Architectural boundary

The identity stack after Stage 1 is:

```text
provider payload
    |
    v
current Sportmonks mapping row
(must be manual_override for team/competition)
    |
    | exact canonical-id agreement
    v
V4 active attestation projection
    |
    | immutable generation/event history
    v
V2 ingest identity trust
    |
    | fixture uniqueness/fact validation
    v
Match Ledger observation
    |
    | seals league/home/away attestation event ids
    v
V2 historical readers
    |
    | require mapping + current generation + no revoke
    v
model/training corpus
```

The mapping row remains operational identity data. The attestation is the V4 trust statement. The sealed attestation provenance makes that trust auditable per observation.

Neither mapping nor attestation is sufficient alone. A direct 1A ledger write may continue to exist for internal/foundation use, but it has no Stage 1 attestation sidecar and therefore is excluded from model-facing V2 reads.

---

## 5. State model

Use separate typed team and competition projections plus immutable event logs. This keeps foreign keys and active injectivity explicit while preserving complete history.

### 5.1 Current team attestation projection

Private table: `private.provider_team_identity_attestations`.

Core columns:

```text
provider
provider_team_id
team_id                     uuid -> public.teams(id) ON DELETE NO ACTION
attestation_generation_id   uuid
attestation_version         integer
latest_event_id             uuid
attestation_basis           text
evidence                    jsonb
evidence_sha256             text
first_attested_at           timestamptz
attested_at                 timestamptz
attested_by                 text
```

Constraints:

- primary key `(provider, provider_team_id)`;
- unique `(provider, team_id)`;
- active canonical FK uses `ON DELETE NO ACTION`: a canonical row cannot disappear while attested;
- version >= 1;
- evidence must satisfy the contract in §6;
- M2A RPCs initially accept `provider = 'sportmonks'` only; the tables may remain structurally provider-generic for a later migration.

### 5.2 Current competition attestation projection

`private.provider_competition_identity_attestations` has the analogous columns, with `competition_id -> public.competitions(id) ON DELETE NO ACTION`, primary key `(provider, provider_competition_id)` and unique `(provider, competition_id)`.

The uniqueness is deliberately fail-closed. If a provider legitimately exposes several league ids for one canonical competition, Stage 1 requires an explicit later design rather than silently weakening injectivity.

### 5.3 Immutable event history and generations

Append-only tables:

- `private.provider_team_identity_attestation_events`
- `private.provider_competition_identity_attestation_events`

Each event records:

```text
id
provider
provider_entity_id
canonical_entity_id
attestation_generation_id
attestation_version
event_kind                  attest | evidence_refresh | revoke
attestation_basis
evidence
evidence_sha256
mapping_status_snapshot
mapping_confidence_snapshot // null for competition
provider_name_snapshot
recorded_at                 // DB stamped
actor_current_user
attested_by_or_reviewer
revoke_reason               // revoke only
```

Rules:

- events have no FK to the canonical team/competition row; historical audit must survive later canonical cleanup;
- unique `(provider, provider_entity_id, attestation_version)`;
- version is globally monotonic for that provider ref: `max(event version)+1`, including after revoke;
- first attest creates a new generation UUID;
- evidence refresh stays in the same generation;
- revoke closes that generation and removes the current projection;
- re-attest after revoke starts a new generation UUID even if the canonical id is the same;
- UPDATE/DELETE/TRUNCATE are impossible; INSERT is permitted only through the guarded RPC path.

This generation rule is intentional: observations written under a revoked generation do **not** become trusted again merely because the same provider id is later re-attested.

### 5.4 Observation attestation provenance

Add an immutable ledger sidecar, analogous to sealed provider refs:

`public.match_ledger_observation_identity_attestations`

with one row for each `league`, `team_home`, `team_away` identity used by a V2 ingest:

```text
observation_id
ref_kind
team_attestation_event_id          // FK for team_home/team_away
competition_attestation_event_id   // FK for league
attestation_generation_id
provider_ref
canonical_id
```

Exactly one typed event id is set according to `ref_kind`, and each typed id has a real foreign key to the corresponding immutable event table.

A `BEFORE INSERT` integrity trigger verifies that the chosen event's provider, provider ref, canonical id and generation match the observation's sealed provider ref, the sidecar row and the current projection.

Sidecar INSERT also requires the V2-ingest transaction flag and proof that the backend currently holds the shared provider-identity advisory lock. UPDATE/DELETE/TRUNCATE are rejected.

The V2 ingest writes these rows from the current projections in the same transaction as the observation annotations.

A plain 1A write has no such rows and is therefore **excluded by the V2 model-facing readers**. Stage 1 does not claim that a deliberately malicious `service_role` can never manufacture data; its guarantee is enforced through typed FKs, integrity checks, guarded inserts and V2 read semantics.

---

## 6. Attestation evidence

`attestation_basis` is audit metadata, not numeric trust. Initial closed values:

- `operator_manual`
- `cross_provider_verified`
- `provider_official_reference`
- `fixture_identity_crosscheck`
- `multi_source_verified`

Every evidence object must satisfy `kapiloto-provider-identity-attestation-evidence-v1` and contain at least:

```text
contract_version
sources                    // non-empty array
reviewed_by                // audit text, never authorization
duplicate_audit_sha256     // 64 lowercase hex
```

Additional source-specific evidence is allowed, but total serialized evidence is capped at 64 KiB.

Rules:

- no V3 name match or numeric confidence can create evidence;
- the RPC validates structure but does not pretend to rank evidence strength;
- the projection always contains the **latest** accepted evidence for the active generation;
- a refresh with identical basis + evidence hash is an idempotent no-op;
- a changed evidence object for the same canonical id appends `evidence_refresh`, increments version and updates the projection;
- changed evidence can never re-point the canonical id;
- `duplicate_audit_sha256` proves that canonical-duplicate review was performed; the reconciliation workflow must surface same-normalized-name/alias candidates before attestation.

---

## 7. Write API

Use explicit service-role-only SECURITY INVOKER RPCs:

```text
public.provider_identity_attest_team(jsonb)
public.provider_identity_revoke_team(jsonb)
public.provider_identity_attest_competition(jsonb)
public.provider_identity_revoke_competition(jsonb)
```

All use `search_path = ''`, are revoked from PUBLIC/anon/authenticated, and are initially limited to Sportmonks.

### 7.1 Transaction entry rule

Attest/revoke must be the first write-capable operation of their transaction. Before taking row locks they reject if `pg_current_xact_id_if_assigned()` is already non-null.

This prevents the deadlock pattern `mapping UPDATE -> attest` against an in-flight ingest. Mapping correction and attestation therefore occur in **separate transactions**; the gap fails closed.

Each RPC declares a function-level `SET lock_timeout = '5s'` rather than caller-visible `SET LOCAL`, so the timeout cannot leak into the rest of the caller transaction.

The first-write rule also means **one attest/revoke RPC per transaction**. The pilot reconciliation intentionally uses separate transactions for each identity.

### 7.2 Attest semantics

Team attestation:

1. Require READ COMMITTED and provider `sportmonks`.
2. Take the exclusive provider identity advisory lock.
3. Lock/read the matching provider mapping.
4. Reject missing mapping.
5. Reject unless mapping status is exactly `manual_override`.
6. Reject if mapped canonical id differs from requested canonical id.
7. Reject active provider-id or canonical-target injectivity conflicts.
8. Validate evidence contract and duplicate-audit hash.
9. If same active canonical id and identical evidence hash+basis: return unchanged.
10. If same active canonical id with changed evidence: append refresh event in the same generation and update the projection.
11. If no active projection: create a new generation, append attest event and insert projection.

Competition semantics are analogous.

Attestation does not automatically create a missing V3 mapping in M2A. The 15 unmapped pilot teams are first inserted/promoted through an explicit reviewed reconciliation step as `manual_override`, then attested. This keeps mapping creation and trust creation independently auditable.

### 7.3 Re-pointing

No attest RPC overwrites an active different canonical id.

Required sequence:

```text
transaction A: revoke old attestation with expected canonical id + reason
transaction B: correct mapping under Stage 0 operator override, with expected old values in WHERE
transaction C: attest the new canonical id
```

### 7.4 Revoke semantics

Revoke requires:

- provider ref;
- expected current canonical id;
- non-empty reason.

It takes the same exclusive provider lock, verifies the expected active projection, appends a revoke event in the current generation, then removes the current projection. It never mutates the V3 mapping.

Revocation immediately makes that generation unusable by V2 historical readers, before any manual cleanup/re-ingest occurs.

---

## 8. DML protection

The RPC-only path is defense against accidental application writes, **not** a cryptographic boundary against a deliberately malicious `service_role` (which bypasses RLS).

Controls:

- projections/events live in `private`; production must confirm `private` is not a Data API exposed schema before M2A application;
- RLS remains enabled for non-bypass roles but is not counted as protection from `service_role`;
- no table privileges for public/anon/authenticated;
- `service_role` receives minimum table privileges only: projection SELECT/INSERT/UPDATE/DELETE, event SELECT/INSERT; no TRUNCATE/REFERENCES/TRIGGER;
- every new function explicitly revokes default PUBLIC execute;
- because Supabase default privileges grant EXECUTE on new public functions to `service_role`, M2A explicitly revokes `match_ledger_ingest_provider_fixture_v2(jsonb)` from `public, anon, authenticated, service_role`; only M2B may grant V2 ingest back to `service_role`;
- projection DML and event INSERT require both:
  1. a transaction-local internal flag set by the RPC; and
  2. proof that the current backend holds the exclusive provider identity advisory lock;
- the RPC sets the flag immediately before its own DML and clears it immediately after; exception paths clear it too;
- event UPDATE/DELETE/TRUNCATE are rejected unconditionally.

`attested_by` / `reviewed_by` are audit text only. Events additionally record `current_user`; neither value authorizes anything.

---

## 9. Concurrency and lock order

Provider identity changes are rare, so Stage 1 intentionally uses one coarse lock per provider:

`kapiloto_v4_provider_identity:<provider>`

- attest/revoke: exclusive;
- V2 ingest: shared.

### 9.1 V2 ingest order

1. existing provider-fixture advisory lock, exclusive;
2. provider-identity advisory lock, shared, with bounded lock timeout;
3. competition mapping row `FOR SHARE`;
4. competition attestation projection row `FOR SHARE`;
5. both team mapping rows `FOR SHARE`, ordered by provider id COLLATE C;
6. both team attestation projection rows `FOR SHARE` in the same deterministic order;
7. existing provider fixture mapping row `FOR SHARE` if present;
8. unordered canonical team-pair advisory lock on **both** existing-mapping and no-mapping paths;
9. candidate provider-mapping rows `FOR SHARE` in deterministic provider-fixture order;
10. selected canonical fixture row `FOR SHARE` before validating mutable fixture facts/status;
11. attach/mint writes;
12. existing 1A fixture/provider advisory lock;
13. player identity lock.

### 9.2 Attest/revoke order

1. first-write-of-transaction check;
2. exclusive provider-identity lock with short lock timeout;
3. relevant mapping row `FOR SHARE`;
4. current projection row `FOR UPDATE` when present;
5. canonical-row FK check/lock;
6. guarded event/projection writes.

An operator mapping correction must not call attest in the same transaction. That would create the row-lock/advisory-lock cycle identified in review.

PGlite cannot prove cross-session waiting. Tests must prove lock mode/order through catalog/plan evidence, matching A2-A's existing approach; an optional real-Postgres two-session test may supplement it.

Residual accepted race: Toto import can insert a brand-new duplicate fixture while an existing-mapping ingest is already running because the new row does not yet exist to lock and Toto does not take the V4 pair lock. This is equivalent to "ingest first, import second": the current ingest can commit, and the next ingest attempt sees the duplicate and quarantines. Document it as an A2-A-style residual case.

---

## 10. Historical-ingest trust functions

Do not redefine `private.provider_mapping_trusted(status, confidence)`. V1 remains inspectable and permanently revoked for ingest activation.

Add Stage 1 helpers for teams and competitions. A team/competition identity is trusted only when all are true:

1. current mapping exists;
2. mapping status is exactly `manual_override`;
3. current active attestation exists;
4. mapping and attestation canonical ids agree with the requested id;
5. projection generation is current and not revoked.

Proposed helpers:

```text
private.provider_team_attestation_matches(provider, provider_team_id, team_id)
private.provider_competition_attestation_matches(provider, provider_competition_id, competition_id)
```

`confirmed`, even at confidence 1, is never sufficient after Stage 1. `unverified` is never trusted.

This deliberately uses one V3 column only in the safe direction: Stage 0 makes `manual_override` stable against automation, while V3 insert-only bootstrap always creates `confirmed` weak evidence. Therefore deleting an attested mapping and letting V3 re-insert it cannot silently restore trust.

New V2 quarantine reasons distinguish at least:

```text
team_attestation_missing
team_attestation_mismatch
team_mapping_not_manual_override
competition_attestation_missing
competition_attestation_mismatch
competition_mapping_not_manual_override
```

Player bootstrap does not call these helpers and remains unchanged.

---

## 11. Existing Sportmonks data

No existing Sportmonks team or competition row is auto-attested or grandfathered.

In particular:

- the five pilot competitions being `manual_override` is only a stable mapping prerequisite, not V4 trust;
- the five pilot teams previously treated as trusted under A2-A must be independently reviewed, promoted to `manual_override` where appropriate, and attested;
- the 15 currently unmapped pilot teams require explicit reconciliation before any attestation;
- `confirmed + confidence=1` from pre-D-057 data is suspect and never sufficient;
- an active attestation whose mapping later ceases to be `manual_override` immediately fails trust.

Stage 1 reconciliation must also surface possible duplicate canonical teams before attestation. Evidence carries a `duplicate_audit_sha256`; the operator workflow must review same-normalized-name/alias candidates rather than assuming a provider id proves canonical uniqueness.

---

## 12. Fixture identity after Stage 1

There is intentionally **no fixture attestation table** in Stage 1.

Fixture identity is derived from attested/manual-override home team, away team and competition plus the existing A2-A candidate safeguards.

### 12.1 Existing provider fixture mapping

An existing `(provider, provider_fixture_id)` mapping is an operational pointer, not a trust statement.

Rules:

1. `mapping_status = 'unverified'` quarantines as `fixture_mapping_unverified`.
2. Take the unordered canonical team-pair advisory lock even on this path.
3. Run the same A2-A candidate classification over the team-pair window, but treat the incoming-id mapping as the candidate being validated rather than as a conflict against itself.
4. Require:
   - exactly one candidate carrying the incoming provider fixture id;
   - that candidate is exactly the currently mapped canonical fixture;
   - it has exact attested home/away orientation;
   - it has a non-null competition equal to the attested incoming competition;
   - kickoff gap is <= 48 hours;
   - its status is not `postponed`, `suspended`, `cancelled`, or `under_review`;
   - it is the **only** `N` candidate;
   - there is no other `R`, `X`, `U`, `P`, `W`, provider-id, orientation or identity-conflicting candidate apart from the validated incoming-id row itself.
5. Lock the selected canonical fixture row `FOR SHARE` before final fact/status validation.
6. If any condition fails, quarantine. Never ignore the bad mapping and fall back to another candidate.

This specifically closes the Toto-reschedule failure mode: Toto import matches fixtures by exact kickoff and may create a second canonical fixture after a schedule change while an insert-only Sportmonks mapping remains pinned to the old row. A mapping is accepted only if the candidate algorithm independently agrees that its target is still unique.

Suggested explicit codes include:

```text
fixture_mapping_unverified
fixture_mapping_team_conflict
fixture_mapping_orientation_conflict
fixture_mapping_competition_conflict
fixture_mapping_kickoff_conflict
fixture_mapping_status_conflict
fixture_mapping_candidate_ambiguous
fixture_mapping_reschedule_conflict
```

Where possible, reuse existing A2-A candidate reason semantics with a `fixture_mapping_` prefix rather than creating divergent logic.

### 12.2 Kickoff tolerance

Keep the current ±48-hour identity window.

The 48-hour width is **not** sufficient by itself. Safety comes from the full uniqueness/classification rule above: same teams, same orientation, same competition, acceptable status, exactly one `N` candidate, and no blocker candidates.

A tighter window would create false quarantines for legitimate reschedules while failing to solve the orphaned-duplicate problem on its own.

### 12.3 No existing provider fixture mapping

Keep the existing A2-A candidate search / attach / mint rules, now after Stage 1 team/competition trust succeeds.

Any fixture mapping written by a successful V2 attach/mint is still only an operational lookup. Future trust derives from the same attestation + fixture-fact checks.

### 12.4 Duplicate-canonical mint risk

Before M2B, reconciliation must explicitly review duplicate canonical-team candidates. Otherwise an attestation to a duplicate canonical row can cause A2 to mint a parallel fixture chain that represents a match already present under the real canonical team.

The readiness/recovery reports should surface suspicious minted fixtures whose team names/aliases collide with another canonical pair in the same competition/window. This is a reconciliation signal, not an automatic merge.

---

## 13. V2 ingest, sealed provenance and post-write re-check

Stage 1 does **not** redefine the A2-A ingest function in place.

Add:

`public.match_ledger_ingest_provider_fixture_v2(jsonb)`

The V1 function remains present and permanently revoked from `service_role` after Stage 1.

### 13.1 Run scope is mandatory

V2 ingest requires:

- non-null `run_id`;
- an existing immutable `provider_ingest_runs` row for the same provider;
- `scope.provider_fixture_ids` to be a non-empty array;
- the incoming `provider_fixture_id` to be explicitly listed.

An out-of-scope fixture quarantines before any phase-2 write.

This makes M2B's tiny pilot genuinely tiny against accidental/unintended ingest calls even though SQL EXECUTE itself is role-wide. It is **not** a security boundary against a deliberately malicious `service_role`, which can author another run.

The pilot run row is created in an explicit reviewed readiness step; its immutable `run_id` and exact `scope.provider_fixture_ids` are recorded in the M2B PR/operations note before activation.

### 13.2 Generation continuity before "unchanged"

Before delegating to 1A's content-hash/version logic, V2 compares the latest observation's sealed league/home/away attestation generations to the current projections.

If the football content is unchanged but any sealed generation is stale, V2 quarantines as `attestation_generation_stale` rather than allowing 1A to return `unchanged`. Recovery therefore requires the explicit withdrawal/repair/re-ingest path instead of silently leaving a revoked generation without a new sidecar.

Under retrospective availability policy V1, only observation version 1 receives historical backdating. A same-fixture recovery written as a later version is available only from its real recovery `first_seen_at`; it does **not** recreate pre-recovery retrospective history. Changing that behavior requires a separately reviewed availability-policy V2.

### 13.3 Observation attestation sidecar

On a recorded observation, V2 writes sealed league/home/away attestation rows from the active projections. The sidecar records the exact event/generation used by that observation version.

Direct 1A writes do not have this sidecar.

### 13.4 Post-write defense in depth

Before commit, V2 re-checks:

- team mappings still exist, are `manual_override` and equal the canonical ids used;
- team projections still exist in the same sealed generation and agree;
- competition mapping still exists, is `manual_override` and agrees;
- competition projection still exists in the same sealed generation and agrees;
- provider fixture mapping still points at the fixture used;
- canonical fixture row still matches home/away/competition/status/kickoff requirements;
- the existing-mapping uniqueness/classification still has no blocker when applicable.

Because V2 holds the shared provider-identity lock and projection/mapping row locks, attest/revoke cannot pass concurrently.

Any failure raises and rolls phase 2 back.

---

## 14. Model-facing reads, readiness and recovery reports

Trust must be enforced at read time as well as write time.

### 14.1 Versioned historical reads

Add new V2 readers rather than changing return-shape/row-set semantics in place:

```text
private.match_ledger_team_match_stats_v2(...)
public.match_ledger_team_match_stats_as_of_v2(...)
public.match_ledger_team_match_stats_for_training_v2(...)
```

For **every provider**, a model-facing V2 row is returned only when its observation:

1. has sealed provider refs for `league`, `team_home`, `team_away`;
2. has sealed attestation sidecars for all three refs;
3. each sealed event belongs to the generation recorded for the observation;
4. no revoke event closed that generation;
5. the current projection still uses that generation and canonical id;
6. the current mapping exists, is `manual_override`, and agrees with the same canonical id;
7. all existing availability/supersession rules still pass.

A later evidence refresh in the same generation does not invalidate earlier observations. A revoke followed by re-attest starts a new generation, so observations from the revoked generation stay excluded until explicitly recovered/re-ingested.

Plain 1A observations or any observation with missing attestation provenance are excluded, not merely flagged. A provider with no Stage 1 attestation system yields **zero V2 rows** until a provider-specific attestation migration explicitly enables it.

Once M2A lands, `service_role` EXECUTE should be revoked from the old V1 model-facing team-match-stat readers and granted to V2 only. The V1 functions remain present for contract/history inspection.

### 14.2 Entity-level readiness report

Create:

`public.provider_identity_attestation_conflicts(p_provider text)`

This works even when zero Match Ledger observations exist. It reports at least:

```text
attested_mapping_missing
attested_mapping_disagrees
attested_mapping_not_manual_override
shadow_mapping_for_attested_canonical
mapping_unattested              // informational reconciliation worklist
```

The report should return provider ref, canonical id, mapping status/current target and severity. M2B readiness fails on blocking codes for the pilot scope.

`shadow_mapping_for_attested_canonical` is blocking for another non-`unverified` provider row that points at an actively attested canonical entity; unverified shadows may be reported as warnings.

### 14.3 Observation/provider-ref reconciliation V2

Keep the old `public.match_ledger_provider_ref_conflicts(text)` function present, but revoke `service_role` EXECUTE after M2A because its old confidence-based trust semantics become misleading.

Add:

`public.match_ledger_provider_ref_conflicts_v2(text)`

with attestation-aware observation-level codes such as:

- `team_mapping_missing`
- `team_attestation_missing`
- `team_mapping_attestation_mismatch`
- `team_attested_canonical_drift`
- `competition_mapping_missing`
- `competition_attestation_missing`
- `competition_mapping_attestation_mismatch`
- `competition_attested_canonical_drift`
- `fixture_competition_drift`.

The existing `public.match_ledger_mapping_conflicts(text)` remains for fixture/player/coach drift and is not redefined.

### 14.4 Revocation impact report

Create a read-only report:

`public.provider_identity_revocation_impact(provider, entity_kind, provider_ref)`

It identifies at least:

- observation versions sealed under the revoked generation;
- current/latest chains affected;
- fixture mappings associated with those provider fixture ids;
- A2 fixture mints associated with those chains;
- refs-less/direct-1A observations for the same provider that V2 readers already exclude.

### 14.5 Recovery semantics

Revocation provides immediate safety because V2 readers exclude the revoked generation. Before M2B, rehearse the full recovery runbook on synthetic data:

1. revoke the bad attestation;
2. inspect impact report;
3. withdraw affected observation chains through the immutable 1A withdrawal mechanism;
4. delete or explicitly re-point affected provider fixture mappings using the Stage 0 operator override and expected-old-value predicates;
5. correct/promote team/competition mapping to `manual_override` in a separate transaction;
6. attest the correct canonical identity in a new generation;
7. re-ingest under an allow-listed V2 run;
8. confirm V2 readers contain only the corrected chain and all reports are clean.

Wrong minted canonical fixtures may remain as historical orphan rows if immutable ledger history references them; recovery correctness comes from withdrawal, mapping repair, new canonical attachment and V2 read exclusion, not rewriting old ledger rows.

### 14.6 Trust-aware retrospective exclusions

Add:

`public.match_ledger_retrospective_training_exclusions_v2(...)`

It preserves the V1 reasons `later_correction` / `later_withdrawal` and adds at least:

- `attestation_missing`;
- `generation_revoked`;
- `mapping_not_manual_override`;
- `attestation_generation_stale`.

The V1 exclusions function remains present for frozen-contract inspection, but `service_role` EXECUTE is revoked when V2 becomes the model-facing historical path.

### 14.7 Reads intentionally not covered by Stage 1

M2A does **not** silently change these frozen/legacy Match Ledger consumers:

- `public.squad_state_inputs_as_of`;
- `public.match_ledger_observation_as_of`;
- `public.match_ledger_provider_team_matches_as_of`;
- `public.match_ledger_provider_player_matches_as_of`;
- the V4 loaders/registry paths that depend on them, including lineup/squad-state snapshot freezing.

These reads are not attestation-aware and can return observations that the V2 team-match-stat readers correctly exclude after revocation.

Therefore **M2B is blocked** until one of these is true:

1. attestation-aware V2 successors exist for every V4 consumer that may be activated; or
2. D-058 explicitly keeps those consumers disabled for Sportmonks/Match-Ledger historical input, with a repository grep/boundary gate proving no production `app/`, `scripts/` or cron path activates them.

In-place changes are forbidden where frozen prediction/commit-time equality contracts depend on the current function semantics.

---

## 15. Security

Required Stage 1 properties:

- no new Stage 1 function is SECURITY DEFINER;
- every function uses fixed empty `search_path`;
- PostgreSQL's default PUBLIC function execute is explicitly revoked for every new public/private function;
- `anon` and `authenticated` have no Stage 1 table privileges and no RPC execute;
- `service_role` gets only the minimum privileges described in §8;
- RLS is enabled but is not treated as a control against `service_role` BYPASSRLS;
- current-projection/event DML guards require the internal flag **and** held exclusive advisory lock;
- event history cannot be updated/deleted/truncated and direct event INSERT without the guarded RPC path fails;
- JSON evidence is validated and size-bounded but never interpreted as executable policy;
- `attested_by`/`reviewed_by` are audit fields, never authorization inputs; events also record `current_user`.

Production pre-apply check: verify through Supabase project configuration/Data API behavior that `private` is not an exposed schema. The repository and `current_setting('pgrst.db_schemas', true)` do not prove this configuration, so M2A deployment stays blocked until the operator check is explicit.

Catalog tests must enumerate the actual created functions/tables and validate privileges, rather than relying only on a handwritten list.

---

## 16. Stage 1 migration and activation split

Do not combine trust construction, reconciliation and ingest activation.

### M2A — Identity attestation foundation

M2A contains:

- current team/competition projection tables;
- immutable generation/event tables;
- observation attestation sidecar;
- injectivity and NO ACTION canonical FKs;
- guarded DML/event-write machinery;
- provider identity advisory-lock helper;
- attest/revoke RPCs;
- attestation trust helpers requiring `manual_override`;
- `match_ledger_ingest_provider_fixture_v2(jsonb)` with mandatory run allowlist;
- existing-fixture uniqueness/fact checks;
- post-write re-checks;
- V2 model-facing reads;
- entity-level readiness report;
- provider-ref conflict report V2;
- revocation-impact report;
- security grants/revokes;
- tests/documentation.

M2A leaves both V1 and V2 provider-ingest RPCs **not executable by `service_role`**.

The M2A security suite runs with Supabase-default-privilege emulation enabled and proves the explicit V2 revoke from `public, anon, authenticated, service_role`.

The old V1 ingest RPC is never re-granted after Stage 1.

### Reconciliation/readiness stage

After M2A and before M2B:

- create/promote reviewed pilot mappings to `manual_override`;
- attest all five pilot competitions;
- reconcile and attest all 20 pilot teams, including independent re-attestation of the five old confidence-1 rows;
- entity-level report has no blocking issue for pilot refs;
- provider-ref/fixture conflict reports are clean for the intended scope;
- duplicate-canonical audit evidence exists for every attestation;
- PR #19 is amended and the provider pilot re-run under the strengthened acceptance model;
- recovery runbook is rehearsed end to end on synthetic data;
- production `private` schema exposure check is clean.

### M2B — Tiny-pilot activation

M2B contains **grant-only activation** for `match_ledger_ingest_provider_fixture_v2(jsonb)`.

The pilot run itself must have an explicit `scope.provider_fixture_ids` allowlist, enforced inside V2.

Do not merge a pending revoke migration into main before M2B application, because a normal future `db push` would apply it automatically. Before M2B, independently review the **M2C SQL body**, not a timestamped filename.

### M2C — Immediate pause/rollback

M2C simply revokes `service_role` EXECUTE on the V2 ingest RPC again. It contains no identity/data mutation.

Emergency path:
1. immediately execute the reviewed operator statement `REVOKE EXECUTE ON FUNCTION public.match_ledger_ingest_provider_fixture_v2(jsonb) FROM service_role`;
2. create the matching migration file with a **fresh timestamp at application time**, avoiding Supabase CLI out-of-order migration rejection;
3. commit/merge that migration immediately after the emergency revoke.

If the tiny pilot fails any integrity gate, M2C is applied before further investigation. If the pilot passes, activation for the next staged scope still requires a separately reviewed run allowlist.

M2B remains NO-GO while any uncovered model-facing Match Ledger consumer in §14.7 could be activated against pilot observations.

---

## 17. Test plan

Stage 1 is NO-GO without the following.

### Attestation state / audit

- missing mapping rejected;
- non-`manual_override` mapping rejected;
- mapping canonical mismatch rejected;
- first attest succeeds and creates generation;
- identical refresh is idempotent no-op;
- changed evidence refresh stays in generation, increments global version and appends event;
- same provider id cannot re-point while active;
- same canonical target cannot receive second active provider id;
- revoke requires expected canonical id + reason;
- revoke closes generation and removes projection;
- re-attest after revoke uses new generation and continued event version;
- direct projection DML rejected without guard+lock;
- direct event INSERT rejected;
- sidecar insert without V2 flag/shared provider lock rejected;
- sidecar typed-FK/ref/canonical/generation mismatch rejected;
- event update/delete/truncate rejected;
- canonical team/competition delete blocked while actively attested and allowed only after revoke.

### Read-side trust / recovery

- plain 1A Sportmonks observation is excluded from V2 readers;
- observation without sealed refs or attestation sidecars is excluded;
- current active generation is included;
- evidence refresh in same generation keeps observation included;
- revoke excludes all observations sealed to that generation;
- re-attesting same canonical id in a new generation does not resurrect old observations;
- unchanged football content with stale sealed generation quarantines as `attestation_generation_stale`;
- recovered later-version history is not backdated by retrospective availability V1;
- V2 readers return zero rows for providers without Stage 1 attestations;
- V2 retrospective-exclusions reports trust exclusions;
- impact report lists affected observations, mints and fixture mappings;
- synthetic withdrawal/mapping-repair/re-ingest recovery produces only corrected V2 history.

### Entity readiness

- entity report works with zero observations;
- all blocking codes are covered;
- delete + V3-style `confirmed/0.9` re-insert is not trusted;
- `unverified` + agreeing attestation is not trusted;
- shadow non-unverified mapping for an attested canonical is reported.

### Fixture identity

- correct existing mapping accepted only when it is unique `N` candidate;
- orphaned stale fixture after kickoff reschedule quarantines;
- duplicate candidate <=48h quarantines;
- reversed orientation quarantines;
- null/wrong competition quarantines;
- postponed/suspended/cancelled/under_review mapped target quarantines;
- unverified fixture mapping quarantines;
- kickoff exactly at and just beyond 48h boundary;
- bad existing mapping never falls back to candidate search;
- no-existing-mapping path preserves existing A2-A attach/mint guards;
- selected fixture row is locked `FOR SHARE`.

### Run scope / activation

- V2 rejects null run id;
- V2 rejects missing/empty `scope.provider_fixture_ids`;
- V2 rejects fixture outside allowlist;
- M2A leaves V1 and V2 ingest EXECUTE false for service_role **with Supabase default privileges enabled in the harness**;
- catalog checks prove V2 ingest is revoked from `public, anon, authenticated, service_role`;
- reviewed pilot run id/scope is immutable and outside fixtures quarantine;
- M2B grants V2 only;
- old V1 ingest is never re-granted.

### Concurrency / locks

- shared provider lock appears after provider-fixture lock;
- projection/mapping row lock order is deterministic;
- pair lock is acquired on both fixture paths;
- attest/revoke first-write-of-transaction rule works;
- mapping update then attest is rejected rather than entering the deadlock pattern;
- lock timeout exists on provider identity acquisition;
- Stage 0 guard remains active after M2A;
- PGlite limitation is documented; optional real-Postgres two-session test may supplement catalog/plan evidence.

### Security / migration compatibility

- RLS enabled where intended;
- no anon/authenticated grants;
- exact minimal service_role table privileges;
- all new functions revoked from PUBLIC by default then explicitly granted as intended;
- no SECURITY DEFINER;
- fixed empty search path;
- old provider-ref report remains present but service_role execute revoked;
- V2 report exists and is granted;
- V1 model-facing read functions remain present but service_role uses V2;
- private-table allowlist added to boundary tests;
- byte-for-byte/hash pins cover already-applied A2-A and Stage 0 migrations;
- M2A added to all migration/security test enumerations;
- player bootstrap behavior unchanged;
- new quarantine codes added to TypeScript contracts/tests.

### Regression

- focused DB/locking/security/provider-ingest tests;
- V4 full suite;
- Kapiloto suite;
- research-v2/V3 suites;
- full `npm test`;
- typecheck;
- production webpack build;
- mutation tests for trust/fixture/read-side gates where practical.

---

## 18. Operational sequence

1. **DONE:** reconcile independent Opus and Fable architecture findings into this RFC.
2. **DONE:** final independent sanity review by both reviewers; both returned M2A GO.
3. **DONE:** fold all final spec/test corrections into the RFC and record D-058.
4. Implement M2A on a new branch only.
5. Run independent code/migration review before any merge or production application.
6. Independent code/migration review by at least one external reviewer plus direct diff/runtime review.
7. Merge M2A.
8. Apply the exact canonical M2A migration to production.
9. Verify catalog privileges, locks, Data API exposure, reports and that ingest remains paused.
10. Reconcile/create/promote pilot mappings and attest five competitions + 20 teams through the reviewed process.
11. Amend/rerun A2-B PR #19.
12. Rehearse recovery runbook on synthetic data.
13. Review M2B plus the pre-reviewed unmerged M2C revoke.
14. Apply M2B.
15. Run the allow-listed 1–2 fixture real Match Ledger pilot.
16. Inspect persisted observations, attestation sidecars, V2 reads, impact/conflict reports and idempotent re-ingest.
17. Apply M2C immediately if any gate fails; otherwise continue only with a newly reviewed staged scope.
18. Expand gradually: 10 pilot fixtures -> one matchweek/competition -> one season slice -> broader corpus.

---

## 19. Review reconciliation decisions

Independent Opus and Fable reviews agreed on the core architecture and independently found the same major missing controls. This revision adopts the strictest compatible resolution:

1. **Read-side enforcement:** accepted. V2 readers exclude refs-less/unattested/revoked generations.
2. **Observation provenance:** accepted. V2 observations seal attestation event/generation ids.
3. **Pre-ingest readiness report:** accepted. Entity-level conflicts do not depend on existing observations.
4. **Existing fixture uniqueness:** accepted. Existing mappings run the full pair/candidate classification under the pair lock.
5. **`manual_override` prerequisite:** accepted. It is necessary but not sufficient, specifically to prevent delete + V3 reinsert from regaining trust.
6. **Fixture status/null competition:** accepted as fail-closed conditions.
7. **Versioned ingest/read/report contracts:** accepted. No in-place trust-model replacement.
8. **Run allowlist:** accepted and mandatory for V2.
9. **Recovery/impact path:** accepted before activation.
10. **RPC DML guard hardening:** accepted; flag is narrow-lived and lock-held is required.
11. **Canonical fixture row lock:** accepted despite Fable calling it optional; the cost is low and it strengthens post-check stability.
12. **±48h window:** retained, but only with full candidate uniqueness; reviewers agreed the window itself is not the safety mechanism.
13. **M2A/M2B split:** retained and strengthened with a pre-reviewed, unmerged M2C revoke path.
14. **Projection + immutable events:** retained, now with explicit generations and idempotent refresh.
15. **Players:** unchanged.

One production check remains intentionally external to the repo: confirm `private` is not an exposed Data API schema before M2A is applied.

---

## 20. Architecture acceptance status

All M2A architecture acceptance criteria are now satisfied:

- Opus final sanity review: M2A GO;
- Fable final red-team review: M2A GO;
- no unresolved M2A BLOCKING trust/concurrency/security issue remains;
- the `manual_override + attestation + generation` rule is accepted;
- V2 read-side revocation semantics are accepted;
- existing-fixture uniqueness/classification behavior is explicit;
- V2 run allowlist and M2B/M2C activation semantics are explicit;
- recovery semantics and stale-generation handling are explicit;
- Supabase default-grant behavior is accounted for in the M2A spec/tests;
- the implementation test matrix is agreed.

Therefore **M2A architecture is ready for implementation**.

Historical provider ingest remains paused. M2B remains NO-GO until §14.7's uncovered readers are gated/versioned and every readiness condition in §16 passes.

---

## 21. M2A implementation notes

Implemented on `feat/v4-identity-attestations-m2a` in
`supabase/migrations/20261031100000_kapiloto_v4_identity_attestations.sql`.
Not merged; not applied to production. These notes record concrete names and
details; they do not change the architecture above.

- **Objects.** Private: `provider_team_identity_attestations`,
  `provider_competition_identity_attestations`,
  `provider_team_identity_attestation_events`,
  `provider_competition_identity_attestation_events`. Public sidecar:
  `match_ledger_observation_identity_attestations`
  (`team_attestation_event_id` / `competition_attestation_event_id`). RPCs as
  in §7; V2 ingest, reads and reports as in §13-§14. Trust helpers take an
  optional expected generation:
  `private.provider_team_attestation_matches(provider, ref, team_id, generation)`.
- **Evidence hash** is the SHA-256 of jsonb's normalized text, so key order and
  whitespace do not change it.
- **Projection consistency** is trigger-enforced: a projection row always
  equals its latest non-revoke event, never changes provider ref, canonical id,
  generation or `first_attested_at` in place, is deleted only after its
  generation's revoke event, and a generation that has a revoke event can never
  be inserted or updated as the current projection again.
- **Sidecar check** requires the projection's current (latest) event; an
  older event of the same generation (before an evidence refresh) is refused.
- **Stale generation (§13.2).** 1A remains the only content-hash authority:
  V2 computes generation staleness before calling 1A and, when 1A reports the
  content unchanged, turns that into the `attestation_generation_stale`
  quarantine and rolls phase 2 back.
- **Concrete quarantine codes.** `fixture_outside_run_scope`;
  `competition_mapping_not_manual_override`, `competition_attestation_missing`,
  `competition_attestation_mismatch`; `team_mapping_not_manual_override`,
  `team_attestation_missing`, `team_attestation_mismatch`;
  `fixture_mapping_team_conflict`, `_orientation_conflict`,
  `_competition_conflict`, `_kickoff_conflict`, `_status_conflict`,
  `_provider_identity_conflict`, `_candidate_ambiguous`,
  `_competition_unknown`, `_possible_postponement`, `_reschedule_conflict`
  (all `fixture_mapping_*`); `fixture_candidate_changed` (attach target moved
  under the lock); `fixture_mint_exists` (a mint already exists for the
  provider fixture id); `attestation_generation_stale`. A family-status
  upgrade with no content change is `family_status_drift` and takes precedence
  over the stale generation. A2-A codes for
  unmapped identities, the no-mapping candidate path, drift, families and
  players are kept.
- **Exclusion reasons (§14.6)** add `mapping_missing` and `mapping_disagrees`
  next to the four listed. `generation_revoked` means revoked with nothing
  active now; `attestation_generation_stale` means revoked and re-attested.
- **Readiness report (§14.2)** also reports `mint_without_mapping` (warning,
  `entity_kind = 'fixture'`): a minted fixture whose provider mapping is gone,
  i.e. a withdrawn chain under recovery.
- **Lock timeout.** The function-level 5 s `lock_timeout` bounds every wait of
  a V2 call, including the provider-fixture advisory lock, so two concurrent
  V2 calls for one provider fixture id no longer serialize as V1 did.
- **Reconciliation V2 (§14.3)** also reports `*_mapping_not_manual_override`
  and `*_attestation_generation_stale`.
- **Run row immutability.** `provider_ingest_runs` (A2-A) is already
  immutable, so a reviewed allowlist cannot be widened after creation.
- **Minted-chain recovery (§14.5).** A chain V2 wrongly **minted** is never
  minted again: the applied A2-A `match_ledger_fixture_mints` is unique per
  `(provider, provider_fixture_id)`, and V2 quarantines `fixture_mint_exists`.
  Recovery is: the operator creates the reviewed canonical fixture row, and the
  re-ingest attaches to it (tested end to end). The orphaned mint stays
  reported as `mint_without_mapping` until an operator decision about the
  orphan row. The runbook rehearsal before M2B covers this path.
