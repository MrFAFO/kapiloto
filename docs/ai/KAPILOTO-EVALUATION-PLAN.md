# Kapiloto Shadow Evaluation Plan v1

Status: pre-implementation evaluation contract.

## Purpose

Kapiloto must earn trust through forward pre-match evidence, not retrospective anecdotes.

The primary question is not “did Kapiloto guess several matches correctly?” It is whether the probability/research pipeline is:
- grounded;
- stable;
- at least competitive with a strong baseline prior;
- useful for double allocation;
- operationally affordable.

## Non-negotiable leakage rules

1. Forward shadow evaluation is primary.
2. Each fixture has a frozen `research_cutoff_at`.
3. Evaluation includes a fixture only when the published research demonstrably completed before actual kickoff minus the configured safety margin.
4. Research workers cannot read actual results, pool settlement or post-match actual-lineup tables.
5. Evidence published after the cutoff is rejected.
6. Live blogs/match reports are rejected as pre-match evidence.
7. Finished fixtures are never re-researched with current web search to score historical model quality.
8. Protocol/calibration changes are replayed against archived original outputs/evidence, not by asking the model the historical match again.

## Shadow arms

Use identical fixture cards and cutoffs.

### A — round_batch
One Sol task receives the complete round.

Purpose:
- cost/latency baseline;
- test fixture-order/position bias;
- compare cross-fixture contamination.

Shuffle fixture order across repeated shadow samples where possible.

### B — fixture_fanout
One Sol task per eligible fixture, bounded concurrency.

This is the preferred implementation candidate.

### B-blind — fixture_fanout without the market prior visible to Sol
The server still retains the prior for evaluation/blending, but the model does not see it.

Purpose:
- measure how much independent predictive signal Sol adds;
- detect whether normal B is merely repeating the market.

### C — multi-sample fixture fan-out
2–3 independent samples per fixture and deterministic aggregation.

Use only on a limited subset/rounds to measure model variance vs cost.

Do not ship multi-sampling unless stability gain justifies the additional spend.

## Core metrics

### Probability quality
Evaluate raw `p_sol`, final `p_final` and prior baseline:
- Ranked Probability Score (RPS);
- log loss;
- Brier-style per-outcome diagnostics;
- calibration/reliability diagrams;
- expected calibration error;
- draw bias specifically.

### Double-ranking quality
For multiple K values, e.g. 3–7:
- realized covered probability;
- single/double hit rates;
- regret vs prior-only double ranking;
- Kendall tau of rankings between repeated runs;
- Jaccard overlap of top-K double sets.

### Research grounding
- retrieved-URL validation rate;
- quote-verification rate;
- entailment-supported share for medium/large factors;
- wrong-team claim rate;
- stale/post-cutoff rejection rate;
- fabricated/unobserved URL publication count;
- source-tier distribution and source diversity;
- duplicate/syndication clustering rate.

### Team-news quality
Compare predicted availability to actual pre-match lineups:
- precision/recall for “out”;
- precision/recall for “doubtful”;
- false confirmed-absence rate.

### Stability
- top-pick flip rate for identical fixture cards;
- probability dispersion;
- rank correlation;
- sensitivity to fixture order in round_batch.

### Security
Red-team:
- hidden prompt instructions;
- tipster/affiliate pages;
- look-alike domains;
- HTML/Markdown injection in claims;
- pages containing secrets/tool instructions;
- post-match/live pages.

Measure whether any case changes `p_final` outside allowed deterministic guards or reaches user-visible output unsanitized.

### Operations
- cost per logical run;
- cost per fixture task;
- web-search calls;
- p50/p95 latency;
- task retry rate;
- logical-run failure rate;
- schema-valid share before/after bounded repair.

## Baseline and calibration

The preferred baseline is a de-vigged 90-minute 1X2 market prior captured at the same cutoff.

If reliable market data is unavailable for a fixture, use the configured rating/league prior and mark that fixture separately in evaluation.

Never compare a cutoff-time Kapiloto prediction only against closing odds; keep:
- prior at research cutoff;
- optional closing market benchmark.

## Reliability validation

User-facing confidence is the deterministic analysis reliability band.

A valid reliability model should demonstrate that higher-reliability analyses have better probabilistic performance than lower-reliability analyses.

Reliability-formula weights and thresholds are fitted/versioned from shadow data. Sol self-confidence is logged as a feature candidate only.

## Provisional launch gates

These are starting targets and must be frozen before inspecting launch-decision results.

- zero published home/away orientation swaps;
- zero fabricated/unobserved URLs in published evidence;
- near-zero unsupported material evidence after verification;
- no post-cutoff evidence in published pre-match analyses;
- schema-valid outputs after bounded repair >= 99%;
- double ranking is not materially worse than prior-only ranking;
- p_final is not materially worse than the prior on RPS/log loss;
- draw calibration shows no material systematic underprediction;
- high reliability band outperforms low reliability band;
- injection red-team produces zero deterministic-guard escapes.

Exact statistical margins/confidence intervals are fixed once the initial shadow sample-size/cost budget is known, before the held-out launch set is scored.

## Dataset strategy

### Forward Toto set
Run on each future Winner 16 round once the data plumbing exists.

### Supplemental same-league fixtures
If budget allows, add fixtures from the same competitions to reach useful statistical power faster.

Keep them separate from product round-budget accounting; they are evaluation jobs, not user-triggered Kapiloto runs.

### Gold sets
Maintain:
- citation/entailment gold set;
- team-news/availability gold set;
- prompt-injection red-team set;
- orientation/neutral-venue/cup-leg edge cases.

## Topology decision

Prefer fixture_fanout unless round_batch is non-inferior on:
- probability quality;
- grounding;
- stability;
- contamination/failure rate;

and provides a meaningful cost/latency advantage.

The precise cost threshold is set before the topology experiment is judged.

## Calibration rollout

1. Start with explicit `calibration_version = null`.
2. Collect forward shadow p_sol/prior/outcomes.
3. Fit candidate calibration methods on training folds.
4. Evaluate on held-out forward data.
5. Promote a calibrator only when it improves proper scoring/calibration metrics.
6. Historical analyses retain the version that produced them.

## Launch principle

Do not claim “AI probability accuracy” or expose precise user-facing win percentages merely because the model emits probabilities.

The probabilities become user-display candidates only after forward calibration evidence supports that representation.
