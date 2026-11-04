# Kapiloto V4 — Master Roadmap and Handoff

Last verified operational snapshot: 2026-11-04

This document is the fastest entry point for a new ChatGPT conversation, coding agent, reviewer, or human contributor. It does **not** replace the detailed architecture documents or the code. Its job is to explain the system, the current state, the dependency order, the next gates, and where the authoritative details live.

## 1. Source-of-truth order

When sources disagree, use this order:

1. **Production/runtime evidence** — current Supabase schema/data, GitHub branch/PR/CI state, and deployed Vercel commit.
2. **Code + migrations + tests on the relevant branch** — executable contracts beat prose.
3. **Decision Log** — accepted architecture/product decisions.
4. **Detailed architecture/research documents** — intended semantics and invariants.
5. **This document** — navigation, status, dependency order, and handoff.
6. Conversation history / old agent summaries — useful context only; verify material claims against the repo or runtime before acting.

A dated status statement in this file can become stale. Before a production write, merge, migration, or backfill, re-check the live state.

## 2. Product in one page

Kapiloto is a football-analysis system used in the Winner/Toto workflow.

Product roles are intentionally separated:

- **Kapiloto**: fixture-scoped analysis/recommendation.
- **Diego**: autonomous whole-ticket generation/optimization.
- **Structured football providers**: deterministic football facts, identities, match history, lineups/statistics and market inputs where available.
- **Web research / LLM research**: evidence-backed context that structured providers do not fully cover.
- **Deterministic derivation and policy**: probabilities, guards, blend rules, double allocation and publishability are not left to unconstrained model prose.
- **Shadow evaluation**: new predictive components must earn production influence prospectively.

Existing Winner/Toto product behavior must not be silently redefined by V4 work.

## 3. Research/runtime policy

Current project-level policy:

- Research is **demand-driven**. Do not start a Toto/Winner cycle's research until at least one user requests an AI recommendation.
- The first eligible request triggers the central workflow.
- Results are stored centrally and reused; research is not repeated independently for every user.
- At most **3 research rounds per cycle**.
- The intended research model is **GPT-6.1 Sol**; deterministic/server verification remains responsible for acceptance and policy.
- Expensive or high-risk architecture/data changes may receive an independent review from Claude and, when useful, Fable. Independent review is evidence, not authority; runtime/code evidence wins.

See also:
- `docs/ai/KAPILOTO-RESEARCH-V3.md`
- `docs/ai/KAPILOTO-EVALUATION-PLAN.md`
- `docs/ai/KAPILOTO-SHADOW-EVALUATION-V1.md`
- `docs/decisions/DECISION-LOG.md`

## 4. Current architecture boundary: V3 vs V4

### V3

Research V3 is the current research protocol.

Pipeline:

`Fixture Card -> Sol research -> source retrieval -> grounding -> entailment -> grounding policy -> deterministic derivation -> materialization -> persistence -> public API`

Important invariant:

**Only accepted `factors` move `p_sol`.**

Expected lineups, tactical facts, matchup analysis and regime changes in V3 are evidence-backed descriptive research unless connected to an allowed factor under the V3 policy.

V1/V2 historical outputs remain replayable under their frozen rules.

### V4

V4 is additive and is being built as a new scientific/data foundation. It must not silently alter historical V1/V2/V3 semantics.

As of the snapshot above, V4 provides the data/knowledge/forecast foundations but is **not yet the production probability engine**.

The central idea is to separate:

- canonical identity;
- football event time;
- information time ("when Kapiloto knew it");
- immutable source observations;
- current identity corrections;
- frozen prediction inputs;
- deterministic model derivations;
- prospective validation.

## 5. Non-negotiable invariants

Future work should assume these are locked unless a new explicit decision/version changes them.

### Identity

- Canonical internal UUIDs are the real entity identities.
- Provider IDs are mappings, never canonical identity.
- Ambiguous identity does not auto-resolve.
- Missing provider/team identity is not permission to guess.
- Wrong split is safer than wrong merge.
- Existing historical rows are not rewritten to hide identity corrections.
- New writes use surviving canonical identities.
- Provider ingest must fail closed on untrusted mappings.

### Time and leakage

- Event time is not information time.
- `first_seen_at` is the authoritative knowledge-time boundary for strict historical replay.
- A correction is a new version.
- Backfilled historical football data must not be presented as something Kapiloto actually knew at the historical cutoff.
- Retrospective training availability is explicitly versioned and labelled.
- Known-superseded retrospective content is excluded rather than silently rewritten.

### Missingness

- Missing is never zero.
- Empty provider arrays are not proof that a family was provided.
- Family fetch status is explicit.
- A provider contract/type mismatch is a parse failure/quarantine, not ordinary missing data.
- Extra-time statistics are not treated as clean 90-minute statistics when they cannot be separated.

### Prediction science

- Frozen historical predictions must retain the exact input bundle and version semantics used at creation time.
- New feature semantics receive new version names; frozen artifacts do not change meaning.
- Backtesting does not justify prospective production claims by itself.
- Calibration/weights/effect sizes are candidates until forward evidence promotes them.

## 6. Completed V4 foundations

### DONE — Foundation 1A: canonical entities + bitemporal Match Ledger

Decision: D-049/D-050  
Primary doc: `docs/architecture/KAPILOTO-V4-FOUNDATION.md`

Implemented:

- canonical players/coaches and aliases;
- provider player/coach mappings;
- merge-aware identity rules;
- immutable, versioned Match Ledger observations;
- team records, players, substitutions, events and stat definitions;
- information-time/as-of reads;
- withdrawals/corrections;
- provider-scoped history;
- conflict/reconciliation inputs;
- concurrency and immutability guards.

Core migration:
`20261028010437_kapiloto_v4_entities_match_ledger.sql`

