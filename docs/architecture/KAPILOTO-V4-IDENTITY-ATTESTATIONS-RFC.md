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

1. **Independent trust ownership.** Historical-ingest trust is stored in V4-owned attestation state, not inferred from V3 `mapping_status` or `mapping_confidence`.
2. **Mapping + attestation agreement.** An attestation is valid only while the current provider mapping points at the same canonical entity.
3. **Injectivity at the trusted boundary.** One provider team id may attest one canonical team, and one canonical team may have at most one active attested id for that provider. Same for competitions.
4. **Explicit re-pointing.** A canonical re-point requires explicit revocation and re-attestation. It must never happen as a side-effect of an upsert.
5. **Fail closed.** Missing, revoked, conflicting or mismatched attestation quarantines ingest.
6. **Auditable evidence.** Every attest/revoke/evidence-refresh action produces immutable history.
7. **Stable concurrency semantics.** Ingest and attestation changes cannot race past each other.
8. **Fixture trust independent of V3 confidence.** Existing fixture mappings are only accepted after canonical team/competition/orientation/kickoff re-validation.
9. **Players remain separate.** Player bootstrap/merge semantics from 1A/A2-A are not changed by this stage.
10. **Additive migration discipline.** Existing V1/V2/V3/V4 functions are not dropped or silently redefined when a versioned successor is safer.
11. **Activation is separate.** Building Stage 1 does not itself re-enable historical ingest.

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
V3 provider mapping row
(provider_team_mappings / provider_competition_mappings)
    |
    | must agree exactly
    v
V4 active attestation
(private current projection)
    |
    | immutable event history proves how it became trusted
    v
historical-ingest identity trust
    |
    v
fixture fact validation
(orientation + competition + kickoff)
    |
    v
