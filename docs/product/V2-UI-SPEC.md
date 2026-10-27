# Kapiloto V2 UI — Product Shell and Match Intelligence

Status: implementation started.

## Product model

Kapiloto is match-centric. A canonical `fixture` is the football match shared by:
- Toto 16;
- Kapiloto analysis;
- future Winner/free-slip surfaces;
- live state and performance tracking.

Toto remains a specialized product flow and storage model. It is not converted into a generic betting slip.

## Primary navigation

The target mobile shell is:
1. ראשי
2. משחקים
3. טפסים
4. קבוצה
5. אישי

Winner/free slip belongs under **טפסים**. It is not a separate primary navigation tab.

The current Toto screen remains active until the new Home/Matches/Tickets shell is implemented end to end. Do not replace working navigation with dead destinations.

## Match page

The Match Intelligence page is one scrollable verdict page. No five-tab match hub in this phase.

The page should progressively expose only data that really exists:
- fixture identity, competition, kickoff and live/final score;
- 1/X/2 final probabilities from the published Kapiloto intelligence version;
- reliability band and reliability score;
- final recommendation and suggested double when available;
- three to five decisive factors;
- absences/availability;
- main risk;
- what could change the verdict;
- accepted evidence sources;
- freshness/update timeline.

If no publication exists, the page explicitly says the match has not been researched yet. It must not invent probabilities, injuries, tactics or form.

## Toto integration

Each Toto fixture keeps the existing inline Kapiloto experience and also exposes a **ניתוח מלא** link to the canonical fixture page.

The inline panel is the fast decision surface. The match page is the deep explanation surface. Both read the same fixture-scoped intelligence.

## Winner scope

Winner UI is part of the V2 product direction, but broad Winner implementation is intentionally gated.

Initial scope:
- reuse Match Intelligence;
- expose model-backed market views only when deterministic data exists;
- no generic catalog of every Winner market;
- no Recommended Slip yet;
- no claims of betting edge/value;
- no fabricated tactics or market probabilities.

A free-slip flow remains a later phase after legal/product gating and calibration evidence.

## Delivery order

1. Match Intelligence page + Toto deep-analysis link.
2. Finish publication runtime so real research reliably populates the page.
3. New mobile shell: ראשי / משחקים / טפסים / קבוצה / אישי.
4. Home dashboard and Matches list.
5. Winner display-only market layer backed by deterministic models.
6. Prediction track record.
7. Only then consider free slips/recommended slips behind the agreed gates.


## Research prior fallback

Kapiloto research must not be blocked solely because bookmaker market data is unavailable.

Prior hierarchy:
1. use the latest valid pre-cutoff market prior when one exists;
2. otherwise use an explicit uninformative `league_base` prior of 33.34% / 33.33% / 33.33%.

The fallback is deliberately neutral: it does not invent bookmaker odds, team strength or home advantage. The reliability formula records and penalizes `uninformative_league_base_prior`, while grounded Sol research may move the final distribution away from the neutral baseline.

API-Football enrichment is therefore optional at runtime. Missing provider credentials must not block a research run; missing `OPENAI_API_KEY` must fail **before** run creation so it cannot consume one of the three research slots.


## Deep-analysis research controls

The Match Intelligence page reuses the same Kapiloto request state machine as the Toto inline panel.

- A match with no publication exposes the same explicit demand-driven research action.
- If another user already started the round-wide run, the page joins/polls that shared run instead of creating another one.
- When publication completes, the client refreshes the server-rendered match page so the deep analysis sections populate from canonical fixture intelligence.
- Existing publications expose recheck only under the same freshness, lock and three-run budget rules used by Toto.
- Research requests require an active group context; the underlying research remains central and shared for the round.
