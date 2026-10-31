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
| Premier League | 20 | 13 | 9 | 3 | 7 | 4 |
| Bundesliga | 18 | 8 | 8 | 4 | 10 | 0 |
| La Liga | 20 | 15 | 9 | 3 | 5 | 6 |
| Serie A | 20 | 11 | 10 | 4 | 9 | 1 |
| Ligat Ha'al | 14 | 13 | 13 | 4 | 1 | 0 |
| **Total** | **92** | **60** | **49** | **18** | **32** | **11** |

Interpretation:

- **18** clubs are already through the reviewed V4 attestation path from the pilot.
- **31** additional clubs already have a Sportmonks mapping but still need reviewed D-058 promotion/attestation for supported-league trust.
- **11** clubs already exist canonically but need a Sportmonks mapping plus attestation.
- **32** clubs do not yet exist canonically and require reviewed canonical creation, mapping, aliases and attestation.

The counts above describe coverage only. A `confirmed` Sportmonks mapping is not trusted historical identity under D-058.

## 3. Premier League — 20 clubs

Official membership:
AFC Bournemouth, Arsenal, Aston Villa, Brentford, Brighton & Hove Albion,
Chelsea, Coventry City, Crystal Palace, Everton, Fulham, Hull City, Ipswich
Town, Leeds United, Liverpool, Manchester City, Manchester United, Newcastle
United, Nottingham Forest, Sunderland, Tottenham Hotspur.

### Canonical missing — 7

- Aston Villa
- Brighton & Hove Albion
- Chelsea
- Everton
- Manchester City
- Nottingham Forest
- Tottenham Hotspur

### Canonical exists, Sportmonks mapping missing — 4

- AFC Bournemouth — existing `בורנמות'` — Sportmonks 52 is intentionally deferred until Winner round 264301 settles
- Arsenal — existing `ארסנל`
- Ipswich Town — existing `איפסוויץ'`
- Liverpool — existing `ליברפול`

### Already Sportmonks mapped — 9

- Brentford
- Coventry City
- Crystal Palace
- Fulham
- Hull City
- Leeds United
- Manchester United
- Newcastle United
- Sunderland

Already V4-attested from the pilot:
Leeds United, Manchester United, Sunderland.

## 4. Bundesliga — 18 clubs

Official membership:
FC Bayern München, Borussia Dortmund, RB Leipzig, VfB Stuttgart, TSG
Hoffenheim, Bayer 04 Leverkusen, Sport-Club Freiburg, Eintracht Frankfurt,
FC Augsburg, 1. FSV Mainz 05, 1. FC Union Berlin, Borussia Mönchengladbach,
Hamburger SV, 1. FC Köln, SV Werder Bremen, FC Schalke 04, SV Elversberg,
SC Paderborn 07.

### Canonical missing — 10

- Borussia Dortmund
- RB Leipzig
- VfB Stuttgart
- Eintracht Frankfurt
- FC Augsburg
- 1. FSV Mainz 05
- 1. FC Union Berlin
- Borussia Mönchengladbach
- SV Werder Bremen
- SV Elversberg

### Canonical exists, Sportmonks mapping missing — 0

### Already Sportmonks mapped — 8

- FC Bayern München
- TSG Hoffenheim
- Bayer 04 Leverkusen
- Sport-Club Freiburg
- Hamburger SV
- 1. FC Köln
- FC Schalke 04
- SC Paderborn 07

Already V4-attested from the pilot:
FC Bayern München, TSG Hoffenheim, Bayer 04 Leverkusen, Sport-Club Freiburg.

## 5. La Liga — 20 clubs

Official membership:
Athletic Club, Atlético de Madrid, CA Osasuna, Celta, Deportivo Alavés,
Elche CF, FC Barcelona, Getafe CF, Levante UD, Málaga CF, R. Racing Club,
Rayo Vallecano, RC Deportivo, RCD Espanyol de Barcelona, Real Betis,
Real Madrid, Real Sociedad, Sevilla FC, Valencia CF, Villarreal CF.

