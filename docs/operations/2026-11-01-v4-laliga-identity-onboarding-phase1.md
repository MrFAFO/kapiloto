# V4 La Liga Identity Onboarding — Phase 1 Execution Record

Date: 2026-11-01  
Decision: D-059  
Competition: La Liga / Sportmonks league 564  
Scope: identity onboarding only. No provider ingest, fixture mint, Match Ledger write or M2B activation.

## 1. Immutable Sportmonks season-roster capture

Operator-dispatched workflow run:

- workflow: `Kapiloto V4 Sportmonks Season Roster Capture`
- run id: `41294737035`
- head: `4a45d53c3e4c0c0ca3a8bd69a8fd37ed8264f2f8`
- artifact id: `13079016059`
- artifact: `kapiloto-v4-sportmonks-season-roster-564`
- artifact ZIP digest:
  `sha256:94773815bdea86f70c284f160b18de4d0a9fea10c40e0090276a9ca6522ddb25`
- league: `564 / La Liga`
- current season: `27965 / 2026/2027`
- team count: `20`
- duplicate provider names: `0`
- league raw SHA-256:
  `4d18ca3f2415eab83025a78be8df1c18fca331acbde693cea4eb7797bcf5ebe3`
- season-team raw SHA-256:
  `dedae5ddafb11a0b3696922d448bdfd4a6bcae0651d599359528f5b02b28ebfc`
- team-set SHA-256:
  `40b74af3f2c0695f6dbe04991b9048efe543bea2b24b318c103a8dd5fc5ab3e6`

Official 2026/27 membership was cross-checked against:
`https://www.laliga.com/en-US/laliga-easports/clubs`.

Telesport/Winner-compatible Hebrew spellings were independently checked before
canonical creation.

## 2. Active-round containment

Winner round `264301` remained `under_review`.

Its current games include six La Liga canonical teams for which adding a new
Sportmonks provider-team mapping could alter V3 fixture resolution:

- game 11 — Rayo Vallecano
- game 12 — Getafe / Sevilla
- game 13 — Elche
- game 14 — Athletic Club / Real Sociedad

Therefore the six Class-B identities below were deliberately not written:

| SM id | Existing canonical | Canonical id |
| ---: | --- | --- |
| 106 Getafe | חטאפה | `9f672e5a-5644-4f90-8e12-8c4f55db46c0` |
| 377 Rayo Vallecano | ראיו ואייקאנו | `20b1942a-068f-49b7-b0f3-169741ecec43` |
| 594 Real Sociedad | ריאל סוסיאדד | `71971f07-cdcc-4a62-973c-ddedf1524907` |
| 676 Sevilla | סביליה | `f1cc2c0b-b7a3-40f7-a18f-423fdc71344b` |
| 1099 Elche | אלצ'ה | `2b1d092a-7ee9-441b-acd3-e053cde9262b` |
| 13258 Athletic Club | אתלטיק בילבאו | `e5619a70-7bf3-42da-a155-e03cfbbbcb18` |

These remain the only missing La Liga Sportmonks mappings after phase 1.

## 3. Class A — existing canonical + existing Sportmonks mapping

Six mappings were promoted from `confirmed` to `manual_override`, preserving
legacy confidence `1.0000`.

Every promotion ran in its own transaction with:
- `lock_timeout = 5s`;
- `kapiloto.identity_operator = on`;
- `teams`, `team_aliases`, `provider_team_mappings` locked in
  `SHARE ROW EXCLUSIVE`;
- normalized canonical/alias/provider-name duplicate audit;
- provider-qualified exact-old predicates;
- Sportmonks injectivity check.

| SM id | Canonical | Duplicate audit SHA-256 |
| ---: | --- | --- |
| 36 Celta de Vigo | סלטה ויגו | `8fd8d5176cb302102a59c5aca8eef8ee143f8468eb620251b8bc5ecf0cee76e7` |
| 214 Valencia | ולנסיה | `44750855ba3e76d1ba7eae84dc819fdaee18474449154f4aff097062768a4cda` |
| 485 Real Betis | בטיס | `c76a14a929375858a3f3a913dd09c9d8a3b197fa0216cf98427544aaf8715964` |
| 528 Espanyol | אספניול | `14ecbd237d92bfcecb3b80663a4c3eda267f39d6f246bc702f4b88b264030b65` |
| 3477 Villarreal | ויאריאל | `fc11bf64e48694220329e8b28c4468a638e452c8afc43c51f88cdfe100f3a626` |
| 9818 Racing Santander | ראסינג סנטאנדר | `d8f505dd5fd3af0cff8ddcd7d34b9d3f12fb7419c6c82064b23b27dd66ee7f89` |

All six were attested separately using:
- immutable Sportmonks season roster;
- official La Liga membership;
- API-Football cross-provider identity;
- reviewed name equivalence.

