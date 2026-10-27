# Kapiloto grounding / recommendation policy review packet

## Purpose

Review the current Kapiloto research-to-publication policy after the production Winner 16 test run for round 264201. The core question is how to preserve betting quality without discarding otherwise useful fixture analyses because one secondary claim fails grounding.

Do **not** propose a new research run. Work only from the already collected/grounded data and the current pipeline behavior.

## Production facts

- Winner 16 round: 264201
- Research run: `b5677df6-79fd-4f9c-a26d-7f994afcea1c`
- 16/16 fixture research tasks succeeded.
- Finalization ultimately succeeded and published 16 analyses.
- 82 evidence rows were materialized.
- Only 2 fixtures remained `analyzed`.
- 14 fixtures became `insufficient_data`.
- Weekly budget cap for the current validation round is temporarily $45. No new paid research should be proposed merely to work around policy problems.

## Current failure pattern

The current sanitizer removes unsupported availability/factor/conflict items. However, when an analyzed fixture ends up with zero surviving factors it downgrades the entire fixture to `insufficient_data`.

There is an additional correctness concern: if a factor used by the model to derive `p_sol` is removed, keeping the original `p_sol` may preserve probability mass influenced by evidence that is no longer accepted.

### Representative examples

#### Game 14: Napoli vs Roma
- 10 accepted evidence items
- 2 rejected evidence items
- Downgraded to `insufficient_data`
- Policy failures were four availability claims:
  - Mile Svilar
  - Manu Koné
  - Paulo Dybala
  - Lorenzo Pellegrini
- Accepted evidence still covered form, home/away, availability, and schedule/fatigue.

This looks like a likely case where unsupported secondary availability items should be removed without erasing the entire betting recommendation.

#### Game 1: Maccabi Haifa vs Hapoel Be'er Sheva
- 6 accepted / 5 rejected
- Failures:
  - unsupported Ali Mohamed availability
  - unsupported home_away_draw factor
- Accepted evidence still included form, tactical, availability and schedule/fatigue.

#### Game 9: Sunderland vs Leeds
- 6 accepted / 4 rejected
- Only policy failure: load_schedule factor lacked grounded support.
- Accepted evidence still included 3 form items and 3 availability items.

#### Game 2: Hapoel Jerusalem vs Hapoel Tel Aviv
This is the key counterexample to simply "drop bad evidence and keep the pick".

Before finalization:
- model output: analyzed
- `p_sol`: home 29%, draw 29%, away 42%
- three model factors:
  - baseline_form: medium, favors away
  - home_away_draw: small, favors home
  - availability: small, neutral
- 6 accepted grounded evidence items survived initial grounding.

Finalization entailment rejected evidence `e4`:
- source: Sport5 play-by-play
- claim: Hapoel Tel Aviv's Oct 17 win over Tiberias was their third consecutive league win
- the baseline_form factor referenced `e1,e2,e3,e4`, but only e4 was in the accepted grounding set at this stage.

The finalizer therefore downgraded the whole fixture to `insufficient_data`.

Important implication: if e4 is removed, retaining the model's original 42% away probability is not obviously valid, because the probability was derived partly from the now-rejected form signal.

## Current code behavior to review

Relevant files:
- `lib/kapiloto/research-task-executor.ts`
- `lib/kapiloto/source-grounding.ts`
- `lib/kapiloto/run-finalizer.ts`
- `lib/kapiloto/run-materialization.ts`

Current sanitizer logic:
1. Remove availability items unless all referenced evidence IDs are accepted.
2. Remove factors unless all referenced evidence IDs are accepted.
3. Medium/large factors also require one strong source or two independent sources.
4. Remove conflicts unless both sides have accepted evidence.
5. Remove unsupported market deviation.
6. If output was analyzed and zero factors survive, downgrade the entire fixture to `insufficient_data`.
7. Otherwise keep the original `p_sol` even if one or more factors were removed.

That final rule is the main area of concern.

## Product objective

Kapiloto should not:
- manufacture confidence from unsupported evidence;
- preserve probabilities that materially depend on evidence we later reject;
- discard a useful fixture recommendation just because one secondary claim failed;
- force another full web research run to repair a policy-layer issue;
- hide uncertainty from the user.

It should:
- maximize useful coverage while staying evidence-grounded;
- degrade gracefully;
- clearly reduce reliability when information is removed;
- make `insufficient_data` a real "not enough trustworthy signal" outcome rather than a catch-all for any imperfect claim.

## Questions for the reviewer

1. Should unsupported **secondary** items (availability, watch item, minor conflict) be removed locally without recalculating probabilities?
2. Exactly which removed items should force a probability recalculation?
3. Is "factor removed" sufficient to require recalculation, or only factors that were directional/material?
4. Should a recalculation be deterministic from prior + surviving factors, or should a small model call recompute `p_sol` from only the accepted evidence/factors?
5. If a model recalculation is used, how can we prevent it from inventing new facts or silently reintroducing rejected evidence?
6. What minimum surviving signal should be required for a published pick?
7. How should reliability/confidence be penalized when evidence or factors are dropped?
8. Under what conditions should a fixture still be `insufficient_data`?
9. Should the finalizer downgrade a **single item**, a **factor**, or the **whole fixture** when entailment rejects one claim?
10. How should the policy handle a case like Game 2, where the rejected claim appears central to the 42% away lean?
11. How should the policy handle a case like Napoli-Roma, where 10 accepted evidence items remain but several availability reports fail?
12. Can the policy be made deterministic and testable enough that the same accepted evidence always yields the same publish/no-publish decision?

## Required output format for Opus

Return:
1. Diagnosis of the current policy.
2. Recommended decision tree.
3. Exact distinction between:
   - drop item only
   - recompute probabilities
   - insufficient_data
4. Recommended reliability penalty rules.
5. Whether recalculation should use an LLM or deterministic derivation.
6. Failure modes / abuse cases.
7. Concrete changes you would make in the four files above.
8. Tests that must exist before production.
9. A short verdict on Games 1, 2, 9 and 14 under your proposed policy.

Do not optimize for coverage at the expense of correctness.

## Red-team prompt for Fable

Review the same packet **after reading the Opus recommendation**. Your job is not to agree with it.

Attack the proposed policy on:
- false confidence,
- hidden dependence of `p_sol` on rejected evidence,
- survivorship bias in remaining factors,
- over-penalizing incomplete football data,
- incentives to publish a pick when abstention is better,
- cost and latency of recalculation,
- determinism/reproducibility,
- whether a malicious or low-quality source can still influence the final probability indirectly.

Return:
1. The three strongest objections to the Opus proposal.
2. Concrete counterexamples using Games 1, 2, 9 and 14.
3. Any rule you would make stricter.
4. Any rule you would make looser.
5. Your own recommended decision tree.
6. Final recommendation: adopt Opus / adopt with changes / reject.
