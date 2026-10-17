# Multi-Model Review Plan

## Goal
Use independent model/agent perspectives to find product gaps, architecture risks, security holes and UX edge cases before implementation becomes expensive.

No single model's feedback is accepted automatically. Findings are reconciled against the product requirements and recorded in the decision log.

## Review roles

### A. Product adversary
Questions:
- What user journeys are missing?
- What becomes annoying after 10+ weekly rounds?
- What happens when members do not submit?
- Can group consensus create misleading social pressure?
- What information is missing during live matches?
- Which actions are destructive or ambiguous?

Deliverable: docs/reviews/PRODUCT-REVIEW-001.md

### B. Mobile UX reviewer
Focus:
- one-handed use;
- 16-game information density;
- pick-control errors;
- double-pick discoverability;
- inline Kapiloto expansion;
- live/final states;
- accessibility and contrast;
- loading and stale AI states.

Deliverable: docs/reviews/MOBILE-UX-REVIEW-001.md

### C. Software architect
Focus:
- round lifecycle;
- immutable history;
- provider mapping;
- live polling;
- event/version model;
- consensus reproducibility;
- AI caching;
- cost scaling;
- failure recovery.

Deliverable: docs/reviews/ARCHITECTURE-REVIEW-001.md

### D. Security and data reviewer
Focus:
- Supabase RLS;
- group isolation;
- role escalation;
- join-code abuse;
- API secret exposure;
- rate limits;
- admin actions;
- auditability;
- prompt injection through web research or user-generated content.

Deliverable: docs/reviews/SECURITY-REVIEW-001.md

### E. AI research-system reviewer
Focus:
- source quality;
- freshness;
- contradictory reports;
- hallucinated injuries or lineups;
- structured-output validation;
- refresh policy;
- caching scope;
- citations;
- whole-ticket recommendation validation.

Deliverable: docs/reviews/KAPILOTO-AI-REVIEW-001.md

## External agent use
Repository review prompts should be self-contained so Claude Code, Cursor agents and other strong models can review the same source of truth without rediscovering the project.

Every reviewer must:
1. read AGENTS.md;
2. read PRD, MVP scope, data model and round lifecycle;
3. read the mobile UX spec and Kapiloto docs;
4. inspect implementation if present;
5. return findings ordered Critical / High / Medium / Low;
6. cite exact files or sections;
7. propose concrete changes;
8. distinguish confirmed defects from suggestions.

## Reconciliation
Create docs/reviews/REVIEW-RECONCILIATION-001.md.

Classify every finding as Accepted, Rejected, Deferred or Needs experiment.

Accepted architecture/product changes must update their source docs and DECISION-LOG.md.

## Timing
Run the full review set:
- now, before database schema is finalized;
- after Auth/Groups/RLS;
- after live-data integration;
- before public beta.

## Completed focused external reviews
- **Kapiloto research concurrency / cost architecture — Opus 5.5**: completed and reconciled in `docs/reviews/OPUS-KAPILOTO-RESEARCH-REVIEW-001.md`.
- Accepted findings were propagated into the data model, Schema v1 draft, RLS boundary, API contract, UX behavior and decision log.
- The review is advisory evidence, not an authority; final decisions remain in `DECISION-LOG.md`.
- **Kapiloto research protocol / grounding — Opus 5.5**: completed and reconciled in `docs/reviews/OPUS-KAPILOTO-RESEARCH-PROTOCOL-REVIEW-001.md`.
- Accepted findings changed the probability pipeline, fixture-card boundary, evidence grounding, cutoff/evaluation isolation, confidence semantics and preferred execution topology.
