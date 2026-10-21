# Mobile UX Review 001

Status: screenshot-based audit of the approved Dark Stadium mobile flow.

Figma source:
https://www.figma.com/design/2Pp5ae9bgqhTfwcU2JcIlK

Primary page:
**01 — Mobile App · Dark Stadium**

## Overall verdict

The core direction is strong and coherent: the ticket is clearly the primary product, Dark Stadium has a recognizable visual identity, fixture states are understandable, and Kapiloto/Diego now have distinct roles.

The remaining risks are mainly interaction clarity, information density, pre-group onboarding, and edge states rather than visual direction.

## Step 1 — Login
Health: Good

Strengths:
- simple username/password flow;
- remember-me control is visible;
- brand characters create stronger identity than the original placeholders.

Findings:
- production character assets should be higher resolution than the current Figma proof-of-concept crops;
- character artwork must remain non-blocking so auth is usable before images load;
- remember-me copy should remain concise on very small screens.

Accessibility:
- form labels are explicit;
- final implementation must provide visible keyboard focus, password show/hide semantics, and error text independent of color.

## Step 2 — Current Round / Manual Ticket
Health: Good

Strengths:
- manual filling is clearly the default;
- 2/X/1 tap targets are large enough for mobile use;
- selecting two outcomes visibly becomes a double;
- used/max doubles is visible in the header;
- each fixture shows league and state;
- live/hit/miss are visible per fixture instead of relying on a global live count.

Findings:
- when the maximum doubles count is reached, the eighth-double attempt must produce an explicit inline/toast explanation rather than silently fail;
- autosave needs visible Saving / Saved / Save failed states;
- the Diego full-ticket action should remain visually secondary to manual filling;
- a finished fixture should always show explicit Hit/Miss/Under Review, not only a final score.

Accessibility:
- Hit/Miss/Live must keep text labels in addition to color;
- selected pick buttons need a programmatic pressed/selected state.

## Step 3 — Inline Kapiloto
Health: Good, with readability risk

Strengths:
- analysis stays inside the fixture card and preserves context;
- recommendation includes double advice in full-round context;
- recheck is available without changing the user's selection;
- recommendation and source freshness are separated from the user's actual pick.

Finding:
- the requested professional 7–8-line analysis creates dense mobile text. Preserve the depth, but implementation should use comfortable line-height, paragraph/factor grouping, and expandable source details rather than reducing font size excessively.

Recommended content hierarchy:
1. recommendation + double priority;
2. concise professional analysis;
3. main risk;
4. freshness/source count;
5. recheck.

## Step 4 — Create / Join Group
Health: Good, one navigation concern

Strengths:
- create and join paths are clearly separated;
- join request approval model is understandable.

Finding:
- a user who has not yet joined or created a group should not see active app destinations that require group context. Pre-group onboarding should use a simplified shell until membership exists.

## Step 5 — Group
Health: Good

Strengths:
- member submission state is scannable;
- scores and pending join requests are visible;
- admin task is easy to discover.

Finding:
- member-ticket visibility policy must be reflected in UI. If picks are hidden until the viewer submits, rows should explicitly say why they are hidden rather than appear broken.

## Step 6 — Consensus
Health: Good

Strengths:
- vote distribution makes the algorithm explainable;
- double choice is visible instead of appearing magical.

Findings:
- consensus should visually indicate Current vs Stale;
- stale reason should be understandable, e.g. “Yossi edited his ticket after this consensus was generated”;
- consensus belongs conceptually under Group, so navigation should not imply it is an unrelated More screen.

## Step 7 — Statistics
Health: Good

Strengths:
- raw weekly score remains prominent;
- consensus and Kapiloto comparisons are secondary rather than replacing the intuitive 0–16 score.

Finding:
- future efficiency metrics must be clearly separate from raw hits because different numbers of doubles change coverage.

## Step 8 — History / Previous Round
Health: Good

Strengths:
- previous-round browsing is now available directly from round navigation;
- historical ticket is visually read-only;
- final result state remains visible.

Findings:
- every finished fixture must consistently show final Hit/Miss/Under Review;
- historical Kapiloto analysis may be viewable as read-only, but no refresh/recheck action should be available for a settled round unless explicitly designed as a research-history feature.

## Step 9 — Ticket Limits / Submitted / Locked
Health: Good

Strengths:
- max-doubles, submitted-editable and locked states are distinct.

Finding:
- server time must be authoritative at lock. If the client crosses lock while open, controls should transition cleanly to read-only and reconcile any in-flight save.

## Step 10 — Diego Preview
Health: Good

Strengths:
- Diego does not create a separate ticket type;
- the preview shows double allocation before filling the normal draft;
- user retains final control.

Findings:
- preview should show a compact “why changed” indicator when the user already had a draft;
- if some Kapiloto analyses are stale, Diego should show that refresh is happening before presenting a ready ticket;
- after Diego fills the normal draft, the user should be able to identify which selections came from Diego until manually changed.

## Highest-impact actions before implementation

1. Define and design Save/Saving/Save failed and multi-device conflict states.
2. Define Current/Stale consensus UI.
3. Remove group-dependent navigation from pre-group onboarding.
4. Preserve readable Kapiloto analysis typography despite 7–8 lines of content.
5. Add explicit eighth-double feedback.
6. Define Diego stale-research/refresh and diff states.
7. Keep historical rounds strictly read-only while allowing historical information to be inspected.

## Evidence limits

This audit is based on static Figma screenshots. It cannot verify real touch behavior, scrolling performance, screen-reader semantics, focus order, keyboard interaction, actual network failures, animation, or live-data latency. Those require implementation-level testing on physical mobile devices.
