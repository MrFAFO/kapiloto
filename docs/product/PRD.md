# Product Requirements Document

## Goal
Replace screenshots and chat-based Toto coordination with one persistent group workspace for weekly submissions, democratic consensus, live tracking, history, statistics and AI-assisted fixture research.

## Authentication

Kapiloto opens on a simple authentication screen before the product home screen.

### Login
- username + password;
- optional `Remember me`, checked by default;
- when remembered, the session should survive browser/app restarts under normal conditions until explicit sign-out or a security event terminates the session;
- generic login errors to reduce account enumeration.

### Registration
Required:
- unique username;
- password;
- at least one recovery contact: email or mobile phone.

The recovery email/phone is not the public login name.

### Password recovery
- email: send a reset link/code;
- phone: send an OTP through the configured SMS provider, then allow setting a new password;
- never send the existing password because it is not stored in recoverable form.

### Username login implementation
Supabase Auth natively signs in with email or phone + password, not username + password. Kapiloto therefore uses a server-side username resolver in a private/non-exposed schema:
username -> auth user -> verified email/phone identifier -> Supabase password sign-in.

This resolver must be rate-limited and must return generic errors.

## AI identities
- **Kapiloto**: fixture analyst. Handles per-match research, recommendation quality, rechecks and whether that specific fixture is a strong candidate for a double in the context of the whole round.
- **Diego**: full-ticket builder. Uses the latest Kapiloto analysis for all 16 fixtures, selects every pick, allocates doubles under the group limit, and fills the normal ticket.

These are product personas. Backend implementation may share infrastructure/models while preserving distinct user-facing responsibilities.

## Brand characters
Kapiloto and Diego will later receive original 3D mascot/character identities in the Dark Stadium visual language. They should appear prominently in authentication/onboarding and may appear selectively elsewhere without obstructing core ticket interactions.

## Roles
### Member
Registers, requests group membership, submits a weekly ticket, views submitted group tickets, consensus, live results and statistics.

### Admin
All member capabilities plus:
- approve/reject join requests;
- configure round settings;
- define maximum doubles;
- generate the group consensus;
- manage group settings.

### Owner
The group creator. Owner privileges cannot be removed without explicit ownership transfer.

## Weekly flow
1. Current round appears automatically.
2. User sees lock time and allowed doubles.
3. **Default flow:** user fills the normal 16-match ticket manually.
4. For any specific fixture, the user may expand Kapiloto inline for research and a recommendation.
5. **Optional Diego flow:** Diego can fill the same normal ticket end-to-end, including which fixtures receive doubles.
6. Whether filled manually or by Diego, the result is the same editable draft ticket.
7. Validation prevents incomplete tickets or excess doubles.
8. User submits and may edit until lock.
9. Group submissions become visible according to group policy.
10. Admin generates consensus.
11. Live fixtures show score/minute and provisional hit/miss.
12. Final Toto settlement grades every ticket.
13. Round statistics are frozen and added to history.

## Round history
Users can navigate backward from the current round to every round since the group was created.

Historical rounds show:
- fixture list;
- personal submissions;
- consensus version;
- sporting results;
- Toto settlement outcomes;
- Kapiloto analysis versions;
- round statistics.

## Ticket rules
Supported picks:
- 1
- X
- 2
- 1X
- X2
- 12

A double consumes one double slot. The group admin defines `max_doubles` per round.

## Live states
Fixtures support:
- Upcoming
- Live
- Half-time
- Full-time
- Postponed
- Cancelled
- Under review

Pick evaluation supports:
- Pending
- Currently Hit
- Currently Miss
- Hit
- Miss
- Void / Not settled
- Under Review

## Statistics
Member:
- rounds played;
- hits and hit rate;
- average hits per round;
- best round;
- singles accuracy;
- double coverage accuracy;
- streaks;
- weeks beating consensus.

Group:
- weekly winner;
- all-time leaderboard;
- consensus accuracy;
- consensus vs group average;
- consensus vs best individual;
- counts of 16/16, 15/16, 14/16, etc.

Kapiloto:
- weekly and all-time score;
- singles accuracy;
- recommended-double coverage;
- Kapiloto vs consensus;
- Kapiloto vs best member.

## Kapiloto
Each fixture has "Consult Kapiloto".

Kapiloto expands inline below that fixture and does not navigate away from the ticket.

The analysis is source-backed and includes:
- primary outcome recommendation;
- whether a double is justified for this group's configured double budget;
- the exact recommended pick (1/X/2/1X/X2/12);
- confidence;
- professional 7–8 line analysis;
- key factors and main risk;
- round-relative double priority, e.g. "3 of 7", because double value depends on the other fixtures;
- timestamp and sources;
- recheck.

Kapiloto does not fill the user's entire personal ticket.

Because research is shared across groups, shared research stores a global double-priority rank derived from the 1/X/2 scores. Whether a double is actually recommended is computed for the viewing group's configured max-doubles rule rather than stored as a universal model output.

### Research execution
- Research is lazy/on-demand: a new round costs nothing in AI research until a user asks for Kapiloto, recheck, or Diego assistance.
- When research is required, one shared logical run researches all 16 fixtures and stores an immutable snapshot for reuse by every user.
- The first normal Consult may create run 1. Runs 2 and 3 require an explicit Recheck or explicit Diego refresh intent.
- A round may consume at most three research slots. Technical retries remain attempts inside the same logical run.
- Staleness can make another run eligible but never triggers it automatically; another explicit user request is required.
- Concurrent requests join one active run rather than launching duplicate Sol jobs.
- One round-level publication pointer selects the current completed 16-fixture snapshot atomically.
- Sol is the approved research model family; the exact API model ID is server-configured.

## Diego
Diego is the optional autonomous full-ticket builder.

When invoked:
1. ensure the current Kapiloto research for all 16 fixtures is sufficiently fresh;
2. use the structured outcome scores from those analyses;
3. deterministically allocate up to the group double limit across the full round;
4. fill the **same normal user draft ticket** with all 16 selections;
5. keep each fixture's Kapiloto analysis available inline underneath it.

There is no separate "Diego ticket" data model in the user experience. Diego produces a normal editable draft that the user reviews and submits.

## Out of scope for MVP
- placing bets with Toto/Winner;
- deposits/withdrawals;
- pooled money;
- paid competitions;
- native iOS/Android apps.