### DONE — Foundation 1B: Knowledge + Prediction Registry

Decision: D-051/D-052  
Primary doc: `docs/architecture/KAPILOTO-V4-KNOWLEDGE-REGISTRY.md`

Implemented:

- immutable document/document-version archive;
- structured claims and claim observations;
- relations and claim-resolution history;
- rights/provenance constraints;
- immutable prediction snapshots;
- exact input-link bundles;
- identity bindings;
- merge-aware canonical claims;
- as-of knowledge reads.

Purpose: preserve exactly what Kapiloto observed, believed, resolved, and used in a prediction.

### DONE — Foundation 1C: roster membership + pre-match Squad State

Decision: D-053  
Primary doc: `docs/architecture/KAPILOTO-V4-SQUAD-STATE.md`

Implemented:

- immutable/versioned team-player membership assertions;
- cutoff-safe raw squad inputs;
- deterministic pure squad-state builder;
- selected historical fixtures with explicit provider priority;
- per-feature knownness;
- accepted availability/lineup evidence rules;
- coach-state derivation;
- no lineup probability at this layer.

### DONE — Foundation 1D: lineup baseline + Prediction Registry V2

Decision: D-054  
Primary doc: `docs/architecture/KAPILOTO-V4-LINEUP-MODEL.md`

Implemented:

- `lineup_forecast` snapshot kind;
- frozen squad-state context;
- membership/tenure links;
- deterministic baseline lineup model;
- start/appearance/minutes baseline outputs;
- replayable canonical artifacts;
- output validation and baseline evaluation metrics.

The model is a baseline/challenger reference, not proof of production quality.

### DONE — membership-aware Squad Features V2

Decision: D-055  
Primary doc: `docs/architecture/KAPILOTO-V4-SQUAD-STATE.md`

Implemented:

- corrected known-non-start semantics using membership certainty;
- V1 frozen behavior preserved;
- V2 builder/features introduced additively;
- new forecasts use V2.

### DONE — Provider ingest contracts A2-A

Decision: D-056  
Primary doc: `docs/architecture/KAPILOTO-V4-PROVIDER-INGEST.md`

Migration:
`20261030101247_kapiloto_v4_provider_ingest.sql`

Implemented:

- Sportmonks capture contract;
- pure offline parser;
- provider fixture ingest RPC;
- append-only ingest audit;
- family fetch statuses;
- provider-ref sidecars;
- strict historical-ingest trust boundary;
- fixture attach/mint guards;
- capture-quality flags;
- seven verified Sportmonks stat definitions;
- strict team-match-stats read;
- retrospective-training-only read and exclusion report;
- provider mapping/ref conflict reports;
- locking/reconciliation protections.

A2-A deliberately did **not** call Sportmonks or run a historical backfill.

### DONE — Stage 0 identity-mapping containment

Decision: D-057

Migration:
`20261030211645_kapiloto_v4_identity_mapping_guard.sql`

Production status: applied 2026-10-30.

Implemented:

- database-level `BEFORE UPDATE` guards on existing Sportmonks team,
  competition and fixture mappings;
- the same protection for any `manual_override` row of any provider;
- explicit transaction-local operator override via
  `kapiloto.identity_operator`;
- INSERT and DELETE behavior left unchanged;
- historical provider ingest paused by revoking `service_role` EXECUTE on
  `match_ledger_ingest_provider_fixture(jsonb)`.

Why this exists:
V3 structured sync was proven to overwrite Sportmonks mapping status/identity
and to promote its own prior name matches from confidence 0.9 to 1. The issue
was observed live in production through both the 15-minute precompute path and
the daily structured-sync path.

M1 is containment, not the final trust model. Existing Sportmonks
`confirmed`/confidence-1 rows remain suspect until re-attested under Stage 1.


## 7. ACTIVE — A2-B real-provider pilot and reconciliation

A2-B is the current workstream.

Current implementation (2026-11-04): a draft PR on
`feat/v4-provider-ingest-a2b-pilot-v3`. It ports PR #30 onto the current V4
mainline and merges it with the 2026-11-02 family/history readiness tool into
one read-only pilot, described in `KAPILOTO-V4-PROVIDER-INGEST.md` under "A2-B
provider pilot".
- It **supersedes PR #30** (`feat/v4-provider-ingest-a2b-pilot-v2`, head
  `e5c1d579`), which superseded PR #19. Neither older PR is merged or revived.
- It is not merged.
- Its independent adversarial review of head `76ab92a` (2026-11-04) passed
  the real-dispatch gate; the merge gate was not evaluated. The review's
  credential-guard and fixture-identity findings were then fixed on the branch
  by the reviewer, so that fix diff has had no separate review. The other
  findings stay open for the merge review.
- It has not been dispatched against real Sportmonks.

A2-B is therefore **not complete**.

History, superseded by the above:

Branch:
`feat/v4-provider-ingest-a2b-pilot`

Draft PR:
`#19 — V4 A2-B: verify Sportmonks entitlement and real payload semantics`

Snapshot head:
`90d11385bcdc1e0544bfcc75da12c4d8b1d332c2`

Base `main` at the time:
`e0826c780dca6e388ef65fa595046716d0ce3adb`

### What the original A2-B branch (PR #19) added

- read-only Sportmonks pilot capture;
- raw-response SHA-256 before JSON parsing;
- entitlement verification;
- real payload audits;
- focused parser/pilot tests;
- GitHub Action using the existing Sportmonks secret;
- artifacts containing captures and the pilot report.

The PR itself does not perform historical backfill.

### Real Sportmonks pilot result

Executed on 2026-10-30.

Target competitions:

| Sportmonks league ID | Competition |
| --- | --- |
| 8 | Premier League |
| 82 | Bundesliga |
| 564 | La Liga |
| 384 | Serie A |
| 372 | Ligat ha'Al |

