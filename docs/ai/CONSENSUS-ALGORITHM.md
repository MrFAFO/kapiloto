# Consensus Algorithm v1

## Goal
Create the most democratic ticket possible while allocating a fixed number of double picks efficiently.

## Voting
Each member has equal total voting power per fixture.

Single:
- 1 → (1.0, 0, 0)
- X → (0, 1.0, 0)
- 2 → (0, 0, 1.0)

Double:
- 1X → (0.5, 0.5, 0)
- X2 → (0, 0.5, 0.5)
- 12 → (0.5, 0, 0.5)

Normalize totals to `p1, px, p2`.

## Base pick
Choose the outcome with highest support.

## Double candidate
Use the two outcomes with highest support.

## Double allocation
For a round configured with K doubles:

Single estimated coverage:
`C1 = p_top`

Double estimated coverage:
`C2 = p_top + p_second`

Marginal multiplicative gain:
`G = log(C2 / C1)`

Allocate doubles to the K fixtures with the highest G.

Under a simple independence approximation, this prioritizes the doubles that most increase estimated whole-ticket survival probability.

## Tie breakers
1. Higher second-place support
2. Smaller first-vs-second gap
3. More eligible submissions
4. Lower game number

## Transparency
Store p1/px/p2, candidate double and gain score for every generated consensus.

## Versioning
Any material algorithm change increments `algorithm_version`. Historical consensus tickets are never silently recomputed.
