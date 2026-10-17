# Kapiloto

Kapiloto is a mobile-first group Toto/Winner 16 platform.

## Core loop
1. Users register and join a private group.
2. Each member submits the weekly 1/X/2 ticket under the group's double-pick limit.
3. The group admin generates a democratic consensus ticket.
4. Match status and live scores update personal and group tickets.
5. Historical rounds remain reproducible and feed long-term statistics.
6. Kapiloto provides source-backed AI analysis for every fixture.

## Planned stack
- Next.js + TypeScript
- Tailwind CSS
- Supabase Auth + PostgreSQL + Row Level Security + Realtime
- Vercel
- Football-data provider behind an adapter
- OpenAI API for Kapiloto research

## Product principles
- Mobile first
- Historical rounds are immutable snapshots after settlement
- Consensus is transparent and deterministic
- AI advice always includes freshness and sources
- Sporting result and Toto settlement result are stored separately

See `/docs` for product, architecture, AI, process and decision records.
