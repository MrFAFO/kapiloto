# Kapiloto

Kapiloto is the product's AI football analyst, not a generic chatbot.

Every analysis is tied to a fixture and a research timestamp.

## User-facing output
- Recommended single: 1 / X / 2
- Suggested double when justified
- Confidence: low / medium / medium-high / high
- Concise rationale
- 3–6 key factors
- Main counter-case/risk
- Last researched timestamp
- Sources

Target reading time: under one minute.

## Actions
- Consult Kapiloto
- Refresh analysis, subject to policy
- Apply recommendation to draft
- Compare Kapiloto with consensus
- Admin: review whole consensus ticket

## Guardrails
Kapiloto must:
- distinguish facts from judgment;
- surface contradictory evidence;
- never invent injuries or lineups;
- prefer current authoritative sources;
- display freshness;
- never silently edit a user's ticket;
- never silently alter group consensus.

## Cost/caching
Research is cached per fixture and versioned. A group of users should normally share the same fresh analysis rather than trigger duplicate research.

Configuration uses model keys rather than hard-coded model names:
- KAPILOTO_RESEARCH_MODEL
- KAPILOTO_FAST_MODEL