Results:

- all five were present in the provider entitlement response;
- all five provider names matched the expected competition identity;
- two finished fixtures per competition were captured, **10 total**;
- all 10 passed the A2-A parser;
- no parse failures;
- focused A2-B/parser tests passed;
- TypeScript typecheck passed;
- full V4 regression passed;
- normal PR CI/build passed.

Aggregate real-payload gates reported pass for:

- participant home/away identity;
- score semantics;
- lineup type IDs;
- broad position IDs;
- possession sanity;
- shots-on-target <= total shots;
- non-penalty xG <= xG when observable;
- explicit-zero evidence.

### Known review nuance: gate aggregation

The current aggregate gate rule is effectively:

- any `fail` => global fail;
- otherwise any `pass` => global pass;
- otherwise `unverified`.

Therefore a provider-wide gate can pass even when some competitions are `unverified`.

Observed example:
the sampled Ligat ha'Al fixtures did not provide enough allow-listed xG data to compare non-penalty xG with xG, while other competitions did. The global gate still passed.

This is under independent review. Do not conflate:

1. provider-wide field semantics;
2. competition identity/entitlement;
3. per-competition family availability;
4. backfill acceptance/coverage.

Missing optional xG must remain missing; it is not a reason to invent zero.

### 2026-11-02 per-league family/history readiness

The operator-dispatched workflow
`Kapiloto V4 Sportmonks Family/History Readiness` was rerun on `main`
commit `2b2aa7cc9bab39582b0137eb3fadc5eba0d1e1ab` after fixing season
fixture discovery and one real Sportmonks edge case: a bench row with
`player_id = null`. The parser remains strict for starters; an unidentified
bench row is not promoted into a canonical player observation.

This run used the pre-amendment readiness tool. On the v3 draft PR the same
workflow file runs the amended A2-B pilot, renamed "Kapiloto V4 Sportmonks
A2-B Pilot (read-only)". The coverage below is still valid observed evidence.
It is not the "A2-B amended and re-run" gate.

Run:
`41421166450`

Configuration:
- 5 target competitions;
- 3 seasons per competition;
- 2 finished fixtures per season;
- **30 fixtures total**.

Result:
- **30/30 parse passes**;
- **0 semantic failures**;
- **0 blocking errors**;
- every sampled season reported `sample_clean`;
- the workflow's full V4 regression suite also passed.

Observed family coverage in the sample:

| Competition | Seasons | Fixtures | Lineups | Formations | Statistics | xG |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Premier League | 3 | 6 | 100% | 100% | 100% | 100% |
| Bundesliga | 3 | 6 | 100% | 100% | 100% | 100% |
| La Liga | 3 | 6 | 100% | 100% | 100% | 100% |
| Serie A | 3 | 6 | 100% | 100% | 100% | 100% |
| Ligat ha'Al | 3 | 6 | 100% | 100% | 100% | **0%** |

Interpretation:
- the four sampled top-European competitions are ready, at this pilot depth,
  for historical lineups, formations, conventional statistics and the
  allow-listed xG family;
- Ligat ha'Al is ready for historical lineups, formations and conventional
  statistics at this pilot depth, but **xG is not an available capability in
  the sampled three-season history**;
- xG availability is therefore a per-competition/per-fixture capability, not
  a provider-global invariant;
- the Ligat ha'Al xG absence is explicit missingness and must never be
  converted to zero or treated as an ingest failure.

This closes the family/history-readiness evidence gate. It does **not** make
M2B a GO by itself. The deferred identity reconciliation for Sportmonks 52 AFC
Bournemouth and 676 Sevilla, and the full 20/20 R7 checks, were completed on
2026-11-03 after Winner round 264301 settled. The other M2B gates under
Gate 6 remain.

### Operational competition promotion already performed

After the entitlement/identity pilot, exactly these five Sportmonks competition mappings were promoted in production from `confirmed` to `manual_override` in one guarded transaction:

- 8 Premier League
- 82 Bundesliga
- 372 Ligat ha'Al
- 384 Serie A
- 564 La Liga

Post-checks found no mapping conflicts/provider-ref conflicts.

This was an operator data action, not a migration. A future documentation/reconciliation change may record the operational evidence without pretending the DB update was schema history.

## 8. CURRENT BLOCKER — A2-B/M2B readiness (pilot identity reconciliation complete 2026-11-03)

Historical Match Ledger ingest is currently paused in production by D-057.

The immediate blocker is no longer merely "map the missing teams". The trust
model itself must move away from V3-owned `mapping_status` /
`mapping_confidence` columns before any real ingest resumes.

Stage 1 must introduce a V4-owned attestation boundary for team and competition
identity. At minimum:

- V3 mapping row and V4 attestation must agree on the canonical id;
- an unattested mapping is not trusted for historical ingest;
- one trusted Sportmonks provider id per canonical team/competition is enforced
  at the attestation boundary;
- fixture trust is derived from attested teams/competition plus fixture
  orientation/kickoff checks rather than V3 confidence promotion;
- player bootstrap semantics remain separate and unchanged;
- ingest EXECUTE is re-granted only after the Stage 1 migration and tests pass.

Accepted design: D-058 and `docs/architecture/KAPILOTO-V4-IDENTITY-ATTESTATIONS-RFC.md`.

**M2A status: merged and applied to production on 2026-10-31.**
Canonical merge commit: `5327dc371751a75b79d2c2612471b55b7c6436af`.
Production migration:
`20261031100000_kapiloto_v4_identity_attestations.sql`.

Post-apply verification:
- `private` is not exposed in Supabase Data API; only `graphql_public` and
  `public` are exposed;
- V1 and V2 provider ingest are both non-executable by `service_role`;
- all Stage 1 attestation tables/RPCs/V2 readers/reports exist with the
  intended SECURITY INVOKER / empty-search-path contracts;
