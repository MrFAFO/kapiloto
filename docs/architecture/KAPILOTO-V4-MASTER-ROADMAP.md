# Kapiloto V4 — Master Roadmap and Handoff

Last verified operational snapshot: 2026-10-30

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

Branch:
`feat/v4-provider-ingest-a2b-pilot`

Draft PR:
`#19 — V4 A2-B: verify Sportmonks entitlement and real payload semantics`

Snapshot head:
`90d11385bcdc1e0544bfcc75da12c4d8b1d332c2`

Base `main` at the time:
`e0826c780dca6e388ef65fa595046716d0ce3adb`

### What the A2-B branch adds

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

### Operational competition promotion already performed

After the entitlement/identity pilot, exactly these five Sportmonks competition mappings were promoted in production from `confirmed` to `manual_override` in one guarded transaction:

- 8 Premier League
- 82 Bundesliga
- 372 Ligat ha'Al
- 384 Serie A
- 564 La Liga

Post-checks found no mapping conflicts/provider-ref conflicts.

This was an operator data action, not a migration. A future documentation/reconciliation change may record the operational evidence without pretending the DB update was schema history.

## 8. CURRENT BLOCKER — Stage 1 identity attestations

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

The 20 teams from the 10-fixture pilot remain the first reconciliation scope
after Stage 1 lands.

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

### Gate 2 — align V3 code with the database guard

Patch `SupabaseSportmonksSyncStore.saveResolvedFixture` so weak V3 identity
writes are insert-only rather than repeated upserts.

Expected properties:

- existing Sportmonks mapping rows are never updated by V3;
- new missing rows may still bootstrap for V3/shadow use;
- V3 Sportmonks confidence remains weak evidence and must not self-promote to 1;
- structured snapshots continue working.

The DB trigger remains the safety boundary even after this code patch.

### Gate 3 — Stage 1 V4 identity attestations

Implement the reviewed attestation architecture before any provider ingest is
re-enabled.

Required properties:

- immutable/current attestation state plus append-only events;
- service-role-only access, RLS, no SECURITY DEFINER;
- explicit attest/revoke RPCs;
- mapping + attestation agreement for team/competition trust;
- injectivity at the trusted boundary;
- reconciliation/conflict reporting;
- fixture trust derived from attested identities and fixture facts;
- full lock/security/atomicity tests;
- ingest EXECUTE re-granted only at the end of the migration.

### Gate 4 — amend A2-B pilot tooling

Apply the independent-review findings to PR #19:

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

### Gate 5 — reconcile pilot teams through the Stage 1 mechanism

Classify each missing provider team as one of:

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

Re-attest the five mappings that A2-A previously treated as trusted; do not
grandfather them merely because they are already confidence 1.

### Gate 6 — tiny real Match Ledger ingest

Only after Stage 1 and team reconciliation, re-enable ingest and run the
smallest useful real pilot.

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

Preserve:

- frozen V1/V2/V3 replay;
- prediction provenance;
- rollback/champion-challenger comparison;
- explicit feature/model/calibration versions.

## 11. What is explicitly NOT done yet

As of the snapshot date:

- no broad Sportmonks historical backfill;
- no real A2-B Match Ledger pilot observation has been persisted yet; historical provider ingest is intentionally paused by D-057 until Stage 1 attestations land;
- the 15 missing pilot-team mappings are not resolved;
- PR #19 is not merged;
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

> Read `docs/architecture/KAPILOTO-V4-MASTER-ROADMAP.md` first. Treat it as the navigation/status document, not as a replacement for code or runtime truth. Then read the primary docs for the active workstream and verify the current GitHub/Supabase/Vercel state before changing anything. Preserve frozen V1/V2/V3 semantics and V4 versioned-science rules. Do not guess identity or missing data. Current handoff in the 2026-10-30 snapshot is D-057 Stage 0 containment applied in production; next is V3 insert-only alignment plus Stage 1 V4 identity attestations, then A2-B reconciliation before the first real Match Ledger ingest.

## 15. Updating this file

Update this file when one of these changes:

- a major V4 foundation stage is completed;
- the active blocker changes;
- a new architecture decision changes the dependency graph;
- a pilot/backfill stage is promoted;
- V4 begins influencing production prediction logic;
- a major branch/PR described here is merged or abandoned.

Do **not** use this file to redefine a detailed contract. Put contract semantics in the appropriate architecture doc/Decision Log and link them here.