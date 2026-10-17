# UX State Matrix

Purpose: prevent hidden edge states from being discovered only during implementation.

## Ticket / round states

| State | User can edit? | Primary UI behavior | Notes |
|---|---:|---|---|
| Round upcoming, not open | No | countdown + read-only fixtures | if fixture list already known |
| Round open, draft incomplete | Yes | show missing-game count | autosave draft |
| Round open, draft complete | Yes | enable Submit | validate max doubles |
| Submitted before lock | Yes | show Submitted + Edit | editing creates new auditable version |
| Lock reached | No | freeze personal ticket | server time is authoritative |
| Live | No | show score/minute + provisional hit/miss | updates independently per fixture |
| Finished but unsettled | No | show final football score + Under Review if needed | do not finalize stats yet |
| Settled | No | final hit/miss | immutable historical snapshot |

## Pick interaction states
- Single selected
- Double selected
- No pick yet
- Max doubles reached
- Attempt to add an eighth double
- User removes one leg of a double
- User changes a submitted pick before lock
- Network fails during autosave
- Same draft edited on another device

Max-double error must be explicit; never silently ignore the tap.

## Fixture result states
- Upcoming with date/time
- Live with score + minute
- Half-time
- Suspended/temporarily interrupted
- Finished — provisional hit
- Finished — provisional miss
- Settled — hit
- Settled — miss
- Postponed
- Cancelled/void
- Technical/disciplinary review
- Settlement differs from field result

Status must use text/iconography in addition to color.

## Inline Kapiloto states
- Never researched
- Loading first research
- Fresh analysis
- Fresh analysis collapsed
- Stale by TTL
- Stale because a material event occurred
- Rechecking
- Recommendation unchanged after recheck
- Recommendation changed after recheck
- Research failed
- Sources partially unavailable
- Research budget exhausted (3 shared runs consumed)
- Request rate limit reached

Recheck never changes the user's pick automatically. Kapiloto has no separate Apply action; the user changes the normal ticket controls directly.

## Diego full-ticket states
- Enough fresh fixture analyses
- Some fixture analyses stale
- Research required before proposal
- Researching one or more fixtures
- Generating full-ticket proposal
- Proposal violates deterministic validation and is repaired/rejected
- Preview ready
- User confirms preview
- Same normal user draft is filled
- User manually edits Diego-filled picks
- User rejects/cancels preview
- Ticket becomes analytically stale after new fixture research

There is no separate Diego ticket object in the UX.

## Group / consensus states
- No members yet
- Join request pending
- Some members not submitted
- All members submitted
- Consensus never generated
- Consensus current
- Consensus stale because a source submission changed
- Consensus generated after lock from lock-time snapshots
- Member leaves group after historical submission
- Admin/owner unavailable

## Data freshness states
- Football provider current
- Football provider delayed
- Last sync age visible
- Toto round source changed
- Fixture mapping uncertain
- Settlement source pending

Where confidence is low, show the uncertainty rather than silently guessing.

## Connectivity
Mobile-first requires explicit poor-network behavior:
- draft write queued/retried;
- clear Saved / Saving / Save failed state;
- live scores can show last-updated age;
- cached historical screens remain readable;
- destructive actions require confirmed server response.

## Authentication states
- Logged out -> authentication screen before all product screens
- Username/password login
- Remember me checked
- Remember me unchecked
- Invalid credentials with generic error
- Login rate limited
- Registration: username available/unavailable
- Registration: email recovery contact
- Registration: phone recovery contact
- Registration: both contacts provided
- Recovery email sent
- Recovery SMS OTP sent
- Invalid/expired recovery code
- New password set
- Existing remembered session restored
- Explicit logout clears the remembered session

Recovery must never display or send the existing password.

## Brand-character states
Authentication uses the approved full-width Kapiloto + Diego stadium hero.
Character art remains decorative/brand-supporting:
- never cover inputs or primary CTA;
- load progressively;
- preserve usable auth UI if the asset fails to load;
- avoid heavy animation that harms performance or accessibility.