- deployment itself created no attestation or Match Ledger data;
- Match Ledger still had 0 observations after deployment;
- `match_ledger_provider_ref_conflicts_v2('sportmonks')` was empty.

### Pilot identity reconciliation execution status

Reviewed plan:
`docs/operations/2026-10-31-v4-pilot-identity-reconciliation.md`

Execution record:
`docs/operations/2026-10-31-v4-pilot-identity-reconciliation-execution.md`

PR #28 was independently red-teamed twice, reconciled, and merged as
`0bde9b1562c4917e562c10038afd5bafbe7dbab4`.

Production execution completed:
- R1 read-only baseline snapshot;
- R2: **5/5 pilot competitions attested** at version 1;
- R3: the five legacy confidence-1 Sportmonks team mappings were promoted to
  `manual_override` under locked duplicate audits without changing confidence;
- R5: **13 new canonical teams** were created with reviewed Telesport/Winner
  Hebrew spellings, aliases and Sportmonks `manual_override` mappings with
  `mapping_confidence = NULL`;
- R6: those 5 legacy + 13 new identities were attested separately, so
  18/20 pilot teams were attested on 2026-10-31. R4 below brought the total
  to 20/20;
- partial R7 passed: no identity conflicts, no folded canonical duplicates,
  no Sportmonks injectivity conflict, no provider-ref conflicts, 0 ingest runs,
  0 fixture mints and 0 Match Ledger observations;
- V1/V2 ingest remains revoked and all D-057 guards remain enabled.

R4 was deferred until Winner round 264301 settled, because that round
contained Bournemouth-Leeds and Getafe-Sevilla. It was completed on
2026-11-03, once the round was settled (16/16 games, D-062 guarded
correction):
- Sportmonks 52 AFC Bournemouth -> existing `בורנמות'` and Sportmonks 676
  Sevilla -> existing `סביליה`, each in its own locked transaction:
  - a `manual_override` mapping with `mapping_confidence = NULL`;
  - only the reviewed aliases;
  - locked duplicate-audit hashes `97b46fbc…40a9` and `0ce76658…3ff9`;
- each identity was attested separately (R6), version 1;
- **full 20/20 R7 passed**:
  - 5/5 competitions and 20/20 teams attested and agreeing with
    `manual_override` mappings;
  - one `attest` event per identity and no refresh/revoke;
  - readiness and provider-ref conflicts V2 empty;
  - no duplicate or injectivity violation;
  - 0 Match Ledger observations, fixture mints and ingest runs.

The natural-cycle observation window after R4 was complete by 2026-11-04. The
read-only preflight of the next identity operation re-confirmed it: no
duplicate or conflict appeared, Sportmonks fixture mappings stayed at 32, and
52/676 were unchanged.

M2B remains NO-GO. PR #43 (D-060) is merged and its production migration is
applied, so the "uncovered Match Ledger reads" gate is closed:
attestation-aware V2 consumer reads, a conservative history window, and a
Prediction Registry bound to the squad-state read each lineup forecast used.
The Winner round 264301 / Bournemouth 52 / Sevilla 676 / full 20/20 R7
blocker is now closed as well. The remaining M2B gates are listed under
Gate 6.

### Previously treated as trusted under A2-A columns: 5/20

- Sportmonks 3 — Sunderland
- Sportmonks 71 — Leeds United
- Sportmonks 516 — Hapoel Be'er Sheva
- Sportmonks 571 — Maccabi Haifa
- Sportmonks 6900 — Hapoel Petah Tikva

### Unmapped and still requiring reconciliation after Stage 1: 15/20

- 14 — Manchester United
- 52 — AFC Bournemouth
- 83 — FC Barcelona
- 109 — Fiorentina
- 459 — Osasuna
- 503 — FC Bayern München
- 589 — Beitar Jerusalem
- 676 — Sevilla
- 708 — Atalanta
- 2726 — TSG Hoffenheim
- 3321 — Bayer 04 Leverkusen
- 3468 — Real Madrid
- 3543 — SC Freiburg
- 4070 — Frosinone
- 7790 — Lecce

All 15 are now reconciled and attested: 13 through R5 (new canonical teams,
2026-10-31) and 52/676 through R4 (existing canonical teams, 2026-11-03).

The canonical `teams` table is intentionally not a complete world-football catalog. Many canonical names are Hebrew and were created by Toto/import flows.

Examples already observed:

- AFC Bournemouth exists canonically as `בורנמות'`.
- Sevilla exists canonically as `סביליה`.
- Some of the other 15 may not exist yet.

Do **not** infer:
`missing provider_team_mapping => create a new canonical team`.

First reconcile against canonical teams + aliases + competition/country/provider evidence. Cross-language identity must be explicit and auditable.

## 9. Immediate next sequence

This is the safe dependency order from the current state.

### Gate 1 — verify Stage 0 under natural production traffic

D-057 is applied and the immediate post-checks passed.

Still verify:

- at least two natural 15-minute precompute cycles do not change existing
  Sportmonks mappings;
- the next 05:22 UTC structured-sync also leaves them unchanged;
- all five target competitions remain `manual_override`;
- conflict reports remain empty.

### DONE — Gate 2: V3 code aligned with the database guard

Production commit: `aa5568a78b67646496ad3159617bfb90284bb69e`

`SupabaseSportmonksSyncStore.saveResolvedFixture` now writes Sportmonks
identity mappings insert-only. Existing rows are never rewritten by V3, new
missing rows may still bootstrap for V3/shadow use, and V3 Sportmonks mapping
confidence remains weak evidence at 0.9 even when resolution uses a previously
known provider fixture id.

The D-057 DB trigger remains the safety boundary; the V3 code change removes
the repeated overwrite attempts and self-promotion path rather than replacing
the database guard.

