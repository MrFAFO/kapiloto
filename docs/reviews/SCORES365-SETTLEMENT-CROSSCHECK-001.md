# 365Scores settlement cross-check — 2026-10-20

## Purpose

365Scores is used only as a second field-result source for Winner 16 settlement
hardening. It is not treated as the official Toto pool-settlement authority.

## Live access validation

A GitHub-hosted server-to-server probe of
`https://webws.365scores.com/web/games/` returned HTTP 200 and validated the
expected football game schema.

For 2026-10-19 it returned 215 football games, all 215 marked final with scored
results.

## Round 264201 fixture identity coverage

Using the same public endpoint for 2026-10-24 through 2026-10-26:

- 11/16 fixtures matched the canonical Telesport names exactly after
  deterministic normalization.
- The remaining five were confirmed as simple provider aliases, with matching
  dates, opponents, competitions and kickoffs:
  - game 3: הפועל קרית שמונה -> עירוני קרית שמונה
  - game 4: מכבי פתח תקווה -> מכבי פתח תקוה
  - game 7: האל -> האל סיטי
  - game 8: ניוקאסל -> ניוקאסל יונייטד
  - game 9: לידס -> לידס יונייטד
- These aliases are stored explicitly with source `365scores`. No fuzzy
  matching is used for settlement.

## Fail-closed settlement rule

For a Telesport row marked finished with a 1/X/2 outcome:

1. Exact 365Scores match + same final score/outcome -> automatic settlement.
2. Exact 365Scores match + conflicting final score/outcome -> under review.
3. No exact 365Scores corroboration yet -> under review.
4. Exceptional Telesport status remains under review.

An under-review game may later transition to settled when corroboration arrives.
Settled and void states remain immutable in the database RPC.
