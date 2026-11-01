# V4 Bundesliga Identity Onboarding — Execution Record

Date: 2026-11-01  
Decision: D-059  
Competition: Bundesliga / Sportmonks league 82  
Scope: identity onboarding only. No provider ingest, fixture mint, Match Ledger write or M2B activation.

## 1. Immutable Sportmonks season-roster capture

Operator-dispatched workflow run:

- workflow: `Kapiloto V4 Sportmonks Season Roster Capture`
- run id: `41293846944`
- head: `db03bdd84c0525cc5ac018ad0f93dbde886ec3df`
- artifact id: `13079030219`
- artifact: `kapiloto-v4-sportmonks-season-roster-82`
- artifact ZIP digest:
  `sha256:3fe87fc6b165c92c47bcce613fc50e4fd12ebdad1cd1473554a8c03e861d538a`
- league: `82 / Bundesliga`
- current season: `28321 / 2026/2027`
- team count: `18`
- duplicate provider names: `0`
- league raw SHA-256:
  `7bf2ee94cebfd7071eeb16198a3ded19a5208a19e4661fab2b618dffaa8be7e0`
- season-team raw SHA-256:
  `c4449ca7cac0f888b77cd3fe45d01c5cb58bba99fe4d96c60a0fdbbec91d076f`
- team-set SHA-256:
  `7119ee57fcba90e282b436a6b2599d6522e653148d744ed7bfdb10d175d35795`

Official 2026/27 membership was cross-checked against:
`https://www.bundesliga.com/en/bundesliga/clubs`.

Winner/Telesport-compatible Hebrew spellings were independently checked before
canonical creation.

## 2. Active-round containment

At execution time Winner round `264301` was the only round in an active-like
state (`under_review`).

None of its 16 games contained a Bundesliga club. Therefore creating the ten
missing Bundesliga provider-team identities could not change V3 fixture
resolution for that round.

No new Sportmonks `provider_fixture_mappings` were created by this operation.

## 3. Class A — existing canonical + existing Sportmonks mapping

Four mappings were promoted from `confirmed` to `manual_override`, preserving
their existing confidence `1.0000`.

Each ran in its own locked transaction with provider-qualified expected-old
predicates, normalized duplicate audit and Sportmonks injectivity checks.

| SM id | Canonical | Duplicate audit SHA-256 |
| ---: | --- | --- |
| 67 Schalke 04 | שאלקה 04 | `732c1f221e428c2c37c4b7fb11c922e3741ccd8c5e884be145d6b26aeab95f3d` |
| 2642 Paderborn | פאדרבורן | `f2525f353e52e0c96d8032b04d18dde5469828e95a7f30679c2b0b4aff168e97` |
| 2708 Hamburger SV | המבורג | `02295dce4c96a802247a1221d93603b0bf530440c876c1aadaa2a0dca5880bd9` |
| 3320 FC Köln | פ.צ. קלן | `f5056b2785805e3551d68c801f2541cecdbc9ad9a3bfb253904db2ccdb46ac33` |

All four were attested separately with the immutable Sportmonks roster capture,
official Bundesliga membership and API-Football cross-provider identity.

| SM id | Event id | Generation id |
| ---: | --- | --- |
| 67 | `64513c11-5c6a-4d86-8203-8b60a5422e0e` | `b41f06ce-a733-4811-a251-96664826cfe5` |
| 2642 | `eaf65ee4-a447-4d0a-95ee-c72488434dc5` | `eb9fee8f-81d7-4f54-8b2b-971609e85220` |
| 2708 | `adc04d6f-9470-4d72-a1c9-d5fd750629be` | `c7c17c3a-3919-4618-a0a4-aef1108beb4e` |
| 3320 | `833db46d-65f1-4ef0-8893-c6b6fccf9977` | `d4f603a4-eac1-407a-b356-15579b1abe6f` |

All are attestation version 1.

## 4. Class C — canonical team missing

Ten identities had zero canonical/alias/provider-name duplicate candidates and
no existing Sportmonks provider ID before creation.

Each was created in its own locked transaction with one canonical `DE` team,
reviewed Hebrew alias, exact Sportmonks English alias and one
`manual_override` Sportmonks mapping with `mapping_confidence = NULL`.

