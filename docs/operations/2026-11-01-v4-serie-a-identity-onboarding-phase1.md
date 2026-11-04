# V4 Serie A Identity Onboarding — Phase 1 Execution Record

Date: 2026-11-01  
Decision: D-059  
Competition: Serie A / Sportmonks league 384  
Scope: identity onboarding only. No provider ingest, fixture mint, Match Ledger write or M2B activation.

## 1. Immutable Sportmonks season-roster capture

Operator-dispatched workflow run:

- workflow: `Kapiloto V4 Sportmonks Season Roster Capture`
- run id: `41309277420`
- head: `382334d84398233a56d92a9f720f540bf072a304`
- artifact id: `13084702085`
- artifact: `kapiloto-v4-sportmonks-season-roster-384`
- artifact ZIP digest:
  `sha256:28bf4ba65409b6ce1c50ad281ae993dbcb0fa0e9ae9e4b3a9db88686f9d576f2`
- league: `384 / Serie A`
- current season: `27895 / 2026/2027`
- team count: `20`
- duplicate provider names: `0`
- league raw SHA-256:
  `1b8d8d44807de90d33fe6bf18b477bee75c086716563ff2e01a452a647b553d2`
- season-team raw SHA-256:
  `6139a884bee377828c1e4760ee4122dc150eab698d870567f676450697b601c6`
- team-set SHA-256:
  `ab4d41933e56bb8b51a277ee18bfadf323dc13072e20ea1142ce70ab5a3c2b9a`

Official 2026/27 membership was cross-checked against:
`https://en.legaseriea.it/serie-a`.

Hebrew identity spelling was cross-checked against Telesport/Winner where
available and an independent 2026/27 Hebrew Serie A round listing.

## 2. Active-round containment

Winner round `264301` remained `under_review`.

Its Italian games were:

- game 15 — Milan / Inter
- game 16 — Juventus / Napoli

Milan, Inter and Napoli already had Sportmonks mappings before this operation.
Promoting and attesting those existing mappings did not create a new
provider-team mapping.

Juventus did not have a Sportmonks mapping. Therefore Sportmonks team `625`
was deliberately deferred:

- canonical: `יובנטוס`
- canonical id: `5818b519-2465-41c4-833b-5a559686539a`
- Sportmonks: `625 / Juventus`

No new Sportmonks `provider_fixture_mappings` were created during this
operation.

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
| 37 Roma | רומא | `969f391d604454768bf7872bd552a0d060ca2f81051c1c6cef1f780692b7f511` |
| 113 AC Milan | מילאן | `bc3c8ad497b8177e4642b1e3a5a434d5c22a995811f0f9ec4711c93bac392f37` |
| 585 Cagliari | קליארי | `d3bba77197da030291a371ffe18a388d943e22685725ea3e9f7ea1a385244c62` |
| 597 Napoli | נאפולי | `09c3835d8e9dc5e4574e8e0129c0d170da29873792f81f88b86666df5e952cf0` |
| 2930 Inter | אינטר | `efa355a7b8e49c85d6d5e5d4e8da3f3a52ae320cf332e49284ad1b1e9954702c` |
| 8513 Bologna | בולוניה | `3793de139afe59a1e3e1d6a0b275b76cf63e2e5fcfdd041df4ed3aadb7be8cd6` |

All six were attested separately. Evidence recorded:
- immutable Sportmonks season roster;
- official Serie A membership;
- existing Telesport/Winner alias provenance;
- API-Football cross-provider mapping as observed.

For Milan and Inter the API-Football evidence remained explicitly recorded as
`unverified` at confidence `0.9`; the attestation did not upgrade or rewrite
that legacy provider state.

| SM id | Event id | Generation id |
| ---: | --- | --- |
| 37 | `e5c8f427-aff0-4415-be70-31e290af5f82` | `18a4e59d-8ac1-4f50-bf8d-6722e7c18768` |
| 113 | `de20ad23-cff7-442a-950a-04a440523d71` | `86f1d85b-163f-481e-b344-920896254313` |
| 585 | `563b3b6b-81a6-4d73-8a77-31a9d1f58975` | `8d9443ec-dec8-40f2-99df-557b4248c6a1` |
| 597 | `5d72b92e-8406-45fd-8ba3-f1c8e3d3fc1f` | `210b2ee8-2b91-4a82-8a74-0192dfcaa6fd` |
| 2930 | `3062efcb-18d4-4732-a1b9-e473df32939b` | `d277cd77-11a0-4c79-867e-d7719cc2985f` |
| 8513 | `be8fc5e3-9600-40b6-b0f7-0e20a7f17712` | `c1cec086-6b22-4759-ac31-15dca1985384` |

All are attestation version 1.

## 4. Class C — canonical team missing

Nine identities had zero canonical/alias/provider-name duplicate candidates and
no existing Sportmonks provider ID before creation.

Each was created in its own locked transaction with:
- exactly one canonical `IT` team;
- one reviewed Hebrew alias;
- exact Sportmonks provider name as English alias;
- one Sportmonks `manual_override` mapping;
- `mapping_confidence = NULL`.

