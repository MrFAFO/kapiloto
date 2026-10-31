# V4 Premier League Identity Onboarding — Phase 1 Execution Record

Date: 2026-10-31  
Decision: D-059  
Competition: Premier League / Sportmonks league 8  
Scope: identity onboarding only. No provider ingest, fixture mint, Match Ledger write or M2B activation.

## 1. Immutable Sportmonks season-roster capture

The operator-dispatched read-only workflow ran successfully from `main`:

- workflow: `Kapiloto V4 Sportmonks Season Roster Capture`
- workflow run: `41202611579`
- workflow head: `589ee761e3232ed8f8a88de9d3eb8f3b3ee59e77`
- artifact id: `13043202540`
- artifact name: `kapiloto-v4-sportmonks-season-roster-8`
- artifact ZIP digest:
  `sha256:ec674031fa3e99da48b54a0af718652b98f837ef1dddfa556529908b79a39cb7`
- league: `8 / Premier League`
- current season: `28083 / 2026/2027`
- current-season flag: `true`
- team count: `20`
- duplicate provider names: `0`
- league raw SHA-256:
  `e0dfb07d980fd35b631038b5473b75d44e511e5e74dbca1aa729278aff4d3161`
- season-team raw SHA-256:
  `ff3955e368797b5c39aec38cbc3d42f5a9ed25b93eb296a791f5d3b2cbb1281e`
- normalized team-set SHA-256:
  `e864984e5ea7649c2589e76de56c4be95b6be8554e7ccdf09ffe9f68b17c32d9`

The capture used the Sportmonks account API at runtime rather than copying
provider IDs from a public marketing page.

Important discrepancy resolved by this capture:

- live Sportmonks season API: `Sunderland = team 3`
- a public Sportmonks page had shown `Sunderland = 27`

The API capture is the accepted provider identity authority. Production already
had Sunderland `3`, and no remap was performed.

The 2026/27 membership set was independently checked against the official
Premier League club list:
`https://www.premierleague.com/en/news/4365156`.

## 2. Active-round containment

Production still had Winner 16 round `264301` in status `open` during this
operation.

The active round contained these Premier League games:

- Liverpool — Arsenal
- Coventry — Sunderland
- Hull — Ipswich
- Bournemouth — Leeds

The four Class-B identities that would require a **new** Sportmonks mapping
were therefore deliberately not written:

| Sportmonks | Existing canonical | Canonical id |
| ---: | --- | --- |
| 8 Liverpool | ליברפול | `aecaaa05-2dac-4190-b443-f985457f9443` |
| 19 Arsenal | ארסנל | `1a6b21ee-d16b-4cf1-a2e5-ff5a1cbf6eb8` |
| 52 AFC Bournemouth | בורנמות' | `fcd3541d-c509-4d27-ac8d-6c403ef629e1` |
| 116 Ipswich Town | איפסוויץ' | `eefba343-60da-4cb7-ae01-78a539747db6` |

This preserves the earlier R4 rule: do not let a new provider-team mapping
change V3 fixture-mapping behavior for a live Winner round.

Existing Sportmonks mappings for Coventry, Sunderland, Hull and Leeds were
already visible to V3 before this operation; promoting/attesting those existing
identities does not create a new provider-team mapping.

## 3. Class A — existing canonical + existing Sportmonks mapping

Six mappings were promoted from `confirmed` to `manual_override`.

Every promotion ran in its own transaction with:

- `lock_timeout = 5s`;
- `kapiloto.identity_operator = on`;
- `teams`, `team_aliases`, `provider_team_mappings` locked in
  `SHARE ROW EXCLUSIVE`;
- normalized canonical/alias/provider-name duplicate audit;
- provider-qualified exact-old predicates;
- Sportmonks injectivity check;
- legacy confidence `1.0000` preserved.

| SM id | Canonical | Duplicate audit SHA-256 |
| ---: | --- | --- |
| 11 Fulham | פולהאם | `1d5314e89e20fb17dcad3cf28ce74975d42812895922320395867c99f343cf4b` |
| 20 Newcastle United | ניוקאסל | `520282a0236bcd0ba919b6bdee7d836967d9798efe4d366b3c4592c953ace698` |
| 22 Hull City | האל | `d41768071495d16647afffd28171d4a2f75c47e96f7684dbc26e75c177bd4e27` |
| 51 Crystal Palace | קריסטל פאלאס | `7194d02632e047d5cd01059df7e64aee3e08fd3d6fa1c484173231b2c290299e` |
| 117 Coventry City | קובנטרי | `8cce104a7d26a3b176a590077bf84d2a8f78c530952c0019b28fb1b3f39f5941` |
| 236 Brentford | ברנטפורד | `1418aefdfcd38ff332f90b86deef409a04eda056de25580907240b4c6810248b` |

All six were then attested separately with basis `multi_source_verified`,
using:

- the immutable Sportmonks season-roster capture;
- official Premier League 2026/27 membership;
- existing API-Football cross-provider identity;
- reviewed Hebrew-English equivalence.

| SM id | Event id | Generation id |
| ---: | --- | --- |
| 11 | `0a237097-c7e3-4205-9669-2a553560733e` | `958b7250-46bc-40e3-9e00-940b4de91821` |
| 20 | `be1bd256-5553-4612-8d96-3270007c4300` | `63580d59-632d-48e1-8579-4ea2aa00db48` |
| 22 | `59a9fd13-9c73-474f-bbd0-c880c445f896` | `9afc7d2b-3b09-4cc8-99f2-433a659ffc0b` |
| 51 | `e1532b7a-10e6-4d17-8b14-123cc8656190` | `33e4a1c0-e642-4eaf-8e7a-2bb36fdfd98d` |
| 117 | `8d91a659-0278-4f78-bcc3-bd75a36ec0da` | `79a804d5-5ade-4e72-8cf6-ec261db29458` |
| 236 | `dfb2af84-ae9c-4375-98a9-71aadade11e4` | `ab7d4de8-5d1b-4fef-8fb5-6de4b63fa32a` |

