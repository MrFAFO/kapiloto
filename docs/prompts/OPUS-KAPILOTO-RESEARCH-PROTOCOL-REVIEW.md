# Opus 5.5 Review — Kapiloto Research Protocol v1

Act as a senior AI-research systems architect with football-data experience.

Review this design direction:
- one logical run targets a frozen Winner 16 fixture set;
- max 3 shared logical runs;
- Sol + web search + strict Structured Output;
- shared published snapshot for all users;
- groups may use different max_doubles;
- Sol outputs evidence + normalized 1/X/2 relative scores;
- server derives primary pick, suggested double and global double priority deterministically;
- group-specific double recommendation is computed later;
- source URLs must match URLs actually observed from the web-search tool;
- freshness is deterministic and never auto-triggers AI.

Review specifically:
1. Is the research-factor list complete without becoming noisy?
2. Is the source hierarchy sensible?
3. Are recency/conflict rules strong enough?
4. Is it correct for Sol to output normalized relative scores rather than picks/double decisions?
5. Is double_gain = log((top+second)/top) sensible for global double ranking?
6. Should analysis confidence be model-generated, deterministic or hybrid?
7. Is validating emitted URLs against actual tool sources enough to prevent hallucinated citations?
8. What prompt-injection defenses are missing?
9. Should the logical run begin as one 16-fixture Sol call or fan out internally? What experiment should decide?
10. What schema fields should change before implementation?
11. How do we prevent post-kickoff/live information leaking into historical pre-match evaluation?
12. What offline evaluation metrics/dataset should exist before trusting scores?

Required output:
A. Verdict.
B. P0/P1/P2 findings.
C. Specific schema changes.
D. Execution-topology experiment.
E. Confidence design.
F. Evaluation plan.
G. Immediate changes.

Preserve the product constraints unless a concrete technical failure requires otherwise.
