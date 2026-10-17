# Product Requirements Document

## Goal
Replace screenshots and chat-based Toto coordination with one persistent group workspace for weekly submissions, democratic consensus, live tracking, history, statistics and AI-assisted fixture research.

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
3. User fills all 16 fixtures.
4. Validation prevents incomplete tickets or excess doubles.
5. User submits and may edit until lock.
6. Group submissions become visible according to group policy.
7. Admin generates consensus.
8. Live fixtures show score/minute and provisional hit/miss.
9. Final Toto settlement grades every ticket.
10. Round statistics are frozen and added to history.

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

The result is concise and source-backed:
- primary single pick;
- optional double;
- confidence;
- key factors;
- main risk;
- timestamp;
- sources.

## Out of scope for MVP
- placing bets with Toto/Winner;
- deposits/withdrawals;
- pooled money;
- paid competitions;
- native iOS/Android apps.
