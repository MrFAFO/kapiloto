# Opus 5.5 Review Reconciliation — Kapiloto Research Protocol 001

Source: external Opus 5.5 review of `KAPILOTO-RESEARCH-PROTOCOL.md`, October 2026.

## Verdict
Accepted direction: **APPROVE WITH CHANGES**.

The core product constraints remain:
- demand-driven research;
- no research cost before user demand;
- at most three shared logical research runs per Toto round;
- one atomically published 16-fixture snapshot;
- Sol as the research model family;
- stale data alone never starts AI;
- group-specific double budgets remain outside the shared model output.

## Accepted P0 findings

### Probability semantics and market/baseline prior
Accepted.

Raw Sol scores become explicit **pre-match 90-minute 1/X/2 probability estimates** on one common scale.

They are not used directly for picks/double ranking. Server code produces `p_final` from:
- `p_sol`;
- a structured prior, preferably a de-vigged 1X2 market snapshot;
- deterministic analysis reliability;
- a versioned deviation-cap/blend/calibration pipeline.

If no reliable market snapshot exists, use a versioned rating/league-base prior and reduce reliability.

The exact blend weights, caps and calibrator are configuration/evaluation outputs, not hard-coded product truths.

### Structured fixture card
Accepted.

The server, not web search, supplies:
- canonical fixture identity and Toto number;
- explicit 1/2 orientation;
- 90-minute settlement rule;
- kickoff, neutral venue, stage/leg/aggregate context;
- table/form/squad/coach structured snapshots when available;
- structured baseline prior/market snapshot.

Odds and odds movement are removed from qualitative web research. Movement is computed from server snapshots.

### Claim-level evidence grounding
Accepted with staged implementation.

Every score-moving evidence item must carry:
- evidence id;
- canonical URL candidate;
- short verbatim supporting quote;
- bounded claim;
- claim type;
- team subject;
- source event time when the source states one.

The server verifies:
- the URL was actually retrieved, not merely listed in search;
- canonical URL/domain;
- quote presence in retrieved content;
- server-extracted publication timestamp;
- source-registry tier;
- cutoff compliance.

Before public production, medium/large score-moving factors also require an entailment/support check. The verifier implementation may be a low-cost model or deterministic/NLI service and is not tied to Sol.

### Fixture orientation and settlement
Accepted.

Research operates on home/draw/away keyed to an echoed fixture identity. The server maps that to Toto 1/X/2 after validating:
- fixture key;
- home/listed-first team id;
- away/listed-second team id;
- settlement rule;
- neutral venue / cup-leg context.

Sol never decides whether a cup outcome means qualification vs 90-minute result.

### Research cutoff / leakage isolation
Accepted.

Each logical run freezes `research_cutoff_at`.

A fixture at or too close to kickoff is never newly researched. The initial safety window is configurable; design default is 15 minutes.

Evidence published after the cutoff is rejected for that run. Undated content cannot support time-sensitive claims.

Research workers must not have database access to actual match results, settlement results or post-match actual-lineup tables.

Evaluation accepts a prediction only when it demonstrably completed before the fixture's actual kickoff safety margin.

Historical model/web re-research is never used as performance evidence; archived outputs are evaluated instead.

### Prompt-injection / rendering defense
Accepted.

Add:
- server-side source registry;
- default Tier 4 for unknown domains;
- deny list for tipster/affiliate/look-alike abuse;
- plain-text output sanitation;
- no arbitrary model URLs in prose;
- suspicious-content flags;
- safe egress/fetch boundary for server-side evidence verification.

Sol has no product actions or application credentials.

## Accepted P1 findings

### Research dimensions
Keep the existing dimensions and add/clarify:
- underlying performance measures such as xG/shot quality where available;
- baseline strength supplied by server;
- explicit draw propensity;
- two-leg/dead-rubber/cup incentive handling;
- coach/club disruption;
- optional low-weight conditions such as extreme weather/artificial surface.

Independent model signals become sanity-check evidence, not an independently double-counted factor.

Each dimension returns one of:
- material_signal;
- no_material_signal;
- insufficient_data.

### Source tiers
Tiers are assigned by the server/source registry, not by Sol.

Authority is claim-type aware. Syndicated copies are not independent corroboration.

### Recency and conflicts
Accepted as versioned policy rather than permanent literal windows.

Start with claim-type windows based on Opus's proposal, but keep them configuration/versioned so shadow data can refine them.

A newer same/higher-quality statement may supersede an older one; true contemporaneous disagreement remains an unresolved conflict.

### Confidence becomes deterministic reliability
Accepted.

User-facing “confidence” is **analysis reliability**, not outcome probability.

Sol supplies bounded evidence/status fields and a logged self-confidence enum only.

The server computes reliability from versioned rules using coverage, source quality, unresolved conflicts, freshness, sparse coverage, prior divergence and later empirical stability.

Reliability influences how strongly `p_sol` may move `p_final` away from the prior.

### Structured watch items
Accepted.

Watch items become typed objects that freshness signals can match deterministically.

## Execution topology

Opus recommends fixture-level fan-out.

We accept fan-out as the **preferred first implementation/shadow arm**, but we do not permanently forbid a whole-round call before measuring cost/quality.

The run/attempt model must support both:
- `round_batch`;
- `fixture_fanout`.

For fan-out:
- one task per fixture;
- concurrency is bounded/configured;
- retries are fixture-scoped;
- publication remains one atomic round snapshot.

The reason the global double ranking no longer requires a single 16-fixture model call is that synthesis is deterministic on the server.

## Adapted findings

### Probability calibration
We accept the need for comparable probabilities, but do not claim initial `p_final` is already calibrated.

Schema and API call them probability estimates and persist `calibration_version`, nullable until a fitted calibrator exists.

Public UI should avoid presenting precise win percentages until shadow evaluation validates calibration.

### Blend weights and deviation caps
Do not lock Opus's proposed numeric weights/caps into v1.

They become versioned configuration selected from shadow evaluation.

### Evidence entailment
Required before public production for material factors, but it need not block the first plumbing/shadow implementation if quote verification and source/cutoff validation are already enforced.

### Partial fixture failure
Allow the architecture to represent `research_unavailable`.

Policy for publishing with 1–2 failed fixture tasks vs failing the whole logical run will be decided from shadow reliability/cost tests. No silent fallback is allowed: any baseline-only fixture is explicitly marked.

### Evaluation scale
Forward shadow evaluation is mandatory.

The exact “100 extra fixtures/week” and duration are budget-dependent targets, not a fixed product requirement. Acceptance gates must be written before using the data to approve launch.

## Deferred
- pari-mutuel expected-prize optimization;
- triple/column-budget optimization;
- multi-sample median production calls;
- near-tie UI;
- referee effects.

## Immediate implementation order
1. Redesign the fixture card and Sol output schema.
2. Add market/prior snapshots, source registry and claim-level evidence.
3. Add research cutoff/orientation fields and leakage rules.
4. Change stored scores to `p_market/p_sol/p_final` basis points plus reliability.
5. Make attempts task-aware so fan-out is possible.
6. Update the API contract.
7. Define the forward-shadow evaluation plan and acceptance gates.
8. Only then implement the worker/model calls.