### DONE — Gate 3: Stage 1 V4 identity attestations (M2A applied production)

D-058 accepted the architecture. M2A is merged at
`5327dc371751a75b79d2c2612471b55b7c6436af` and applied to production:

- current team/competition projections plus immutable event generations,
  injectivity in both directions, `ON DELETE NO ACTION` canonical FKs;
- attest/revoke RPCs (Sportmonks only, `manual_override` mapping required,
  first-write-of-transaction rule, function-level `lock_timeout = 5s`,
  exclusive provider identity lock, flag + lock-guarded projection/event DML);
- observation identity-attestation sidecar with typed event FKs and integrity
  checks;
- `match_ledger_ingest_provider_fixture_v2` (mandatory run allowlist, full
  candidate classification for existing fixture mappings, pair lock on both
  paths, selected fixture row `FOR SHARE`, `attestation_generation_stale`);
- V2 team-match-stat reads and trust-aware exclusions for every provider;
- entity readiness report, observation-level reconciliation V2, revocation
  impact report;
- V1 ingest and V2 ingest both revoked from `service_role`; the V1 stat reads,
  V1 exclusions and V1 provider-ref report are de-authorized but present.

Post-apply checks passed, including the production Data API exposure check.
Ingest stays disabled until M2B. Next active work is pilot identity
reconciliation plus the remaining M2B readiness gates.

Recovery of a chain that V2 wrongly **minted**: it is never minted again
(the applied A2-A `match_ledger_fixture_mints` is unique per
`(provider, provider_fixture_id)`; V2 quarantines `fixture_mint_exists`). The
operator creates the reviewed canonical fixture row and the re-ingest attaches
to it; the orphaned mint is reported as `mint_without_mapping`. Both paths are
tested; the runbook rehearsal before M2B covers them.

### Gate 4 — amend A2-B pilot tooling

Status: **implemented on the v3 draft PR, not done.**
- It covers every item below.
- The independent adversarial review of `76ab92a` passed the real-dispatch
  gate (2026-11-04); its credential-guard and fixture-identity findings are
  fixed on the branch.
- A real read-only dispatch is pending.

The dispatch must not run before that review. Its report always says
`backfillApproval.approved = false` and `teamIdentityReadiness.assessed =
false`.

Apply the independent-review findings to PR #19 (now carried by PR #30 and
then the v3 draft PR):

- workflow should be operator-dispatched rather than provider-calling on each
  push;
- preserve raw response bytes keyed by hash;
- make entitlement pagination fail closed at the cap;
- strengthen country/competition identity checks;
- replace pooled global gate summaries with provider-semantics evidence,
  per-competition evidence and coverage profiles;
- remove `explicitZero` as an acceptance gate;
- strengthen score/lineup/position discriminating checks;
- sample every season before that season is backfilled.

Do not use the old global PASS as backfill approval.

### DONE — Gate 5: reconcile pilot teams through the Stage 1 mechanism

Status: **DONE.** 5/5 pilot competitions and **20/20 pilot teams are
attested**. R4 for Bournemouth/Sevilla was completed on 2026-11-03 after round
264301 settled, the full 20/20 R7 passed, and the natural-cycle observation
window was complete by 2026-11-04.

The completed reconciliation classified each missing provider team as one of:

1. map to an existing canonical team;
2. create a new canonical team;
3. require more operator evidence.

Rules remain:

- fail closed;
- no fuzzy auto-merge;
- no cross-language name-only decision;
- no duplicate canonical team;
- no silent overwrite;
- fixture/cross-provider anchors are stronger than names/transliteration.

The five mappings that A2-A previously treated as trusted were independently
re-reviewed, promoted to manual_override and attested; they were not
grandfathered merely because they were confidence 1.

Before Gate 5 is complete:
- DONE (2026-11-03): R4 for Sportmonks 52/676 after round 264301 settled;
- DONE (2026-11-03): both attested separately;
- DONE (2026-11-03): full 20/20 R7;
- DONE (2026-11-04): after natural precompute cycles, a structured sync and a
  round 264401 update, the duplicate/collision audit and the
  readiness/conflict reports were clean and no canonical duplicate appeared.

### Gate 5B — Supported Competition Registry for V4 launch (D-059)

V4's first user-facing release is intentionally scoped to a reviewed set of
supported competitions rather than attempting autonomous identity creation for
arbitrary world football.

Initial supported competitions:

1. Premier League — Sportmonks 8
2. Bundesliga — Sportmonks 82
3. La Liga — Sportmonks 564
4. Serie A — Sportmonks 384
5. Ligat Ha'al — Sportmonks 372

Product rule: a normal user may request full V4 analysis only for fixtures in a
competition whose registry state is `supported`. A fixture outside the
supported registry is not silently bootstrapped into the canonical catalog in
V1; the product should state that the competition is not yet supported.

Registry lifecycle:

`candidate -> validating -> supported -> paused`

A competition reaches `supported` only after:

- provider entitlement and competition identity are verified;
- all current member clubs required for user-facing coverage have canonical
  identities;
- provider mappings/aliases are reconciled without duplicates;
- identity attestations are complete under the active V4 trust contract;
- historical family coverage and parser semantics are validated sufficiently
  for the features the product will expose;
- conflict/readiness reports are clean for the supported scope;
- a documented rollback/pause path exists.

Team bootstrap inside V1 is therefore a **league-onboarding operation**, not a
per-user runtime operation. When a new league is added later, Kapiloto performs
the same reviewed onboarding for that league and its clubs, then promotes the
competition to `supported`.

The canonical catalog does not need to contain every club in world football.
It needs complete, reviewed identity coverage for the competitions currently
advertised as supported.

The future autonomous Identity Bootstrap / Reconciliation service remains a
possible later expansion, but it is **not a launch blocker and not required for
V4 V1**.


