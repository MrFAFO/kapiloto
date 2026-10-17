# System Architecture

## Client
Responsive Next.js web app, optimized first for iPhone-width screens.

## Backend
Next.js server-side application logic plus Supabase for:
- Auth
- PostgreSQL
- Row Level Security
- Realtime

## Hosting
Vercel.

## External services

### TotoRoundProvider
Responsible for importing the weekly Toto/Winner 16 fixture list into an internal snapshot.

### FootballDataProvider
Responsible for normalized:
- fixture schedule;
- live score;
- minute/status;
- final result;
- optional lineups/injuries/suspensions.

The rest of the app never depends directly on a vendor response shape.

### Kapiloto
Server-only OpenAI integration. API keys never reach the browser.

## Data flow
TotoRoundProvider
→ rounds + round_games
→ user tickets
→ consensus

FootballDataProvider
→ normalized live game state
→ scoring engine

Kapiloto research
→ versioned source-backed analysis

Scoring
→ personal/group/Kapiloto statistics

## Background jobs
- import current round;
- sync fixture status;
- poll live fixtures at higher frequency only while live;
- settle completed fixtures;
- refresh affected statistics;
- refresh stale Kapiloto research according to policy.

## Reliability
- idempotent ingestion;
- provider IDs mapped to internal IDs;
- retries with backoff;
- stale-data indicator;
- manual admin correction with audit log.