| SM id | Event id | Generation id |
| ---: | --- | --- |
| 36 | `74651f78-d20d-428b-88db-6576276d11d4` | `970871c2-7d53-44a4-8ecf-dfe9b5352239` |
| 214 | `f2b78016-b541-43d6-9688-a4caaa234062` | `a6eb3074-cbdc-45ea-b804-e454d43bed90` |
| 485 | `8212530f-fde7-4eb0-b39d-190f36b49fc7` | `517947c5-571b-45b1-b7da-fdfc61a084b4` |
| 528 | `c73e9279-8a66-405e-ab57-3ca8798630b3` | `a9c71371-6f4e-4614-bea5-e0ca8a57e991` |
| 3477 | `730b1f66-b8ce-4f36-872e-781268f1406d` | `ef9bb2d9-4564-444a-a4c4-861f74f6a311` |
| 9818 | `15998dd4-ed49-4cd7-8c18-2a2f58f1e5db` | `54b200da-bb43-4f93-aa76-8f19bd082b66` |

All are attestation version 1.

## 4. Class C — canonical team missing

Five identities had zero canonical/alias/provider-name duplicate candidates and
no existing Sportmonks provider ID before creation.

Each was created in its own locked transaction with:
- exactly one canonical `ES` team;
- reviewed Hebrew alias;
- exact Sportmonks English alias;
- reviewed official/provider variants where useful;
- one Sportmonks `manual_override` mapping;
- `mapping_confidence = NULL`.

| SM id | Canonical | Canonical id | Duplicate audit SHA-256 |
| ---: | --- | --- | --- |
| 126 Málaga | מלאגה | `3ff2bdb9-50b2-4658-baab-56b345e85c43` | `ad53446c116eb68b042689518158825cf9f7e8b84eeec592260cff3a457a7ef0` |
| 429 Deportivo A Coruña | דפורטיבו לה קורוניה | `0cd6c3aa-0148-4be9-b4a6-d5f5be118710` | `23edd2fddb10814a54d3d9d535dfcb28b005bd0f43c0b32885b066465e5d023a` |
| 2975 Deportivo Alavés | אלאבס | `700e4859-a3df-4e8c-a542-96c1ed66c4a0` | `486ad172d1acce53a4cdba0c1eedc00f4ac607e717bcda8a59662e31a9d15898` |
| 3457 Levante | לבאנטה | `dd5e219b-74e7-4b3f-bc4e-8f7b47b15bce` | `392799083c41fce7dbb8a5f3b16c09c72b1555d12cf58fed2bc3b5a5b4450383` |
| 7980 Atlético de Madrid | אתלטיקו מדריד | `e6a949a1-52b8-4a78-a177-2b30ffc69a93` | `93b30a2735ff75123b00dd63084328028ab9404ffde40d58fa3d72853597ab9f` |

All five were attested separately with:
- immutable Sportmonks season roster;
- official La Liga membership;
- Telesport Hebrew identity evidence;
- reviewed name equivalence.

| SM id | Event id | Generation id |
| ---: | --- | --- |
| 126 | `31a45b2d-8b38-45d5-8ab9-53b384650717` | `1e30b4c8-e8e8-4875-815e-d36749075885` |
| 429 | `c3a65510-a1b1-422e-9076-e6aa3fb483a1` | `e7373650-a49a-462c-a39b-dabf533e4d9a` |
| 2975 | `dbd71b20-9f0e-40d5-9b16-14038a58921f` | `a9cc849e-3e61-4a7e-8622-2403c6ee7928` |
| 3457 | `663d6c1c-9b2e-4c0c-bda0-537b0bced8f0` | `8aa7628e-94f8-4a73-b73a-1261387f47be` |
| 7980 | `123cda2b-52a5-4899-ba49-e651d2abce43` | `5647eef8-13ad-412b-a12b-ed381219b629` |

All are attestation version 1.

## 5. Previously attested La Liga identities

The pilot had already completed:

- 83 FC Barcelona
- 459 Osasuna
- 3468 Real Madrid

These remained unchanged.

## 6. Phase-1 post-check

La Liga current-season roster:

- roster identities: **20**
- canonical teams present: **20/20**
- Sportmonks mapped: **14/20**
- `manual_override`: **14/20**
- active V4 team attestations: **14/20**

Remaining only:

- 106 Getafe
- 377 Rayo Vallecano
- 594 Real Sociedad
- 676 Sevilla
- 1099 Elche
- 13258 Athletic Club

Update 2026-11-03: Sevilla 676 was mapped and attested by pilot R4 after round 264301 settled. See `docs/operations/2026-10-31-v4-pilot-identity-reconciliation-execution.md` §8. La Liga is now 15/20. Getafe 106, Rayo Vallecano 377, Real Sociedad 594, Elche 1099 and Athletic Club 13258 remain.

Global checks after phase 1:

- blocking Sportmonks identity issues: **0**
- Sportmonks provider-ref conflicts V2: **0**
- normalized canonical-name duplicates: **0**
- new Sportmonks provider-fixture mappings since roster capture: **0**
- V1 ingest service-role execute: **false**
- V2 ingest service-role execute: **false**
- provider ingest runs: **0**
- Match Ledger fixture mints: **0**
- Match Ledger observations: **0**
- active team attestations: **66**
- active competition attestations: **5**

## 7. Status

La Liga identity onboarding is **14/20 complete**.

The six deferred Class-B mappings must be revisited only after Winner round
`264301` is no longer active. Their exact provider IDs and canonical targets are
already frozen.

La Liga remains registry state `validating`, not `supported`.

No provider ingest, fixture mint, Match Ledger observation or M2B permission
was created by this phase.