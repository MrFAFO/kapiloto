# Design Status

Figma source:
https://www.figma.com/design/2Pp5ae9bgqhTfwcU2JcIlK

## Approved Figma pages
Only the current approved Dark Stadium work remains in the file:

1. **00 — Auth · Dark Stadium**
2. **01 — Mobile App · Dark Stadium**
3. **02 — Design System · Dark Stadium**
4. **03 — Desktop Adaptation · Dark Stadium**

Legacy light-theme and rejected concept pages were removed from the Figma file.

## Locked visual direction
**Dark Stadium**

The mobile experience is the source priority. Desktop is a later responsive adaptation.

## Current mobile core screens
- Current Round with upcoming, live, finished-hit and finished-miss fixture states.
- Large thumb-friendly 2/X/1 controls; selecting two outcomes automatically counts as a double.
- Visible used/max doubles count and per-game double badge.
- Inline per-fixture Kapiloto expansion with professional analysis, freshness, recheck and final recommendation.
- Diego full-ticket builder and Diego preview before filling the normal draft.
- Group screen with member submissions and join requests.
- Democratic Consensus screen with vote distribution.
- Statistics screen with weekly ranking and group comparisons.
- History and previous-round read-only screens.
- Create-group / join-group post-login state.
- Submitted-editable, max-doubles-reached and locked/read-only ticket states.
- Centered primary page titles across the approved mobile screens.

## Locked AI roles
- Manual filling is the default.
- **Kapiloto** is a per-fixture analyst only in the primary user-facing flow.
- Kapiloto expands inline under a fixture and never navigates away.
- Kapiloto may recommend a double, but the recommendation is ranked relative to all 16 fixtures and the limited group double budget.
- Kapiloto has no separate Apply button; the user edits the normal 1/X/2 controls.
- **Diego** is the only autonomous whole-ticket builder.
- Diego fills the same normal editable user draft; there is no separate “Diego ticket”.

## Design rules now locked
- 390px reference mobile width.
- Hebrew RTL.
- Dark Stadium visual language.
- Primary page heading centered in the upper header.
- Purple = Kapiloto / AI / uncertainty intelligence.
- Cyan = Diego / full-ticket generation.
- Blue = user selection / action.
- Red = live or miss/risk depending context.
- Green = hit / completion / success.
- Status is never represented by color alone; text labels remain mandatory.
- Finished games are visually darker/desaturated with subtle green-grey or red-grey treatment.
- Kapiloto fixture analysis stays inline.
- Every fixture independently shows league, date/result/status and ticket state.

## Authentication
Figma page: **00 — Auth · Dark Stadium**
- username/password login;
- remember-me control;
- signup with username/password + email-or-phone recovery contact;
- password-recovery state;
- approved full-width 3:2 Kapiloto + Diego stadium hero on all three auth screens;
- logo treatment matches the approved Kapiloto wordmark used in the app.

## Next design work
- Kapiloto loading / stale / changed / error / rate-limit states;
- draft Saving / Saved / Save failed / offline behavior;
- explicit eighth-double rejection interaction;
- admin round settings and member-management edge states;
- consensus stale/regeneration state;
- desktop adaptation of the approved mobile behavior.