Current onboarding status:
- Ligat Ha'al: **identity-complete 14/14**, registry still `validating`;
- Premier League: **identity-complete 20/20**, registry still `validating`.
  Bournemouth 52 was completed by pilot R4 on 2026-11-03. Liverpool 8,
  Arsenal 19 and Ipswich 116 were completed on 2026-11-04;
- Bundesliga: **identity-complete 18/18**, registry still `validating`;
- La Liga: **18/20 identity-complete**. Sevilla 676 was completed by pilot
  R4 on 2026-11-03. Getafe 106, Rayo Vallecano 377 and Real Sociedad 594 were
  completed on 2026-11-04. Elche 1099 and Athletic Club 13258 remain deferred
  Class-B mappings only because they play in open Winner round 264401
  (games 13 and 12);
- Serie A: **identity-complete 20/20**, registry still `validating`.
  Juventus 625 was completed on 2026-11-04.

Execution records:
- Ligat Ha'al:
  `docs/operations/2026-10-31-v4-ligat-haal-identity-onboarding-execution.md`
- Premier League phase 1:
  `docs/operations/2026-10-31-v4-premier-league-identity-onboarding-phase1.md`
- Bundesliga:
  `docs/operations/2026-11-01-v4-bundesliga-identity-onboarding-execution.md`
- La Liga phase 1:
  `docs/operations/2026-11-01-v4-laliga-identity-onboarding-phase1.md`
- Serie A phase 1:
  `docs/operations/2026-11-01-v4-serie-a-identity-onboarding-phase1.md`
- Deferred Class-B identities, 7 of 9 (PL, La Liga and Serie A, 2026-11-04):
  `docs/operations/2026-11-04-v4-class-b-deferred-identities-execution.md`

Premier League provider membership is frozen by the read-only Sportmonks
season-roster capture for league 8 / season 28083. That capture returned the
full 20-team 2026/27 roster and resolved Sunderland as provider team 3; a
conflicting public provider page value of 27 was rejected in favor of runtime
API evidence.

Identity completion alone does not promote the league to `supported`; provider-
family semantics/coverage and historical quality gates still apply.

### Gate 6 — tiny real Match Ledger ingest

Only after M2A is applied, team reconciliation is done and M2B is reviewed,
grant V2 ingest (M2B) and run the smallest useful real pilot. M2B stays NO-GO
while the 1A/1C Match Ledger reads (`squad_state_inputs_as_of`, the 1A
observation/team/player as-of reads and the lineup/squad-state snapshot paths)
are not attestation-aware and could be activated; a boundary test now proves
no production app/script/cron path calls them.

**PR #43 — attestation-aware consumer reads (D-060; merged and
applied).** What it solves:

- V2 successors `match_ledger_observation_as_of_v2`,
  `match_ledger_provider_team_matches_as_of_v2`,
  `match_ledger_provider_player_matches_as_of_v2` and
  `squad_state_inputs_as_of_v2`. Each selects the latest visible version
  first (no resurrection) and the V1 last-N window next (conservative: an
  untrusted fixture shrinks history, nothing older replaces it). Only then
  does it keep observations whose sealed league/home/away attestations are
  currently valid. Trust is evaluated at current state.
- Registry read binding: `prediction_squad_state_context.squad_state_read_version`.
  Frozen snapshots are read-v1 with byte-identical bundle hashes (golden and
  upgrade tested). New lineup forecasts are read-v2. The commit check
  re-runs exactly the declared read.
- The V1 consumer reads are de-authorized from `service_role`, which cannot
  record new read-v1 forecasts. Ingest privileges are untouched (M2A
  revocations stand).

What still blocks M2B after PR #43:

- DONE: PR #43 migration reviewed and applied to production, with
  post-checks: grants, `private` not exposed, column backfilled read-v1,
  0 snapshots changed;
- DONE (2026-11-03): Winner round 264301 settled (D-062 guarded correction,
  16/16 games), then Sportmonks 52 Bournemouth and 676 Sevilla were
  reconciled (R4/R6) and the full 20/20 R7 passed;
- DONE (2026-11-04): entity/reconciliation reports are clean for the pilot
  scope, immediately after R4 and again after the natural-cycle window;
