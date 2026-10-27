# Opus review prompt — Kapiloto grounding policy

You are the independent architecture/reliability reviewer for Kapiloto.

Read first:
- `docs/reviews/grounding-policy-review-packet.md`

Then inspect the current implementation in:
- `lib/kapiloto/research-task-executor.ts`
- `lib/kapiloto/source-grounding.ts`
- `lib/kapiloto/run-finalizer.ts`
- `lib/kapiloto/run-materialization.ts`
- relevant tests for those modules

Mode: review only. Do not edit files, do not run deployments, do not touch production data, and do not trigger any paid research.

Goal: recommend a production-safe policy that increases useful Toto 16 coverage without preserving probabilities influenced by rejected evidence.

You must explicitly distinguish these outcomes:
1. Drop unsupported item only.
2. Keep the recommendation but reduce reliability.
3. Recompute probabilities from surviving grounded evidence/factors.
4. Publish `insufficient_data`.

Pay special attention to Games 1, 2, 9 and 14 in the packet. Game 2 is the critical counterexample: one rejected form claim may have influenced the model's 42% away probability. A policy that simply removes the claim while retaining `p_sol` is not acceptable unless you can justify why.

Return:
1. Diagnosis of the current policy.
2. A deterministic decision tree.
3. Exact rules for item-level removal vs factor-level removal vs whole-fixture downgrade.
4. Which removals require recalculation.
5. Whether recalculation should be deterministic or model-assisted, and why.
6. Minimum surviving signal required to publish a pick.
7. Reliability/confidence penalty rules.
8. How to guarantee rejected evidence cannot indirectly influence the final probabilities.
9. Concrete implementation changes by file.
10. Required tests before production.
11. Verdict for Games 1, 2, 9 and 14.
12. The strongest argument against your own proposal.

Do not optimize for maximum coverage. Optimize for trustworthy, explainable recommendations with graceful degradation.