Every attestation is version 1.

## 4. Class C — canonical team missing

Seven identities had zero candidates in the all-country
canonical/alias/provider-name duplicate audit and no existing Sportmonks
provider ID.

Each create ran in its own locked transaction and created:

- exactly one canonical `GB` team;
- a preferred Hebrew alias using Telesport/Winner-compatible spelling;
- the exact Sportmonks provider name as an English alias;
- reviewed Hebrew variants where useful;
- one Sportmonks `manual_override` mapping;
- `mapping_confidence = NULL`.

| SM id | Canonical | Canonical id | Duplicate audit SHA-256 |
| ---: | --- | --- | --- |
| 6 Tottenham Hotspur | טוטנהאם | `fdcae309-0d78-4726-b579-389844aed663` | `d59966c668b9a1ac7a7476ee51a9ae5b37cfee5d0e0578d44b85c3aa954d8e2d` |
| 9 Manchester City | מנצ'סטר סיטי | `a94c0e03-4b9c-4a78-91b1-e74955c7936b` | `b7518bc2e18b1810119baead37857a56b2f0cbcf2b9d5662ec296c9a783fcc82` |
| 13 Everton | אברטון | `559de536-9902-4170-95ff-f85628124733` | `eaaf3687d2a142da19e33bab65c04a78c0221a44bda1ac29508e4c24e9be800f` |
| 15 Aston Villa | אסטון וילה | `10cddcff-970a-44af-97b5-ce9339853f99` | `99f97029fea2d7532ab30335fff55d25d913d3470cf5537b77985ecd4fa82fe7` |
| 18 Chelsea | צ'לסי | `43049c56-758c-417d-9b0a-d5b89e612ca6` | `d8f19a2a0aef01a0bfa5923abdd8dfe953b3260b0bf99cbe40de6a1ded9c95f3` |
| 63 Nottingham Forest | נוטינגהאם פורסט | `f224079b-b0b4-4d47-b4a0-8b631304f423` | `fbd4ae37e47d3df626299592885196205a5313c0c231735944eed8523440a541` |
| 78 Brighton & Hove Albion | ברייטון | `0cb348fb-2518-4391-b5ac-b2a80c53755c` | `3375e43ba35354a8f8f3afde26cc179444f15e148caad9668e2d2b9722a934c8` |

All seven were attested separately using:

- the immutable Sportmonks season-roster capture;
- official Premier League 2026/27 membership;
- Telesport Hebrew identity/name evidence;
- reviewed name equivalence.

| SM id | Event id | Generation id |
| ---: | --- | --- |
| 6 | `a2f30ec5-e5c6-4bee-b424-457bae983f6c` | `94ef6c4d-5259-4421-bd1f-8b06ef415f25` |
| 9 | `1ef424a9-5f00-4071-b8f8-90c4f2ca58e2` | `a2d0b89d-a17d-4d36-9cda-067e9437565a` |
| 13 | `b02813ab-803a-4aa7-bdd3-b3d5f3d65a95` | `3f601ae6-9238-4d9e-8ad9-01aa7ecc96c6` |
| 15 | `7a3623a7-ea25-4ec0-a0d3-c84a2934a781` | `3a6a65c7-dca9-4eee-bc84-cd9d6925be3d` |
| 18 | `f8deb0e9-db0e-4409-a789-a2f35dac789d` | `5f387e88-fb20-4471-a022-63242745a1f4` |
| 63 | `757a567b-e4b6-4242-a886-4be6c32c5396` | `8e7b23e3-e0e5-4f7a-9e1e-c075655872af` |
| 78 | `c6bad3f8-ec2e-4104-b02b-d1d24973888e` | `d7d40d89-8807-46dd-8ff2-3d3b88d91ef4` |

Every attestation is version 1.

## 5. Previously attested Premier League identities

The pilot had already completed:

- Sportmonks 3 — Sunderland
- Sportmonks 14 — Manchester United
- Sportmonks 71 — Leeds United

These remained unchanged.

## 6. Phase-1 post-check

Premier League current-season roster:

- roster identities: **20**
- canonical teams present: **20/20**
- Sportmonks mapped: **16/20**
- `manual_override`: **16/20**
- active V4 team attestations: **16/20**

Remaining only:

- Liverpool 8
- Arsenal 19
- AFC Bournemouth 52
- Ipswich Town 116

Global checks after phase 1:

- blocking Sportmonks identity issues: **0**
- Sportmonks provider-ref conflicts V2: **0**
- normalized canonical-name duplicates: **0**
- V1 ingest service-role execute: **false**
- V2 ingest service-role execute: **false**
- provider ingest runs: **0**
- Match Ledger fixture mints: **0**
- Match Ledger observations: **0**
- active team attestations: **41**
- new Sportmonks `provider_fixture_mappings` since roster capture: **0**

## 7. Status

Premier League identity onboarding is **16/20 complete**.

The four deferred Class-B mappings must be revisited only after Winner 16 round
`264301` is no longer active. Their provider IDs are already frozen by the
Sportmonks season-roster capture; the remaining operation is:

1. rerun locked duplicate audits;
2. insert each exact Sportmonks `manual_override` mapping with confidence NULL;
3. add the reviewed English provider alias where absent;
4. attest each identity separately;
5. rerun the full Premier League 20/20 post-check.

Premier League remains registry state `validating`, not `supported`.

No provider ingest, fixture mint, Match Ledger observation or M2B permission
was created by this phase.