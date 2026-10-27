# Mobile-first UX Specification — Dark Stadium

## Priority
Kapiloto is mobile-first. The phone experience is the primary product surface. Desktop is designed afterward as a true responsive composition, not as the source layout.

Reference width for design QA: 390px.

## Weekly round screen
The current round is the default home screen and manual ticket filling is always the default flow.

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
- double pick is made automatically by activating two outcomes;
- there is no separate “choose doubles” control;
- selected pair remains visible without an extra modal;
- reaching max doubles produces clear feedback;
- no ambiguous destructive third-outcome behavior.

Preferred interaction:
- single outcome tap selects/replaces a single;
- second outcome tap adds a double if capacity exists;
- tapping an active outcome in a double removes only that outcome;
- adding a third outcome is blocked with a clear message.

## Doubles counter
- persistent but compact;
- shows used/max, e.g. 5 / 7;
- changes visually near the limit;
- tap opens a quick list of games currently using doubles.

## Kapiloto — per-fixture analyst
Kapiloto is the fixture analyst. It does not own a separate whole-ticket flow.

Each fixture has a clear “Consult Kapiloto” action. On tap, an expandable panel opens directly below that fixture; it never navigates away from the ticket.

Panel supports:
- expand;
- collapse/minimize;
- reopen without losing cached result;
- loading state;
- stale state;
- rechecking state;
- error/retry state;
- recommendation-changed state.

### Inline analysis content
- exact recommendation: 1 / X / 2 / 1X / X2 / 12;
- whether a double is recommended;
- relative double priority against the other 15 fixtures and the remaining group double budget;
- analysis reliability / confidence band (quality of the research, not outcome probability);
- concise professional conclusion;
- current form and home/away context;
- injuries, suspensions, expected returns and fatigue/load;
- tactical matchup and table/context;
- relevant current news / press-conference signal;
- independent analysis/model signal and market movement where useful;
- main risk/counter-case;
- freshness timestamp;
- sources;
- Recheck.

There is no separate “Apply” button. The recommendation appears inside the fixture card and the user changes the normal 1/X/2 controls directly.

### Recheck behavior
A recheck is an explicit request for newer research relative to the published round snapshot. If eligible, it creates or joins the next shared all-16-fixture research run; it is not a one-fixture Sol call.

The previous analysis remains visible while the new run is researching. If all three research slots have been consumed, the UI keeps the newest available analysis and explains that no further refresh is available for this round.

UI must show:
- last updated age;
- stale indicator when new information may exist;
- recommendation-change indicator when the pick changed, including reason;
- shared research-in-progress state when another user already triggered the run;
- research-budget-exhausted state distinct from request rate limiting.

Rechecking never silently overwrites the user's pick.

## Diego — full-ticket builder
Diego is the only autonomous whole-ticket flow.

Diego:
- uses the latest Kapiloto research for all 16 fixtures;
- selects every game;
- allocates doubles while respecting the group maximum;
- uses structured outcome scores plus deterministic validation/optimization;
- shows a preview with key decisions before filling;
- fills the same normal editable user draft rather than creating a separate “Diego ticket”.

After Diego finishes:
- all 16 normal ticket picks are populated;
- doubles are counted and badged normally;
- per-game Kapiloto analysis remains available inline;
- the user can manually change any pick;
- the user submits the normal ticket when satisfied.

## Round-level status
A global live count can exist as secondary information, but every fixture independently displays date/result/status.

## Round navigation
The upper header supports previous/current round navigation.
Previous rounds are read-only and contain no edit, submit, Kapiloto recheck or Diego actions.

## Mobile navigation
Primary destinations:
- Round / Ticket;
- Group;
- Consensus;
- Statistics;
- History or More.

Use four items plus More if five items reduce clarity.

## Desktop adaptation
Desktop may add side navigation, simultaneous information panels, richer statistics and denser fixture lists, but must preserve the same domain behavior.
