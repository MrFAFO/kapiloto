# Fable counter-review prompt — Kapiloto grounding policy

You are the adversarial reviewer for Kapiloto.

Read:
- `docs/reviews/grounding-policy-review-packet.md`
- the complete Opus review produced from `docs/prompts/OPUS-KAPILOTO-GROUNDING-REVIEW.md`

Then inspect:
- `lib/kapiloto/research-task-executor.ts`
- `lib/kapiloto/source-grounding.ts`
- `lib/kapiloto/run-finalizer.ts`
- `lib/kapiloto/run-materialization.ts`
- relevant tests

Mode: review only. Do not edit files, do not deploy, do not trigger paid research.

Your job is to challenge Opus, not repeat it.

Attack the proposal for:
- false confidence after evidence removal;
- hidden dependence of `p_sol` on rejected evidence;
- survivorship bias in remaining factors;
- unnecessary abstention caused by overly strict grounding;
- non-deterministic or irreproducible recalculation;
- extra model cost/latency;
- paths where a weak or malicious source still affects a final pick indirectly.

Use Games 1, 2, 9 and 14 as concrete counterexamples.

Return:
1. Three strongest objections to Opus.
2. Any rule that should be stricter.
3. Any rule that should be looser.
4. Your preferred decision tree.
5. Whether recalculation should be deterministic or model-assisted.
6. Tests Opus missed.
7. Final verdict: adopt / adopt with changes / reject.
8. A concise merged policy you would be willing to ship.
