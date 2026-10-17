# Delivery Roadmap

## Phase 0 — Product and architecture
- PRD
- MVP scope
- data model
- round lifecycle
- consensus algorithm
- Kapiloto protocol
- football-data provider spike

## Phase 1 — UX prototype
Figma screens:
1. Login/signup
2. Current Round / ticket
3. Fixture detail + Kapiloto
4. Group tickets
5. Consensus
6. Live round
7. Statistics
8. Admin/members
9. History

## Phase 2 — Foundation
- Next.js + TypeScript
- Supabase project
- Auth
- CI
- environments
- base component system

## Phase 3 — Groups
- create/join
- approvals
- roles
- RLS tests

## Phase 4 — Rounds and tickets
- ingestion
- fixture list
- drafts/submission
- max doubles
- lock behavior
- history

## Phase 5 — Consensus
- deterministic algorithm
- versioning
- vote breakdown
- tests

## Phase 6 — Live data/scoring
- provider adapter
- sync
- settlement
- scoring
- exceptional states

## Phase 7 — Kapiloto
- OpenAI integration
- web research
- structured result
- caching/versioning
- source rendering
- whole-ticket review

## Phase 8 — Statistics
- weekly
- all-time
- consensus comparisons
- Kapiloto comparisons

## Phase 9 — Hardening
- security/RLS review
- failure modes
- monitoring
- mobile QA
- load/cost checks

## Coding-agent discipline
Use Cursor for narrow implementation slices with explicit acceptance criteria.
Use Claude Code selectively for broad reviews/refactors/tests.
Do not ask either agent to build the entire app in one prompt.