| SM id | Canonical | Canonical id | Duplicate audit SHA-256 |
| ---: | --- | --- | --- |
| 68 Borussia Dortmund | בורוסיה דורטמונד | `2a8a8065-d916-41e8-881f-7eadf758d2f3` | `a1dde3e6e9dd6ece87660782e11e29f489519bcfb942f40f895db8c17b77114e` |
| 82 Werder Bremen | ורדר ברמן | `e737f2c2-c317-41f0-bd05-ed71d84a65bc` | `56a0ca6bff7dfab8cb0c878b7a4456477b2a051b7ea72d5ab3e759ed02c2e50f` |
| 90 FC Augsburg | אוגסבורג | `9b48849e-a12c-43a3-9ecb-b56e9d20c1d8` | `e5040d70231a38211f17b2a87bdc610ebdb9860ec8b207185123af1e987ace55` |
| 277 RB Leipzig | ר.ב. לייפציג | `3a8f226c-a2ef-4112-ad2c-af16e8505565` | `02c0dda89f7a000b14c4e76744192e5b44cff39fd0534150209eabdc5a5a6e67` |
| 366 Eintracht Frankfurt | איינטרכט פרנקפורט | `f6846762-1890-4b83-b9f3-1d572fd6e0bd` | `d42804a9510a685bcc6107d3ca3f2f2bc3bcd1f8a8700657af3b041d3f27a80c` |
| 683 Borussia Mönchengladbach | מנשנגלדבאך | `4dd81c8b-2c79-4457-a640-4b6a5b76dfdb` | `528197e8ae6c27dd2b353aeac54984c84ee3819a15403d77875150357afa404d` |
| 794 FSV Mainz 05 | מיינץ | `2243b362-66a8-4082-945a-759cbe48dd64` | `87b9d57a1b4db052b9c105df98e8c4dcf572a76d7090ee998c4fa2f539867cd3` |
| 1079 FC Union Berlin | אוניון ברלין | `3db1b336-044a-4ac8-968c-980d5fd5e87b` | `81d0750024e07cbe87fad4931981695a84d3d6e6bd39e972631e83699e237e6d` |
| 3319 VfB Stuttgart | שטוטגרט | `69bcbb3c-7335-4ab1-952f-894e0dfa9d06` | `8d574d3ff9bcfcbbcf942fbdecb8877f891f57731f1b8e2d1bc4b6842957d17a` |
| 3588 Elversberg | אלברסברג | `2232e7b8-45ad-4d72-aa46-51decc2b9d0c` | `e87177dd32fc7fe7b9381d4744a8bf41abda36389cc8b8db7c71e729fed8307b` |

All ten were attested separately with:
- immutable Sportmonks season roster;
- official Bundesliga membership;
- Telesport Hebrew identity evidence;
- reviewed name equivalence.

| SM id | Event id | Generation id |
| ---: | --- | --- |
| 68 | `2b9448cf-7cbe-469e-9e47-358e3de9ccb5` | `fd082702-405a-4adf-a3dd-5175efa742e0` |
| 82 | `e1e7a314-3166-43c8-b3fb-0324359e919c` | `a3f53270-a4ff-4478-8530-22811060441c` |
| 90 | `70abc786-8280-4378-8464-852190c7fca3` | `2c6c467b-20be-4f81-b87d-56d54b1a0f78` |
| 277 | `83a0c685-65d8-4b57-a513-e12fa5ab303e` | `54d9357d-4214-464b-8d69-5778fa4f2a56` |
| 366 | `4e57bd24-7218-42e9-85eb-cfdba179335e` | `d5c6ebf8-4c63-49c5-aa9d-0fe0ec35bce9` |
| 683 | `daa82500-a79d-48b7-bba5-68ee3f1959dd` | `d226afb4-b14c-4f22-a011-bc53803915ed` |
| 794 | `7223d59f-4ecf-4c53-a5df-b888780ebd58` | `7ea08b11-0da4-4f2f-aa4c-0e3c636aef2f` |
| 1079 | `b123bb32-4ba5-4ff7-8a72-cb2155731a41` | `a66992d1-06ba-4623-80e5-82cc8e0de7d3` |
| 3319 | `bc5c7498-924a-4a99-9931-0089efb8724d` | `65172d1a-97e4-469d-9191-8d8bdf2279e2` |
| 3588 | `ac7a4932-1499-4ac9-a923-c8ce986b7abb` | `e930bbd4-dbd5-479c-bb1e-c8534d1aacef` |

All are attestation version 1.

## 5. Previously attested Bundesliga identities

The pilot had already completed:

- 503 FC Bayern München
- 2726 TSG Hoffenheim
- 3321 Bayer 04 Leverkusen
- 3543 SC Freiburg

These remained unchanged.

## 6. Final Bundesliga identity state

Post-check:

- current-season roster: **18**
- Sportmonks mapped: **18/18**
- `manual_override`: **18/18**
- active V4 team attestations: **18/18**
- blocking Sportmonks identity issues: **0**
- Sportmonks provider-ref conflicts V2: **0**
- normalized canonical duplicates: **0**
- new Sportmonks provider-fixture mappings since roster capture: **0**
- V1 ingest service-role execute: **false**
- V2 ingest service-role execute: **false**
- provider ingest runs: **0**
- Match Ledger fixture mints: **0**
- Match Ledger observations: **0**
- global active team attestations after operation: **55**
- active competition attestations: **5**

## 7. Status

Bundesliga is now **identity-complete 18/18** for the D-059 launch universe.

Registry state remains `validating`, not `supported`, because provider-family
coverage, historical ingest quality and the remaining V4 production gates still
apply.

No M2B permission was created by this operation.