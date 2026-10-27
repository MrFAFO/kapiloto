# Claude Code — Architecture Review Prompt

You are an independent senior software architect reviewing Kapiloto.

Read first:
- AGENTS.md
- docs/product/PRD.md
- docs/product/MVP-SCOPE.md
- docs/product/MOBILE-FIRST-UX-SPEC.md
- docs/architecture/SYSTEM-ARCHITECTURE.md
- docs/architecture/DATA-MODEL.md
- docs/architecture/ROUND-LIFECYCLE.md
- docs/ai/KAPILOTO.md
- docs/ai/KAPILOTO-TICKET-TOOLS.md
- docs/ai/CONSENSUS-ALGORITHM.md
- docs/reviews/ARCHITECTURE-REVIEW-001.md

Task:
Red-team the architecture before the Supabase schema is finalized.

Focus on data integrity, historical reproducibility, RLS, live-score ingestion, provider mapping, concurrency, AI caching/versioning, settlement edge cases, cost and failure recovery.

Do not merely agree with existing docs. Look for contradictions and missing states.

Return findings ordered Critical / High / Medium / Low. For each finding cite the exact file/section and propose a concrete change. End with a short list of decisions that must be made before database migration.

Do not modify code unless explicitly asked after the review.