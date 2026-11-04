# Kapiloto V4 — Five Supported Leagues Onboarding Inventory

Status: **read-only inventory; no production identity writes authorized by this document**  
Date: 2026-10-31  
Decision: D-059 — V4 V1 is limited to five supported competitions.

## 1. Launch universe

The first user-facing V4 release supports only:

1. Premier League — Sportmonks league 8
2. Bundesliga — Sportmonks league 82
3. La Liga — Sportmonks league 564
4. Serie A — Sportmonks league 384
5. Ligat Ha'al — Sportmonks league 372

Official 2026/27 membership sources used for this inventory:

- Premier League:
  `https://www.premierleague.com/en/news/4365156`
- Bundesliga:
  `https://www.bundesliga.com/en/bundesliga/clubs`
- La Liga:
  `https://www.laliga.com/en-US/laliga-easports/clubs`
- Serie A:
  `https://en.legaseriea.it/serie-a/statistiche/clubs`
- Ligat Ha'al:
  `https://www.football.org.il/leagues/league/?league_id=40`

The five leagues contain **92 current clubs** in total.

## 2. Production coverage snapshot

Production catalog/mapping counts on 2026-10-31:

| League | Current clubs | Canonical teams present | Sportmonks mapped | V4 team attested | Canonical missing | Existing canonical without Sportmonks mapping |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Premier League | 20 | 20 | 16 | 16 | 0 | 4 |
| Bundesliga | 18 | 18 | 18 | 18 | 0 | 0 |
| La Liga | 20 | 20 | 14 | 14 | 0 | 6 |
| Serie A | 20 | 20 | 19 | 19 | 0 | 1 |
| Ligat Ha'al | 14 | 14 | 14 | 14 | 0 | 0 |
| **Total** | **92** | **92** | **81** | **81** | **0** | **11** |

Interpretation:

- **81** clubs are now through the reviewed V4 attestation path.
- **0** clubs remain in Class A (existing Sportmonks mapping but not yet V4-attested).
- **11** clubs already exist canonically but still need a Sportmonks mapping plus attestation.
- **0** current launch-universe clubs are missing canonically.

The counts above describe coverage only. A `confirmed` Sportmonks mapping is not trusted historical identity under D-058.

## 3. Premier League — 20 clubs

Official membership:
AFC Bournemouth, Arsenal, Aston Villa, Brentford, Brighton & Hove Albion,
Chelsea, Coventry City, Crystal Palace, Everton, Fulham, Hull City, Ipswich
Town, Leeds United, Liverpool, Manchester City, Manchester United, Newcastle
United, Nottingham Forest, Sunderland, Tottenham Hotspur.

The current Sportmonks season roster is frozen by immutable read-only capture:

- league: `8 / Premier League`
- season: `28083 / 2026/2027`
- teams: `20`
- team-set SHA-256:
  `e864984e5ea7649c2589e76de56c4be95b6be8554e7ccdf09ffe9f68b17c32d9`

The capture also resolved a provider-source discrepancy: the live Sportmonks
season API returned `Sunderland = 3`, matching production and the A2-B pilot;
a public provider page had shown 27 and was not used as write authority.

### Identity-complete — 16/20

Already attested before this phase:

- Sunderland
- Leeds United
- Manchester United

Existing mapped identities promoted and attested in phase 1:

- Brentford
- Coventry City
- Crystal Palace
- Fulham
- Hull City
- Newcastle United

New canonical identities created, mapped and attested in phase 1:

- Aston Villa — `אסטון וילה`
- Brighton & Hove Albion — `ברייטון`
- Chelsea — `צ'לסי`
- Everton — `אברטון`
- Manchester City — `מנצ'סטר סיטי`
- Nottingham Forest — `נוטינגהאם פורסט`
- Tottenham Hotspur — `טוטנהאם`

Execution record:
`docs/operations/2026-10-31-v4-premier-league-identity-onboarding-phase1.md`.

### Existing canonical, Sportmonks mapping deferred — 4

All four appear in the active Winner 16 round `264301`, so adding a new
Sportmonks mapping is intentionally deferred until that round is no longer
active:

- AFC Bournemouth — existing `בורנמות'` — Sportmonks 52
- Arsenal — existing `ארסנל` — Sportmonks 19
- Ipswich Town — existing `איפסוויץ'` — Sportmonks 116
- Liverpool — existing `ליברפול` — Sportmonks 8

Current Premier League identity status: **16/20 complete**.

Registry status: **validating**, not yet `supported`.

## 4. Bundesliga — 18 clubs

Official 2026/27 membership is now **identity-complete 18/18**.

The immutable Sportmonks roster capture resolved:

- league: `82 / Bundesliga`
- season: `28321 / 2026/2027`
- teams: `18`
- team-set SHA-256:
  `7119ee57fcba90e282b436a6b2599d6522e653148d744ed7bfdb10d175d35795`

All 18 current clubs now have:
- one canonical team;
- one reviewed Sportmonks mapping;
- `manual_override` mapping status;
- active D-058 V4 team attestation.