### Canonical missing — 5

- Atlético de Madrid
- Deportivo Alavés
- Levante UD
- Málaga CF
- RC Deportivo

### Canonical exists, Sportmonks mapping missing — 6

- Athletic Club — existing `אתלטיק בילבאו`
- Elche CF — existing `אלצ'ה`
- Getafe CF — existing `חטאפה`
- Rayo Vallecano — existing `ראיו ואייקאנו`
- Real Sociedad — existing `ריאל סוסיאדד`
- Sevilla FC — existing `סביליה` — Sportmonks 676 is intentionally deferred until Winner round 264301 settles

### Already Sportmonks mapped — 9

- CA Osasuna
- Celta
- FC Barcelona
- R. Racing Club
- RCD Espanyol de Barcelona
- Real Betis
- Real Madrid
- Valencia CF
- Villarreal CF

Already V4-attested from the pilot:
CA Osasuna, FC Barcelona, Real Madrid.

## 6. Serie A — 20 clubs

Official membership:
Atalanta, Bologna, Cagliari, Como, Fiorentina, Frosinone, Genoa, Inter,
Juventus, Lazio, Lecce, Milan, Monza, Napoli, Parma, Roma, Sassuolo, Torino,
Udinese, Venezia.

### Canonical missing — 9

- Como
- Genoa
- Lazio
- Monza
- Parma
- Sassuolo
- Torino
- Udinese
- Venezia

### Canonical exists, Sportmonks mapping missing — 1

- Juventus — existing `יובנטוס`

### Already Sportmonks mapped — 10

- Atalanta
- Bologna
- Cagliari
- Fiorentina
- Frosinone
- Inter
- Lecce
- Milan
- Napoli
- Roma

Already V4-attested from the pilot:
Atalanta, Fiorentina, Frosinone, Lecce.

## 7. Ligat Ha'al — 14 clubs

Official 2026/27 table:
Maccabi Tel Aviv, Hapoel Tel Aviv, Hapoel Be'er Sheva, Maccabi Haifa,
Beitar Jerusalem, Maccabi Netanya, Bnei Sakhnin, Maccabi Petah Tikva,
Hapoel Haifa, Hapoel Jerusalem, Hapoel Ramat Gan, Ironi Kiryat Shmona,
Hapoel Petah Tikva, Ironi Tiberias.

### Canonical missing — 1

- Maccabi Tel Aviv

### Canonical exists, Sportmonks mapping missing — 0

### Already Sportmonks mapped — 13

- Hapoel Tel Aviv
- Hapoel Be'er Sheva
- Maccabi Haifa
- Beitar Jerusalem
- Maccabi Netanya
- Bnei Sakhnin
- Maccabi Petah Tikva
- Hapoel Haifa
- Hapoel Jerusalem
- Hapoel Ramat Gan
- Ironi Kiryat Shmona
- Hapoel Petah Tikva
- Ironi Tiberias

Already V4-attested from the pilot:
Hapoel Be'er Sheva, Maccabi Haifa, Beitar Jerusalem, Hapoel Petah Tikva.

## 8. Onboarding work classes

### Class A — existing canonical + existing Sportmonks mapping, not yet attested

Count: **31**

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

Bournemouth and Sevilla are already reviewed Class-B identities but remain
temporarily deferred because of the active Winner round 264301 V3 side effect.

### Class C — canonical team missing

Count: **32**

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

1. finish pilot R4 for Bournemouth/Sevilla after round 264301 settles;
2. complete Ligat Ha'al (only one canonical creation remains, then attest the
   nine existing mapped-but-unattested clubs);
3. complete Premier League;
4. complete Bundesliga;
5. complete La Liga;
6. complete Serie A;
7. run full five-league collision/readiness audit;
8. only then promote the five competitions from `validating` to `supported`.

This order gives a small first complete league and repeatedly exercises all
three onboarding classes before the larger European catalogs are finished.

No M2B or Match Ledger ingest permission is granted by this inventory.