- A2-B amended and re-run. **Not done.** The amendment is the v3 draft PR
  (`feat/v4-provider-ingest-a2b-pilot-v3`, superseding PR #30 and PR #19). It
  still needs independent review, merge and a real operator dispatch whose
  evidence is reviewed. The 2026-11-02 readiness run used the pre-amendment
  tool and does not count as this re-run;
- DONE: the recovery runbook is implemented, independently reviewed by Claude and Fable, and merged in PR #47 (`7d41c43045ced8f582393e831e176eba2757cbeb`):
  - the hardened M2C body (both ingest RPCs, every non-operator role) with a
    read-only verification;
  - reviewed operator SQL templates;
  - minted fixtures corrected in place;
  - synthetic rehearsal of the team and competition incidents, out-of-order
    failure and resume, and frozen-forecast reporting;
- before the tiny M2B pilot: one two-session rehearsal on real PostgreSQL
  outside production must prove the in-flight V2 ingest/revoke behavior that
  single-backend PGlite cannot demonstrate;
- the reviewed immutable run allowlist fixed;
- the separate grant-only M2B migration itself, reviewed.

Known follow-up (not an M2B blocker introduced by PR #43): the revocation
impact report does not yet list Prediction Registry snapshots whose frozen
inputs used revoked history (`prediction_ledger_inputs`). Those snapshots
remain valid frozen records; the operator view of "which forecasts used
revoked history" is future work. **Addressed by PR #47:**
`docs/operations/sql/kapiloto-v4-recovery-affected-forecasts.sql` (read-only)
lists them and is a mandatory step of every incident.

Minimum expectations:

- one existing-mapping fixture plus one safe mint-path fixture;
- exact capture hashes/family statuses preserved;
- no quarantine bypass;
- canonical identities match attestations;
- strict as-of and training reads preserve missingness;
- re-ingest identical content returns unchanged;
- negative control with an unattested team quarantines;
- conflict reports remain empty.

Then inspect the actual persisted rows, not only the RPC return value.

### Gate 7 — scoped historical backfill

Expand only after the tiny ingest is clean.

Suggested progression:

1. the 10 pilot fixtures;
2. one matchweek per competition;
3. one season slice per competition;
4. multiple target competitions;
5. broader historical corpus.

At every expansion check quarantine, identity conflicts, family coverage,
parse/semantic violations, duplicate-fixture risk, correction behavior,
provider rate/cost constraints and restart/idempotency.

Historical training output must remain labelled retrospective and must never be
confused with strict actual knowledge-time replay.

## 10. Downstream V4 roadmap

The items below describe the dependency direction. Some are already implemented foundations; later model details are **not automatically frozen architecture decisions** until documented/versioned.

### Stage A — trustworthy structured history

Dependency:
A2-B reconciliation + ingest + controlled backfill.

Outcome:
enough clean Match Ledger history to support squad/lineup/player/tactical model development without web-derived historical reconstruction.

### Stage B — squad/lineup evaluation on real history

Use the existing:

- Squad State V2;
- Lineup Model V1 baseline;
- Prediction Registry V2;
- frozen input bundles.

Evaluate prospectively where possible and retrospectively only under the explicit retrospective policy.

Primary questions:

- starter probability quality;
- modal-XI hits;
- appearance quality;
- expected-minutes MAE;
- behavior on transfers/new signings/missing lineups;
- whether a challenger beats the transparent baseline.

### Stage C — player impact and replacement context

Foundation 1A explicitly anticipates later:

- minutes models;
- replacement chains;
- player impact/strength;
- coach model.

These should use Match Ledger + frozen identity/knowledge inputs, not ad-hoc current-state joins that leak later corrections.

Any numerical effect size must be versioned and evaluated before production influence.

### Stage D — tactical/team state

Foundation work anticipates:

- tactical state;
- game-state-aware history;
- set-piece/goalkeeper/team-style features where provider coverage supports them;
- matchup hypotheses;
- coach/regime effects.

Research V3 already has descriptive tactical/matchup structures, but V4 structured history is intended to make those concepts more deterministic and historically testable.

Do not double-count the same signal from structured data and web research.

### Stage E — Knowledge Registry + structured claims integration

Use the V4 Knowledge Registry to separate:

- source documents;
- source claims;
- Kapiloto-derived inferences;
- contradictions/corrections;
- prediction-time accepted evidence.

Research should increasingly write/reuse these durable structures instead of treating one analysis JSON as the entire truth system.

### Stage F — match/probability engine challengers

Build deterministic/versioned challengers from:

- market/stat baseline;
- structured team strength;
- squad/lineup state;
- player-impact state;
- validated tactical/team-state features;
- verified fresh research claims.

No component gets probability influence merely because it is intuitively plausible.

### Stage G — forward evaluation, calibration, promotion

Primary authority:
`docs/ai/KAPILOTO-EVALUATION-PLAN.md`

Requirements include:

- forward pre-match evidence;
- frozen cutoffs;
- no post-cutoff leakage;
- proper scoring vs strong baseline;
- calibration;
- stability;
- double-ranking usefulness;
- grounding/security;
- cost/latency.

Only validated challengers are promoted.

### Stage H — V4 production activation

V4 should reach production influence gradually, by versioned component/arm, not as a single "turn V4 on" switch.

Hard product gate: general user-facing V4 activation is restricted to
competitions whose D-059 Supported Competition Registry state is `supported`.
V1 does not promise arbitrary world-football coverage. Unsupported
competitions remain unavailable until their league onboarding is completed.

Preserve:

- frozen V1/V2/V3 replay;
- prediction provenance;
- rollback/champion-challenger comparison;
- explicit feature/model/calibration versions.

## 11. What is explicitly NOT done yet

As of the snapshot date:

- the D-059 Supported Competition Registry is not fully complete yet. Ligat
  Ha'al is identity-complete 14/14, Bundesliga 18/18, Premier League 20/20,
  La Liga 18/20 and Serie A 20/20. All 92 launch-universe clubs exist
  canonically. The only 2 remaining identity gaps are the deferred Class-B
  mappings Elche 1099 and Athletic Club 13258. They are held back only
  because both play in open Winner round 264401. Each still needs its own
  reviewed operation once that round is no longer active. All five leagues
  still require the applicable provider-family/history gates before
  `supported`;
- no broad Sportmonks historical backfill;
- no real A2-B Match Ledger pilot observation has been persisted yet; historical provider ingest stays paused: M2A is applied in production, V1 and V2 ingest remain non-executable by `service_role`, and only the separate M2B migration may grant V2;
- the pilot identities are complete: 20/20 teams and 5/5 competitions are
  attested, the full R7 passed on 2026-11-03, and the natural-cycle
  observation window was clean by 2026-11-04;
- PR #19 and PR #30 are not merged and are superseded. The amended A2-B
  pilot is the v3 draft PR (`feat/v4-provider-ingest-a2b-pilot-v3`). It is not
  merged, not independently reviewed and not yet dispatched against real
  Sportmonks;
- PR #43 (D-060, attestation-aware consumer reads and the squad-state read
  binding) is merged as `a531187794681469d203ade3e1a01b78b92625cc` and its production migration is applied; the
  1A/1C reads remain the only consumer reads in production, and no
  production path calls them;
- V4 Match Ledger is not silently feeding V3 research/probabilities;
- the V4 lineup baseline is not established as a production-quality lineup predictor;
- player-impact/replacement/tactical match-engine layers are not production-complete merely because the foundation anticipates them;
- retrospective data is not proof of live historical knowledge;
- optional/missing provider families are not treated as zeros.

## 12. Agent workflow and safety discipline

For future chats/agents:

### Before changing anything

1. Read this file.
2. Read the primary detailed doc for the workstream.
3. Read the relevant Decision Log entries.
4. Inspect current code/tests/migrations.
5. Verify current branch/PR/runtime state.
6. State which invariant/version will change, if any.

### Repo work

- Prefer a focused branch and PR.
- Keep one conceptual change per PR when practical.
- Run focused tests plus the affected regression suite.
- A green test suite does not replace real-provider/runtime validation when external semantics are involved.
- Do not mix an unrelated master-documentation rewrite into a data-ingest implementation PR.

### Database work

- Schema changes belong in committed migrations.
- If a canonical migration file already exists, apply that exact migration rather than recreating equivalent SQL with a different timestamp.
- Production data writes should be narrowly scoped, transactional where possible, assert expected row counts, and have post-write validation.
- Do not promote mappings or create identities merely to make a pilot pass.

### Local PowerShell

PowerShell is not the normal project-development workflow. It was used for the 2026-10-30 A2-A deployment because the safest operation was to apply the **exact committed migration file** from the locally linked Supabase CLI without creating timestamp/history drift.

Normal coding/review/CI/database inspection should use the connected project tools when available. Use local commands only when the operation genuinely depends on the user's linked local environment.

### Independent reviews

Claude/Fable are useful for:

- architecture trust boundaries;
- migration/data-integrity review;
- reconciliation policy;
- backfill acceptance;
- large refactors;
- adversarial review before irreversible data actions.

Give reviewers exact commits/files/runtime evidence. Do not ask them to guess repository state from a prose summary alone when they can inspect it.

## 13. Canonical reading map

A new agent should use this map rather than search randomly.

### V4 core

- `docs/architecture/KAPILOTO-V4-FOUNDATION.md`
- `docs/architecture/KAPILOTO-V4-KNOWLEDGE-REGISTRY.md`
- `docs/architecture/KAPILOTO-V4-SQUAD-STATE.md`
- `docs/architecture/KAPILOTO-V4-LINEUP-MODEL.md`
- `docs/architecture/KAPILOTO-V4-PROVIDER-INGEST.md`
- `docs/architecture/DATA-MODEL.md`
- `docs/decisions/DECISION-LOG.md`

### Research/evaluation

- `docs/ai/KAPILOTO-RESEARCH-V3.md`
- `docs/ai/KAPILOTO-RESEARCH-V2.md`
- `docs/ai/KAPILOTO-RESEARCH-V2-DISCOVERY.md`
- `docs/ai/KAPILOTO-EVALUATION-PLAN.md`
- `docs/ai/KAPILOTO-SHADOW-EVALUATION-V1.md`

### General system/product

- `docs/architecture/SYSTEM-ARCHITECTURE.md`
- `docs/architecture/ROUND-LIFECYCLE.md`
- `docs/process/ROADMAP.md`

### Review history

- `docs/reviews/`
- `docs/prompts/`

## 14. Handoff template for the next chat

A new conversation can start with:

> Read `docs/architecture/KAPILOTO-V4-MASTER-ROADMAP.md` first. Treat it as the navigation/status document, not as a replacement for code or runtime truth. Then read the primary docs for the active workstream and verify the current GitHub/Supabase/Vercel state before changing anything. Preserve frozen V1/V2/V3 semantics and V4 versioned-science rules. Do not guess identity or missing data. Current handoff: D-057 containment, V3 Sportmonks insert-only alignment and D-058 M2A are deployed. Match Ledger still has 0 observations and V1/V2 ingest remains disabled. Ligat Ha'al is identity-complete 14/14, Bundesliga 18/18, Premier League 20/20, La Liga 18/20 and Serie A 20/20, from frozen current-season Sportmonks roster captures. All 92 launch-universe clubs exist canonically. Round 264301 is settled (D-062 guarded correction). Pilot R4 for Bournemouth 52 and Sevilla 676 and the full 20/20 pilot R7 passed on 2026-11-03, and the natural-cycle window after R4 was clean by 2026-11-04. On 2026-11-04 seven deferred Class-B identities were mapped and attested, each in its own reviewed operation: Liverpool 8, Arsenal 19, Ipswich 116, Getafe 106, Rayo Vallecano 377, Real Sociedad 594 and Juventus 625 (`docs/operations/2026-11-04-v4-class-b-deferred-identities-execution.md`). The only remaining identity work is Elche 1099 and Athletic Club 13258. Both are deferred because they play in open Winner round 264401; do them only after that round is no longer active, each in its own reviewed operation. After them, rerun the full five-league readiness audit. After identity readiness, validate provider-family/history gates and close the remaining M2B gates before the first real Match Ledger ingest. A2-B is amended on the v3 draft PR (`feat/v4-provider-ingest-a2b-pilot-v3`, superseding PR #30). Its independent adversarial review of `76ab92a` passed the real-dispatch gate on 2026-11-04 (merge gate not evaluated). It still needs a merge and a real read-only dispatch. A2-B never approves a backfill and does not assess team identity. PR #43 (D-060) adds the attestation-aware consumer reads and binds lineup snapshots to their squad-state read; it is merged and applied to production, and it does not lift any other M2B gate.

## 15. Updating this file

Update this file when one of these changes:

- a major V4 foundation stage is completed;
- the active blocker changes;
- a new architecture decision changes the dependency graph;
- a pilot/backfill stage is promoted;
- V4 begins influencing production prediction logic;
- a major branch/PR described here is merged or abandoned.

Do **not** use this file to redefine a detailed contract. Put contract semantics in the appropriate architecture doc/Decision Log and link them here.