# V4 Ligat Ha'al Identity Onboarding — Execution Record

Date: 2026-10-31  
Decision: D-059  
Competition: Ligat Ha'al / Sportmonks 372  
Scope: identity onboarding only. No provider ingest, fixture mint, Match Ledger write or M2B activation.

## 1. Evidence

Official / independent sources:
- Israel Football Association league/team data:
  `https://www.football.org.il/leagues/league/?league_id=40`
- Maccabi Tel Aviv IFA team page:
  `https://www.football.org.il/team-details/?season_id=7&team_id=1061`
- Sportmonks official Europa League team-ID reference:
  `https://www.sportmonks.com/football-api/europa-league-api/`
  - Maccabi Tel Aviv = Sportmonks team `2997`

Existing production mappings were cross-checked against API-Football and/or
football-il-parse where available. The existing Sportmonks mapping itself was
not treated as independent evidence.

## 2. Existing mapping promotions — completed 9/9

Every promotion ran in its own transaction with:
- `lock_timeout = 5s`;
- `kapiloto.identity_operator = on`;
- `teams`, `team_aliases`, `provider_team_mappings` locked in
  `SHARE ROW EXCLUSIVE`;
- normalized canonical/alias/provider-name collision audit;
- provider-qualified exact-old predicates;
- Sportmonks injectivity check;
- `confirmed -> manual_override`;
- existing confidence `1.0000` preserved.

| SM id | Canonical | duplicate audit SHA-256 |
| ---: | --- | --- |
| 8644 | בני סכנין | `fd2ca9c709ec098ad6790f9c2f3cdb2b559cdbb90c4b864f6ee4c890b8810cfb` |
| 2495 | הפועל חיפה | `d89226bf0e519d9ba9c9e1a69567a85b779dc245ce648b68dd7ac72cc1d883b0` |
| 3229 | הפועל ירושלים | `360bef174e1d39dfffa47519b22469ca38cd0039ab67a3e440cfb151d4da7987` |
| 6961 | הפועל קרית שמונה | `3d1c5c62fe10a210a50fb949d2e5e0460e736273d9e46ae358c6d36515f23de9` |
| 2987 | הפועל רמת גן | `3477811485df7c4881b951aed9827295552a3a6651a00b9c65219f6618f5595a` |
| 6963 | הפועל תל אביב | `2f0e9b72d71f66c4aefb93c8b49b79b62650ed94305120ce94f436e94057660c` |
| 4136 | מכבי נתניה | `37bab71bdd1f4a8bc6f88e8777344145ce2d8016f3c4d143cfb79180a0152a96` |
| 3074 | מכבי פתח תקווה | `1cbc21b8f5f29785ea37a5c09a82ec311cf89d4805f1d054b6e3d20838680bda` |
| 6810 | עירוני טבריה | `43899748bc69dab1f13c66e302f7fb5e093e1bef62659f976b7d11430c749f92` |

## 3. Maccabi Tel Aviv creation — completed

Pre-write duplicate audit searched all:
- canonical team names;
- aliases;
- provider names/mappings;
- country-independent candidates;

for:
- `מכבי תל אביב`
- `מכבי ת"א`
- `Maccabi Tel Aviv`

Result: zero candidates.

First attempt was intentionally rolled back by PostgreSQL because
`team_aliases.normalized_alias` is a generated column and the operator SQL
attempted to provide it explicitly. Post-error verification showed zero team,
mapping and attestation rows for Sportmonks 2997.

The corrected transaction omitted the generated column and committed:

- canonical team id:
  `ff73883e-6c8a-4840-98f6-f9683e967e31`
- canonical name: `מכבי תל אביב`
- country: `IL`
- aliases:
  - `מכבי תל אביב`
  - `מכבי ת"א`
  - `Maccabi Tel Aviv`
- Sportmonks mapping:
  - provider team id: `2997`
  - provider name: `Maccabi Tel Aviv`
  - status: `manual_override`
  - confidence: `NULL`

Duplicate audit SHA-256:
`122eb906814815b22f05c9f61981d0244d7e82a048cd3454d61f852c7d74a05e`

## 4. Team attestations — completed 10/10

All attestations:
- ran separately;
- used `multi_source_verified`;
- used evidence contract
  `kapiloto-provider-identity-attestation-evidence-v1`;
- included the locked duplicate-audit SHA;
- stored IFA and cross-provider evidence as applicable;
- are attestation version 1.

| SM id | Canonical | event id | generation id |
| ---: | --- | --- | --- |
| 8644 | בני סכנין | `83d58e66-2b65-4627-89ee-31df928f2407` | `9213c48d-5771-41e9-8b2b-ecd0285c9d30` |
| 2495 | הפועל חיפה | `ca3de862-1a29-4c9b-abe2-a6135b6ba1ae` | `376ec27a-6fe0-43fa-b452-95efd598f797` |
| 3229 | הפועל ירושלים | `934293f1-7e5e-4556-b0e0-6992a7821dc6` | `d5e91cde-e515-41db-9abc-73ecbac40978` |
| 6961 | הפועל קרית שמונה | `dbf1b175-f17e-40a3-9f41-feee38e6cde4` | `45da0639-aed7-415d-bbaf-45e6b67c95ea` |
| 2987 | הפועל רמת גן | `7ded8581-0ac1-49be-892f-b819927864e5` | `0849739a-b7df-4f20-9f18-32abd91810ae` |
| 6963 | הפועל תל אביב | `683a51af-4b2d-4ba0-9e80-f97a3dfa92bd` | `2430d1fd-06bc-4a6f-9b38-976ec3a0891b` |
| 4136 | מכבי נתניה | `455b0f91-299c-438f-8c55-3f8bfe94a4b6` | `9d067fb5-d384-46d4-afa8-c621aae022c4` |
| 3074 | מכבי פתח תקווה | `182f3f4e-3305-4190-80e8-33e816403d7c` | `da0e60fe-05ad-4af5-b4da-ef7992d40fdc` |
| 6810 | עירוני טבריה | `b2a5931c-994c-4f92-9b3b-490326dc1f41` | `40e9f437-77fc-479a-8378-33cf26e3c60d` |
| 2997 | מכבי תל אביב | `73d87508-0e2a-4ac6-ab0b-5475eab3594e` | `2566ffc5-dd1d-42cc-a21b-ccb5c9adead2` |

The four pilot identities already attested before this operation were:
- Hapoel Be'er Sheva 516
- Maccabi Haifa 571
- Beitar Jerusalem 589
- Hapoel Petah Tikva 6900

## 5. Final Ligat Ha'al identity state

Production post-check:

- current canonical IL teams: **14**
- Sportmonks mapped: **14/14**
- `manual_override`: **14/14**
- active V4 team attestations: **14/14**
- Ligat Ha'al competition attestation: active
- blocking identity issues: **0**
- Sportmonks provider-ref conflicts V2: **0**
- normalized canonical duplicates: **0**
- V1 ingest service-role execute: **false**
- V2 ingest service-role execute: **false**
- provider ingest runs: **0**
- fixture mints: **0**
- Match Ledger observations: **0**

Global active team attestations after the operation: **28**.
Global active competition attestations: **5**.

## 6. Status

Ligat Ha'al is now **identity-complete** for the D-059 2026/27 launch
membership.

It remains registry state `validating`, not `supported`, because D-059 also
requires provider-family semantics/coverage and historical ingest quality gates
for the features that V4 will expose.

No M2B activation is authorized by this execution record.