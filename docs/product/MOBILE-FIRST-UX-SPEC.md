# Mobile-first UX Specification — Dark Stadium

## Priority
Kapiloto is mobile-first. The phone experience is the primary product surface. Desktop is designed afterward as a true responsive composition, not as the source layout.

Reference width for design QA: 390px.

## Weekly round screen
The current round is the default home screen.

Every fixture row must show:
- game number;
- home and away teams;
- competition / league label;
- kickoff date/time if upcoming;
- live score + minute if in progress;
- final score if finished;
- the user's 1/X/2 selection;
- current/final result state;
- a per-fixture Kapiloto consultation affordance.

### Fixture visual states
#### Upcoming
- normal Dark Stadium surface;
- kickoff date/time;
- selection controls active until round lock.

#### Live
- explicit LIVE badge;
- current score;
- minute/status;
- provisional Hebrew state for currently hit/currently miss;
- visual emphasis stronger than upcoming games.

#### Finished — Hit
- final score;
- Hebrew Hit label;
- row becomes slightly darker/desaturated;
- subtle dark green/grey tint, not bright green.

#### Finished — Miss
- final score;
- Hebrew Miss label;
- row becomes slightly darker/desaturated;
- subtle dark red/grey tint, not bright red.

#### Under Review / Void / Technical
- neutral/amber treatment;
- settlement-specific label;
- never assume sporting result equals Toto settlement outcome.

## Pick controls
Selection must be thumb-friendly.

Requirements:
- large 1/X/2 tap targets;
- selected state unmistakable;
- double pick is made by activating two outcomes;
- selected pair remains visible without an extra modal;
- reaching max doubles produces clear feedback;
- no ambiguous destructive third-outcome behavior.

Preferred interaction:
- single outcome tap selects/replaces a single;
- second outcome tap adds a double if capacity exists;
- tapping an active outcome in a double removes only that outcome;
- adding a third outcome should be blocked with a clear message unless a deliberate tested replacement interaction is designed.

## Doubles counter
- persistent but compact;
- shows used/max, e.g. 5 / 7;
- changes visually near the limit;
- tap opens a quick list of games currently using doubles.

## Inline Kapiloto consultation
Do not navigate to a separate screen.

Each fixture has a clear Consult Kapiloto action.
On tap, an expandable panel opens directly below that fixture.

Panel supports:
- expand;
- collapse/minimize;
- reopen without losing cached result;
- loading state;
- stale state;
- error/retry state.

### Inline analysis content
- recommendation: single + optional double;
- confidence;
- concise conclusion;
- key factors;
- main risk/counter-case;
- last researched timestamp;
- sources;
- Apply to my ticket;
- Recheck.

### Recheck behavior
A recheck performs new research and creates a new analysis version.

UI must show:
- last updated age;
- stale indicator when new information may exist;
- recommendation-change indicator when the pick changed, including reason.

Rechecking never silently overwrites the user's pick.

## Kapiloto — whole-ticket tools
The round screen includes three AI flows:

### 1. Recommend doubles
Kapiloto reviews all 16 fixtures and ranks where doubles add the most value, respecting the group max.

### 2. Review my ticket
Kapiloto detects unsafe singles, weak double allocation, stale picks and major conflicts with current research.

### 3. Fill the whole ticket
Kapiloto creates a complete draft for all 16 fixtures, obeying the double limit. The user previews before applying.

Kapiloto never alters a submitted or locked ticket outside the normal edit/submit flow.

## Round-level status
A global live count can exist as secondary information, but every fixture independently displays date/result/status.

## Mobile navigation
Primary destinations:
- Round / Ticket;
- Group;
- Consensus;
- Statistics;
- History or More.

Use four items plus More if five items reduce clarity.

## Desktop adaptation
Desktop may add side navigation, simultaneous AI/group panels, richer statistics and denser fixture lists, but must preserve the same domain behavior.