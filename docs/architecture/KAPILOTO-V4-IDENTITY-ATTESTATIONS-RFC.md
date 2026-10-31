# Kapiloto V4 Stage 1 RFC — Provider Identity Attestations

Status: **RFC / review required before implementation**  
Scope: V4 historical-ingest trust only  
Related decisions: D-056, D-057  
Current production state: D-057 Stage 0 containment is applied; Sportmonks V3 identity writes are insert-only; historical provider ingest remains paused.

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
attestation_event_id
attestation_generation_id
provider_ref
canonical_id
```

The V2 ingest writes these rows from the current projections in the same transaction as the observation annotations. They cannot be added, changed or deleted later for that observation version.

A plain 1A write has no such rows and therefore cannot enter the Stage 1 model-facing corpus.

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

Each RPC uses a short local `lock_timeout` (initial proposal: 5s) so a forgotten operator transaction cannot indefinitely queue behind or block provider ingest.

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

No existing Sportmonks team or competition row is auto-attested.

In particular:

- the five pilot competitions being `manual_override` does not automatically create V4 trust;
- the five pilot teams previously considered trusted do not remain trusted merely because their V3 row says confidence 1;
- the 15 unmapped pilot teams still require reconciliation;
- every active attestation must be produced through the Stage 1 RPC after evidence review.

This avoids laundering pre-D-057 state into the new trust system.

---

## 12. Fixture identity after Stage 1

There is intentionally **no fixture attestation table** in Stage 1.

Fixture identity is derived from:

- attested home team;
- attested away team;
- attested competition;
- orientation;
- kickoff relation;
- the existing candidate/attach/mint safeguards.

### 12.1 Existing provider fixture mapping

If a row exists for the incoming `(provider, provider_fixture_id)`, its
`mapping_status` and `mapping_confidence` are **not historical-ingest trust**.

The mapping may only pin the canonical fixture if the target fixture is re-validated against the current payload:

- canonical home team == attested incoming home team;
- canonical away team == attested incoming away team;
- canonical competition == attested incoming competition;
- kickoff gap is within the accepted identity window;
- fixture is not a contradictory postponed/reschedule candidate under the existing guards.

If any fact fails, quarantine.

Proposed new reason codes:

```text
fixture_mapping_team_conflict
fixture_mapping_orientation_conflict
fixture_mapping_competition_conflict
fixture_mapping_kickoff_conflict
```

### 12.2 Kickoff tolerance

Initial proposal: reuse the existing ±48-hour identity window.

Reason:

- the current candidate algorithm already relies on the invariant that the same two teams do not represent two distinct intended fixtures within that window;
- it tolerates ordinary provider/time corrections without making a mapping authoritative by itself.

This point is explicitly open for review. If reviewers can justify a tighter safe bound for finished historical fixtures, use it.

If an existing provider mapping fails the kickoff check, do **not** ignore it and silently candidate-search around it. A contradictory provider mapping is evidence of an identity problem and must quarantine for reconciliation.

### 12.3 No existing provider fixture mapping

Keep the existing A2-A candidate search / attach / mint rules unless review identifies a concrete flaw.

Any fixture mapping created by a successful attach/mint remains an operational lookup. Future trust still derives from attestations + fixture facts, not its confidence column.

---

## 13. Post-write re-check

The existing post-write defense-in-depth must move to the new trust boundary.

Before commit, re-check:

- team mappings still equal the canonical ids used by the ingest;
- team attestations still exist and agree;
- competition mapping still equals the canonical competition used;
- competition attestation still exists and agrees;
- provider fixture mapping still points at the fixture used;
- canonical fixture still agrees on home/away/competition and the approved kickoff relation.

Because ingest holds the shared provider-identity advisory lock, an attestation revoke/re-attest cannot pass concurrently.

Any failure raises and rolls back the entire phase-2 write.

---

## 14. Reconciliation reports

Do not `DROP FUNCTION` or replace the return type of the existing
`public.match_ledger_provider_ref_conflicts(text)`.

The project treats migrations as additive, and frozen/older contracts should remain inspectable.

Create a successor:

```text
public.match_ledger_provider_ref_conflicts_v2(text)
```

The V2 report should distinguish at least:

- `team_mapping_missing`
- `team_attestation_missing`
- `team_mapping_attestation_mismatch`
- `team_attested_canonical_drift`
- `competition_mapping_missing`
- `competition_attestation_missing`
- `competition_mapping_attestation_mismatch`
- `competition_attested_canonical_drift`
- `fixture_competition_drift`

The existing `public.match_ledger_mapping_conflicts(text)` remains useful for:

- fixture mapping drift;
- player mapping/merge drift;
- coach mapping/merge drift.

The old provider-ref report may remain present for historical/debug compatibility. Whether `service_role` EXECUTE should be revoked from the old V1 report is an explicit review question; do not drop the function.

---

## 15. Security

Required Stage 1 security properties:

- attestation tables are not public API tables;
- RLS enabled;
- no `anon` / `authenticated` table privileges;
- RPC execute only for `service_role`;
- no Stage 1 function is `SECURITY DEFINER`;
- fixed empty search path;
- direct current-projection DML requires the internal transaction flag;
- event history immutable;
- JSON input is validated before any DML;
- arbitrary evidence JSON is audit data and never executed/interpreted as policy.

Security tests must inspect catalog state, not merely exercise happy-path RPC calls.

---

## 16. Stage 1 migration split

Do not combine trust-model construction with ingest activation.

### M2A — Identity attestation foundation

Contains:

- private current projection tables;
- immutable event tables;
- indexes and injectivity constraints;
- DML guards;
- provider identity advisory lock helper;
- attest/revoke RPCs;
- attestation-match helpers;
- updated ingest function using attestations and fixture fact checks;
- post-write re-check update;
- provider-ref conflict report V2;
- security grants/revokes;
- tests and documentation.

**M2A leaves `service_role` EXECUTE on
`match_ledger_ingest_provider_fixture(jsonb)` revoked.**

Applying M2A therefore cannot accidentally start historical ingestion.

### Reconciliation / readiness stage

After M2A:

- attest the five pilot competitions from reviewed evidence;
- reconcile and attest all 20 pilot teams, including re-attesting the five that old A2-A treated as trusted;
- amend PR #19 and rerun the provider pilot under the strengthened acceptance model;
- confirm reconciliation reports are clean for the intended tiny pilot scope.

### M2B — Tiny-pilot activation

A separate small migration may restore service-role EXECUTE on the ingest RPC only when the operator is ready for the tiny real Match Ledger pilot.

M2B should contain no identity logic.

This makes activation independently reviewable and reversible.

---

## 17. Test plan

Stage 1 is not ready without database tests covering all of these.

### Attestation state

- missing provider mapping -> attest rejected;
- provider mapping canonical mismatch -> attest rejected;
- first exact attest succeeds;
- same canonical id can refresh evidence;
- refresh increments version and appends event;
- same provider id cannot silently re-point;
- same canonical team cannot receive a second active provider id;
- same canonical competition cannot receive a second active provider id;
- revoke removes current projection and preserves immutable event;
- re-attest after revoke works only against the current agreeing mapping;
- direct DML without RPC flag fails;
- event mutation fails.

### Ingest trust

- mapped but unattested competition -> quarantine;
- mapped but unattested home/away team -> quarantine;
- attestation and mapping disagreement -> quarantine;
- exact mapping+attestation agreement resolves;
- `confirmed + confidence=1` without attestation is not trusted;
- `manual_override` without attestation is not trusted;
- player bootstrap behavior is unchanged.

### Fixture identity

- correct existing fixture mapping + facts -> allowed;
- wrong home/away -> quarantine;
- reversed orientation -> quarantine;
- wrong competition -> quarantine;
- kickoff outside accepted bound -> quarantine;
- mapping status/confidence does not override factual mismatch;
- no existing mapping follows existing A2-A attach/mint guards;
- wrong existing mapping is not silently bypassed by candidate search.

### Concurrency

- ingest holds shared provider identity lock;
- revoke/attest waits behind in-flight ingest;
- ingest after revoke quarantines;
- two competing attestations cannot bypass injectivity;
- mapping change under the Stage 0 operator path cannot race past the ingest re-check.

### Security / migration

- RLS enabled;
- no anon/authenticated grants;
- service-role RPC-only surface;
- no SECURITY DEFINER;
- fixed search path;
- old report functions remain present;
- V2 report exists;
- ingest EXECUTE remains revoked after M2A;
- migration is additive.

### Regression

- V4 full suite;
- Kapiloto suite;
- research-v2/V3 suites;
- full `npm test`;
- typecheck;
- production webpack build.

---

## 18. Operational sequence

The intended order after this RFC is approved:

1. independent architecture review by Opus;
2. independent architecture review by Fable;
3. reconcile review findings into one accepted Stage 1 design;
4. implement M2A on a new branch;
5. independent code/migration review;
6. merge M2A;
7. apply the exact canonical M2A migration to production;
8. verify security/locks/trust functions in production;
9. perform evidence-backed team/competition reconciliation through the RPCs;
10. amend and rerun A2-B;
11. only then create/review M2B to enable the tiny ingest pilot;
12. run tiny real ingest;
13. inspect persisted ledger rows and conflict reports;
14. proceed to staged backfill only after the pilot gates pass.

---

## 19. Explicit review questions

Reviewers should challenge these points rather than merely approve the design:

1. Is current-projection + immutable-events better here than a pure append-only attestation model?
2. Is a provider-wide shared/exclusive advisory lock too coarse, or is the simplicity worth it for rare operator writes?
3. Is the proposed ±48-hour kickoff bound too permissive for an existing provider fixture mapping?
4. Should an evidence refresh of the same canonical id update the current projection, or should every attestation version be a separate current-state row?
5. Should the old V1 provider-ref report keep service-role EXECUTE after V2 exists, or should it remain present but be de-authorized to prevent accidental use?
6. Are separate team and competition tables preferable to a generic entity attestation table?
7. Are there any paths where V3 mapping INSERTs could still create an identity that Stage 1 would accidentally trust?
8. Is there any lock-order/deadlock scenario missed by the proposed provider identity lock?
9. Should the existing fixture mapping path require a tighter kickoff bound or another independent fixture field?
10. Is keeping ingest disabled until a separate M2B activation migration unnecessarily conservative, or the correct blast-radius control?
11. Is the attestation evidence taxonomy too weak/too strong for repeatable reconciliation?
12. Are there any existing frozen-contract/additive-migration constraints this RFC violates?

A reviewer should return concrete objections, counterexamples and exact changes, not only a verdict.

---

## 20. Acceptance criteria for leaving RFC state

This RFC is ready for implementation only when:

- Opus review has been reconciled;
- Fable review has been reconciled;
- no unresolved critical trust/lock/security issue remains;
- fixture identity semantics are explicit;
- attestation mutation/revocation semantics are explicit;
- M2A/M2B separation is accepted;
- additive migration/report-versioning policy is accepted;
- the implementation test matrix is agreed.

Until then, historical ingest remains paused.