# Round Lifecycle

Main path:

`UPCOMING → OPEN → LOCKED → LIVE → FINISHED → SETTLED`

Exceptional states:
`POSTPONED`, `CANCELLED`, `UNDER_REVIEW`.

## OPEN
Members may create, edit and submit. Kapiloto advice is available.

## LOCKED
Member tickets are frozen. The final consensus must use only submissions that existed at lock time.

## LIVE
At least one fixture is in play. Display provisional hit/miss.

## FINISHED
Sporting fixtures ended, but Toto settlement may still be pending.

## SETTLED
The outcome used to grade the Toto/Winner ticket is final. Statistics freeze.

## Two-result rule
Always store:
1. `field_outcome` — what happened on the pitch at full time.
2. `pool_settlement_outcome` — what the Toto/Winner pool grades.

This handles technical wins, voids and disciplinary decisions without corrupting history.

## Historical immutability
After settlement:
- no destructive edits;
- corrections create audit entries;
- derived statistics are recomputed;
- original imported values remain recoverable.