| SM id | Canonical | Canonical id | Duplicate audit SHA-256 |
| ---: | --- | --- | --- |
| 43 Lazio | לאציו | `95955358-cef1-4626-bf91-7e85a46d5443` | `c235823051ad514c88efbed7f2e91e3977c6b77d9434a7d35cd5042185fa169a` |
| 102 Genoa | גנואה | `c801e4e0-55a7-4292-ae03-936f61c421cc` | `36bcb9018b17fc38b7bfd02b5f11ebbc235b931126503b2b6ac71cff016227a1` |
| 267 Venezia | ונציה | `fdb5bf1f-8e84-4244-9b84-c230c3126e7d` | `92093263e13c9563b38f847ac13df3526e3126073a9667c6524feba71b1cb03b` |
| 268 Como | קומו | `568d318d-3231-4724-ac06-386440b3bb23` | `caa5d3cd88564db8680aaba5a16fb1ac9957cde0571ff9cd9819dc3f5bff1e15` |
| 346 Udinese | אודינזה | `f0167280-e3af-4669-9dd5-33302dc4a5bc` | `c2768f1fc49aa125d9a8e92267017ec9a14dfe2f6c72e4cb5453bd58f345373e` |
| 398 Parma | פארמה | `ebff217d-92d8-4faf-8ea5-27c6360f6e01` | `085fb0b1f79da9eff53c84cb3d2493b0a76de91c8107bc0f88732dc551740435` |
| 613 Torino | טורינו | `da2059ab-69df-4331-a6ef-de449526f137` | `61e2d8fb99854c3bd328cade021104095637dfa65708cdcf7cfeedbbc4d29d14` |
| 1628 Monza | מונצה | `56201037-a2fc-40e8-860d-ccaca5b81922` | `46c2d3a4e8618fdf24b73ffc00584da0cf978cf8f0b8eb2cbf997d72d6be65f2` |
| 2714 Sassuolo | ססואולו | `d7b2d7cf-f444-4bce-b9a8-e0d1adad3298` | `8bfd373287403db0ef463fb6d2d7d1386c55227d0e61cf6d35ba82b35be00648` |

All nine were attested separately using:
- immutable Sportmonks season roster;
- official Serie A membership;
- independent Hebrew identity evidence;
- Telesport evidence where directly available;
- reviewed name equivalence.

| SM id | Event id | Generation id |
| ---: | --- | --- |
| 43 | `8256a42e-982c-42d1-a193-be913e44a119` | `bc5acb69-27d6-498c-9b80-b13de74260c3` |
| 102 | `99fc3e01-a550-4eb4-9656-a90fc6d52bb8` | `3ac0b8c3-68e9-45fd-a6ca-a9697be4aec6` |
| 267 | `c04dca24-1c6e-4428-b81d-f7358410257f` | `5a863920-6b63-4754-9899-da1fcdaa4a73` |
| 268 | `7dd1bf1b-0897-4112-a142-ed2810ab01fc` | `8ac848b9-1be2-486b-9fc0-f7defb3ee738` |
| 346 | `7a6dd120-9297-4e3c-a722-69ba2aa3cc13` | `4b745159-95a1-4041-aa83-6e7c6feed64c` |
| 398 | `56adbb10-5db0-4a63-b3ec-a54d6c0ed6bb` | `7a8e3fc8-a260-4d9f-b7d3-d4b3ecc77e36` |
| 613 | `33da7e41-a078-40a0-a510-6e613bc6b2ee` | `61380d94-ab2c-483a-969f-8a1b70036743` |
| 1628 | `924c330e-106d-42ec-a8ba-6b841ca78b46` | `bca80403-1f60-4984-a8ae-e23d474f22b2` |
| 2714 | `f6b26a58-a98b-4fe7-b662-1e70a6e30233` | `663ed73e-6a1f-4d4a-be7b-7160cc2c5fee` |

All are attestation version 1.

## 5. Previously attested Serie A identities

The pilot had already completed:

- 109 Fiorentina
- 708 Atalanta
- 4070 Frosinone
- 7790 Lecce

These remained unchanged.

## 6. Phase-1 post-check

Serie A current-season roster:

- roster identities: **20**
- canonical teams present: **20/20**
- Sportmonks mapped: **19/20**
- `manual_override`: **19/20**
- active V4 team attestations: **19/20**

Remaining only:

- 625 Juventus — existing canonical `יובנטוס`

Update 2026-11-04: Juventus 625 was mapped and attested after round 264301 settled. It got:
- its own locked R4-pattern transaction;
- a `manual_override` mapping with confidence `NULL`;
- only the exact English Sportmonks alias `Juventus`;
- a separate version-1 attestation.

Juventus is not in open round 264401. The post-check reads 20/20 canonical, 20/20 Sportmonks mapped, 20/20 `manual_override` and 20/20 actively attested, with readiness empty. See `docs/operations/2026-11-04-v4-class-b-deferred-identities-execution.md`.

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
- active team attestations: **81**
- active competition attestations: **5**

## 7. Status

Serie A identity onboarding is **20/20 complete** (2026-11-04). Phase 1 ended at 19/20, and Juventus was completed on 2026-11-04 (§6 update).

Serie A remains registry state `validating`, not `supported`.

No provider ingest, fixture mint, Match Ledger observation or M2B permission
was created by this phase.