Previously attested from the pilot:

- FC Bayern München
- TSG Hoffenheim
- Bayer 04 Leverkusen
- Sport-Club Freiburg

Existing mapped identities promoted and attested:

- FC Schalke 04
- SC Paderborn 07
- Hamburger SV
- 1. FC Köln

New canonical identities created, mapped and attested:

- Borussia Dortmund — `בורוסיה דורטמונד`
- SV Werder Bremen — `ורדר ברמן`
- FC Augsburg — `אוגסבורג`
- RB Leipzig — `ר.ב. לייפציג`
- Eintracht Frankfurt — `איינטרכט פרנקפורט`
- Borussia Mönchengladbach — `מנשנגלדבאך`
- 1. FSV Mainz 05 — `מיינץ`
- 1. FC Union Berlin — `אוניון ברלין`
- VfB Stuttgart — `שטוטגרט`
- SV Elversberg — `אלברסברג`

Execution record:
`docs/operations/2026-11-01-v4-bundesliga-identity-onboarding-execution.md`.

Identity status: **complete 18/18**.

Registry status: **validating**, not yet `supported`.
Provider-family/history gates still remain.

## 5. La Liga — 20 clubs

Official 2026/27 membership is frozen by the immutable Sportmonks roster
capture and cross-checked against the official La Liga club list.

Capture:

- league: `564 / La Liga`
- season: `27965 / 2026/2027`
- teams: `20`
- team-set SHA-256:
  `40b74af3f2c0695f6dbe04991b9048efe543bea2b24b318c103a8dd5fc5ab3e6`

### Identity-complete — 14/20

Previously attested:

- FC Barcelona
- CA Osasuna
- Real Madrid

Existing mapped identities promoted and attested in phase 1:

- Celta de Vigo
- Valencia
- Real Betis
- Espanyol
- Villarreal
- Racing Santander

New canonical identities created, mapped and attested in phase 1:

- Málaga — `מלאגה`
- Deportivo A Coruña — `דפורטיבו לה קורוניה`
- Deportivo Alavés — `אלאבס`
- Levante — `לבאנטה`
- Atlético de Madrid — `אתלטיקו מדריד`

Execution record:
`docs/operations/2026-11-01-v4-laliga-identity-onboarding-phase1.md`.

### Existing canonical, Sportmonks mapping deferred — 6

All six participate in Winner round `264301`, which remains
`under_review`, so adding a new Sportmonks mapping remains deliberately
deferred:

- Getafe — existing `חטאפה` — Sportmonks 106
- Rayo Vallecano — existing `ראיו ואייקאנו` — Sportmonks 377
- Real Sociedad — existing `ריאל סוסיאדד` — Sportmonks 594
- Sevilla — existing `סביליה` — Sportmonks 676
- Elche — existing `אלצ'ה` — Sportmonks 1099
- Athletic Club — existing `אתלטיק בילבאו` — Sportmonks 13258

Current La Liga identity status: **14/20 complete**.

Registry status: **validating**, not yet `supported`.

## 6. Serie A — 20 clubs

Official 2026/27 membership is frozen by the immutable Sportmonks roster
capture and cross-checked against Lega Serie A.

Capture:

- league: `384 / Serie A`
- season: `27895 / 2026/2027`
- teams: `20`
- team-set SHA-256:
  `ab4d41933e56bb8b51a277ee18bfadf323dc13072e20ea1142ce70ab5a3c2b9a`

### Identity-complete — 19/20

Previously attested:

- Fiorentina
- Atalanta
- Frosinone
- Lecce

Existing mapped identities promoted and attested in phase 1:

- Roma
- AC Milan
- Cagliari
- Napoli
- Inter
- Bologna

New canonical identities created, mapped and attested in phase 1:

- Lazio — `לאציו`
- Genoa — `גנואה`
- Venezia — `ונציה`
- Como — `קומו`
- Udinese — `אודינזה`
- Parma — `פארמה`
- Torino — `טורינו`
- Monza — `מונצה`
- Sassuolo — `ססואולו`

Execution record:
`docs/operations/2026-11-01-v4-serie-a-identity-onboarding-phase1.md`.

### Existing canonical, Sportmonks mapping deferred — 1

Juventus participates in Winner round `264301`, which remains
`under_review`, so adding a new Sportmonks mapping remains deliberately
deferred:

- Juventus — existing `יובנטוס` — Sportmonks 625

Current Serie A identity status: **19/20 complete**.

Registry status: **validating**, not yet `supported`.

## 7. Ligat Ha'al — 14 clubs

Official 2026/27 membership is now **identity-complete 14/14**.

All 14 current clubs have:
- one canonical team;
- one reviewed Sportmonks mapping;
- `manual_override` mapping status;
- active D-058 V4 team attestation.

The final missing club, Maccabi Tel Aviv, was created on 2026-10-31 as:
- canonical: `מכבי תל אביב`
- canonical id: `ff73883e-6c8a-4840-98f6-f9683e967e31`
- Sportmonks: `2997 / Maccabi Tel Aviv`