Match Ledger ingest
```

The mapping row remains useful operational data.

The attestation is the V4 trust statement.

Neither is sufficient alone.

---

## 5. State model

Use separate typed tables rather than one polymorphic table. This keeps foreign keys and injectivity constraints explicit.

### 5.1 Current team attestation projection

Proposed private table:

`private.provider_team_identity_attestations`

Columns:

```text
provider                    text
provider_team_id            text
team_id                     uuid -> public.teams(id)
attestation_basis           text
evidence                    jsonb
attestation_version         integer
attested_at                 timestamptz
attested_by                 text
```

Constraints:

- primary key `(provider, provider_team_id)`;
- unique `(provider, team_id)`;
- provider/id non-empty checks;
- `attestation_version >= 1`;
- `evidence` must be a JSON object;
- closed `attestation_basis` set.

The table is a **current projection**, not the historical audit log.

### 5.2 Current competition attestation projection

Proposed private table:

`private.provider_competition_identity_attestations`

Columns:

```text
provider
provider_competition_id
competition_id              uuid -> public.competitions(id)
attestation_basis
evidence
attestation_version
attested_at
attested_by
```

Constraints:

- primary key `(provider, provider_competition_id)`;
- unique `(provider, competition_id)`;
- same validation rules as teams.

### 5.3 Immutable event history

Use append-only event tables:

- `private.provider_team_identity_attestation_events`
- `private.provider_competition_identity_attestation_events`

Each event records:

```text
id                          uuid
provider
provider_entity_id
canonical_entity_id
event_kind                  attest | evidence_refresh | revoke
attestation_version
attestation_basis
evidence
recorded_at                 timestamptz
actor
```

Rules:

- event rows are immutable;
- no update/delete/truncate;
- `recorded_at` is database stamped;
- event version is monotonic per `(provider, provider_entity_id)`;
- a revoke event retains the canonical id that was revoked.

### Why current projection + immutable events?

Pure append-only state is attractive, but enforcing active injectivity and making hot-path ingest checks simple becomes unnecessarily complex.

The current projection gives:

- direct unique constraints;
- fast deterministic reads;
- simple mapping-agreement checks.

The event log gives:

- full auditability;
- explicit revocation history;
- evidence evolution without rewriting history.

The current projection is allowed to change only through the Stage 1 RPCs.

---

## 6. Attestation evidence

`attestation_basis` is audit metadata, not a numeric confidence model.

Proposed closed set:

- `operator_manual`
- `cross_provider_verified`
- `provider_official_reference`
- `fixture_identity_crosscheck`
- `multi_source_verified`

The exact set may change during review, but the following must remain true:

- no basis is assigned automatically from a V3 name match;
- no numeric mapping confidence automatically creates an attestation;
- evidence is operator/reconciliation evidence, not a replacement for the canonical mapping row;
- stronger evidence for the **same canonical id** may refresh the current projection and append an `evidence_refresh` event;
- stronger evidence may not silently re-point the canonical id.

---

## 7. Write API

Use explicit service-role-only RPCs.

Proposed functions:

```text
public.provider_identity_attest_team(jsonb)
public.provider_identity_revoke_team(jsonb)
public.provider_identity_attest_competition(jsonb)
public.provider_identity_revoke_competition(jsonb)
```

All are:

- `SECURITY INVOKER`;
- `search_path = ''`;
- executable only by `service_role`;
- unavailable to `public`, `anon`, `authenticated`.

### 7.1 Attest semantics

Team attestation:

1. Require READ COMMITTED.
2. Take the provider identity attestation advisory lock.
3. Lock/read the matching `provider_team_mappings` row.
4. Reject if mapping is missing.
5. Reject if mapping `team_id` differs from requested `team_id`.
6. Reject if the same `(provider, provider_team_id)` is actively attested to another canonical team.
7. Reject if `(provider, team_id)` is actively attested to another provider team id.
8. If the exact same attestation already exists:
   - append `evidence_refresh`;
   - update only evidence/basis/attested timestamp/version in the current projection.
9. Otherwise:
   - insert current attestation;
   - append `attest` event.

Competition attestation is analogous.

### 7.2 Re-pointing

No attestation RPC accepts a new canonical id over an active different one.

Required sequence:

```text
revoke old attestation
-> explicitly correct provider mapping if needed
-> attest new canonical id
```

The temporary gap is intentionally safe: ingest fails closed while no active attestation exists.

A future higher-level reconciliation RPC may make this workflow atomic, but Stage 1 does not need to hide the gap.

### 7.3 Revoke semantics

Revoke:

1. Take the same provider identity lock.
2. Require an active attestation.
3. Append immutable `revoke` event.
4. Remove the row from the current projection.

It does **not** mutate the V3 mapping row.

---

## 8. DML protection

The private current-projection tables should not be casually writable even by application code holding `service_role`.

Proposed protection:

- tables are in the unexposed `private` schema;
- RLS enabled;
- no privileges for `public`, `anon`, `authenticated`;
- service role receives only the privileges required by the RPCs;
- a private row-level guard rejects INSERT/UPDATE/DELETE unless a transaction-local flag such as
  `kapiloto.identity_attestation_rpc = 'on'`
  is set by the Stage 1 RPC;
- event tables reject UPDATE/DELETE/TRUNCATE unconditionally using the existing V4 immutability helper.

This is defense in depth. A database superuser/operator can still deliberately bypass application controls; that is an operational privilege, not an application trust path.

---

## 9. Concurrency and lock order

Attestation changes are rare operator actions. Prefer coarse correctness over lock complexity.

Introduce one provider-level V4 identity lock:

```text
kapiloto_v4_provider_identity:<provider>
```

Attestation/revoke RPCs take it **exclusive**.

Historical ingest takes it **shared**.

Proposed ingest lock order becomes:

1. existing 1A provider-fixture advisory lock;
2. V4 provider-identity advisory lock, shared;
3. competition mapping row;
4. team mapping rows in deterministic provider-id order;
5. existing fixture mapping row if present;
6. existing team-pair/candidate fixture locks;
7. attach/mint writes;
8. existing 1A fixture/provider lock;
9. player identity lock.

Attestation RPCs take:

1. V4 provider-identity lock, exclusive;
2. relevant mapping/current-attestation rows.

They do not take the provider-fixture lock.

This avoids a cycle with ingest while ensuring an attestation cannot be revoked or changed during one ingest transaction.

A concurrency test must prove:

- an in-flight ingest snapshot cannot see half of an attestation change;
- revoke/reattest waits for an ingest that already holds the shared provider lock;
- an ingest that starts after revoke sees no active trust and quarantines.

---

## 10. Historical-ingest trust functions

Do **not** globally redefine `private.provider_mapping_trusted(status, confidence)`.

That helper still has legacy meaning for fixture/player-adjacent A2-A code and changing it globally risks unintended player/bootstrap effects.

Add new explicit helpers:

```text
private.provider_team_attestation_matches(
  provider,
  provider_team_id,
  team_id
) -> boolean

private.provider_competition_attestation_matches(
  provider,
  provider_competition_id,
  competition_id
) -> boolean
```

A match means:

1. the current mapping row exists;
2. the current attestation exists;
3. both point to the same requested canonical id.

The ingest RPC should resolve the mapping first, then require attestation agreement.

New/updated quarantine reasons should distinguish:

```text
team_attestation_missing
team_attestation_mismatch
competition_attestation_missing
competition_attestation_mismatch
```

Do not collapse these back to generic `team_untrusted` / `competition_untrusted`; the new codes make reconciliation diagnosable.

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