The nine previously confirmed Sportmonks mappings were independently reviewed,
promoted and attested. See:
`docs/operations/2026-10-31-v4-ligat-haal-identity-onboarding-execution.md`.

Identity status: **complete**.

Registry status: **validating**, not yet `supported`.
Remaining league-level gates are provider-family semantics/coverage and
historical ingest quality for the V4 features that will be exposed.

## 8. Onboarding work classes

### Class A — existing canonical + existing Sportmonks mapping, not yet attested

Count: **0**

For each:
- independently verify provider identity;
- verify canonical/alias/provider collision state;
- promote exact Sportmonks mapping to `manual_override` if still `confirmed`;
- preserve legacy confidence rather than treating it as trust;
- attest separately under D-058;
- assert no shadow/injectivity conflict.

### Class B — existing canonical, Sportmonks mapping missing

Count: **11**

For each:
- identify exact Sportmonks team id from reviewed provider evidence;
- run atomic duplicate/collision audit;
- attach to the existing canonical team;
- add reviewed provider/English alias if absent;
- create `manual_override` mapping with `mapping_confidence = NULL`;
- attest separately.

Bournemouth, Arsenal, Ipswich, Liverpool, Getafe, Rayo Vallecano, Real
Sociedad, Sevilla, Elche, Athletic Club and Juventus are the **only 11**
remaining launch-universe identity gaps. All are reviewed Class-B identities
and remain temporarily deferred because they participate in Winner round
264301 and a new provider-team mapping could change V3 fixture-mapping
behavior.

### Class C — canonical team missing

Count: **0**

For each:
- verify current official league membership;
- capture exact Sportmonks provider id/name;
- determine the canonical Hebrew spelling using Winner/Telesport-compatible
  evidence where available;
- run atomic all-country/all-alias/all-provider duplicate audit;
- create exactly one canonical team;
- add reviewed aliases;
- create Sportmonks `manual_override` mapping with confidence null;
- attest separately;
- rerun collision/injectivity checks.

## 9. League promotion to `supported`

A league remains `validating` until **all clubs required for its current
user-facing season membership** complete the appropriate Class A/B/C path.

Promotion checklist:

- official current membership frozen with source/retrieval metadata;
- every member club has one canonical identity;
- every member club has one reviewed Sportmonks identity;
- every member club has active V4 identity trust;
- no normalized canonical/alias duplicate;
- no Sportmonks injectivity conflict;
- competition attestation active;
- provider-family semantics/coverage reviewed for exposed features;
- historical pilot/backfill quality gates clean;
- pause/rollback path documented.

Only then change the league registry state to `supported`.

## 10. Recommended execution order

Do not try to write all 74 remaining identities in one large batch.

Recommended order:

1. Ligat Ha'al identity onboarding — **DONE 14/14**;
2. Premier League phase 1 — **DONE 16/20**; complete Bournemouth, Arsenal,
   Ipswich and Liverpool after round 264301 settles;
3. complete deferred Sevilla after round 264301 settles;
4. Bundesliga identity onboarding — **DONE 18/18**;
5. La Liga phase 1 — **DONE 14/20**; complete Getafe, Rayo Vallecano,
   Real Sociedad, Sevilla, Elche and Athletic Club after round 264301 settles;
6. Serie A phase 1 — **DONE 19/20**; complete Juventus after round 264301 settles;
7. after round 264301 settles, complete all **11 deferred Class-B** identities
   across Premier League, La Liga and Serie A;
8. run full five-league collision/readiness audit;
9. validate provider-family/history gates per league;
10. only then promote each qualifying competition from `validating` to `supported`.

Update 2026-11-03: round 264301 has settled. Pilot R4 completed Bournemouth 52 and Sevilla 676, so items 2, 3 and 5 are now Premier League 17/20 and La Liga 15/20. The deferred Class-B set in item 7 is down to 9: Liverpool 8, Arsenal 19, Ipswich 116, Getafe 106, Rayo Vallecano 377, Real Sociedad 594, Elche 1099, Athletic Club 13258 and Juventus 625. See `docs/operations/2026-10-31-v4-pilot-identity-reconciliation-execution.md` §8.

Update 2026-11-04: seven of the nine were completed, each in its own locked mapping transaction followed by a separate attestation: Liverpool 8, Arsenal 19, Ipswich 116, Getafe 106, Rayo Vallecano 377, Real Sociedad 594 and Juventus 625. Launch-league identity status:
- Premier League 20/20;
- Bundesliga 18/18;
- Ligat Ha'al 14/14;
- La Liga 18/20;
- Serie A 20/20.

The only remaining identities are Elche 1099 and Athletic Club 13258. Both are deferred because they play in open Winner round 264401. See `docs/operations/2026-11-04-v4-class-b-deferred-identities-execution.md`.

This order gives a small first complete league and repeatedly exercises all
three onboarding classes before the larger European catalogs are finished.

No M2B or Match Ledger ingest permission is granted by this inventory.