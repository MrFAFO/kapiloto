# V4 Pilot Identity Reconciliation — Execution Record

Date: 2026-10-31  
Reviewed plan: `docs/operations/2026-10-31-v4-pilot-identity-reconciliation.md`  
Plan merge commit: `0bde9b1562c4917e562c10038afd5bafbe7dbab4`  
Provider: `sportmonks`

This record captures the production identity writes performed after two independent adversarial reviews and the reconciled PR #28 runbook. It does not authorize provider ingest or M2B.

## 1. R1 baseline

Read-only snapshot captured at `2026-10-31T11:59:07.339225Z`.

- contract: `kapiloto-v4-pilot-r1-snapshot-v1`
- SHA-256: `99c7db9c9f2c6468fb9ff21d69f6a7f0f537920c7a615d6cc4d755768626f36a`
- teams: 51
- aliases: 57
- provider team mappings: 78
- Sportmonks team mappings: 36
- team attestations: 0
- competition attestations: 0
- Match Ledger observations: 0
- Sportmonks injectivity conflicts: none
- provider-ref conflicts V2: none

## 2. R2 competition attestations — completed 5/5

All five existing Sportmonks competition mappings were already `manual_override`. Each attestation ran in its own transaction with basis `multi_source_verified`.

| SM competition | Canonical competition | duplicate audit SHA-256 | event | generation |
| ---: | --- | --- | --- | --- |
| 8 | Premier League (`ccdbb89d-e575-4e15-820d-f5d1ecdc3a85`) | `93d0cdbe859460f390640d63b0410683a0d553b86617241c6c9140518e685d38` | `05838575-0b77-40eb-bcac-2cf8168f9b3c` | `3522b774-64fd-47b5-8416-5e3ea34f52e6` |
| 82 | Bundesliga (`11ef12f9-86cf-4634-9ed7-cf9f7113e214`) | `7dce4c2c8adbff0f96b826ec5c2da56866a0c71e7edb0c3b593e3203ef2636bd` | `d96f75f8-4f2e-4b89-b10b-3941f7dbdfac` | `f53261e4-c441-4245-954e-a3df1058d58d` |
| 372 | Ligat Ha'al (`06b70ffa-847c-44d2-a346-3683ac9115c3`) | `6f896182e97c307ced436d1184ede622cea834d1fd9e090b207adbdf74dc9833` | `a485e273-911c-49b1-abe4-0d0525ad8390` | `acdcbc2c-dcbc-41af-babc-7bb262d37444` |
| 384 | Serie A (`a2b7daf8-1d1d-4b79-8801-b47ad6cde38c`) | `a0d8f8fed15eff20e0e462508efcdafc0cef0ed19b58434056244c1785500962` | `083fc779-c17b-4507-a137-50f27dfa5eb1` | `4f2eb451-47a5-4ef2-9b30-3405d9de9e07` |
| 564 | La Liga (`2116127b-f4f6-40d5-bdbc-bc60cb70dc0d`) | `d4e81a81c7999a39ceda58ce165ce7b77470e45e32ba13a13c8216066ab80aab` | `49d7a207-1c48-4e5e-91ed-05bcacaafc7b` | `0e5c8642-d657-4ae5-aeba-3100623d8e18` |

Post-R2:
- 5 active competition attestations;
- 5 competition `attest` events;
- no refresh/revoke event;
- 0 team attestations at that checkpoint;
- 0 Match Ledger observations;
- provider-ref conflicts V2 remained empty.

## 3. R3 existing team mapping promotions — completed 5/5

Each mapping mutation:
- locked `teams`, `team_aliases`, and `provider_team_mappings` in `SHARE ROW EXCLUSIVE`;
- recomputed the reviewed duplicate audit under the lock and required the pre-read hash to match;
- used an exact provider-qualified predicate with `provider='sportmonks'`, expected provider ref, expected canonical team, expected status and confidence;
- changed only `mapping_status: confirmed -> manual_override` plus `last_verified_at`;
- left the existing confidence `1.0000` unchanged;
- re-checked Sportmonks injectivity before commit.

| SM team | Canonical team | duplicate audit SHA-256 |
| ---: | --- | --- |
| 3 Sunderland | `60b20670-8dcd-4091-85b2-1053446cab54` | `614f96cabe992284cf1e004d507edb8d29a740b0fec346208d380598b98b525e` |
| 71 Leeds United | `72bfd482-213d-4b7f-8939-544eb4329682` | `424258af10853fc0c9adff67a37c491cbb389ea34314a622ff2fb479d2c0bd38` |
| 516 Hapoel Be'er Sheva | `8430f0cd-e215-4ba9-858e-ae1707b9d37c` | `302b25f74df7c3a46573d7292fe29309e5aa1d1bdd248206569818de6d72f4f6` |
| 571 Maccabi Haifa | `40b796e4-b939-4160-a24a-044e8bc703fb` | `c91f57aa257e35f8bfa622ea380bc3d992a78ec85cac3241237048c5bc71314b` |
| 6900 Hapoel Petah Tikva | `2a4abd6e-816d-46b8-8554-33e4205ebe38` | `0efee73d441ea829b7d5555bf40fc11db04390a8a33222699433fe876e7666a8` |

## 4. R5 canonical creation + mapping — completed 13/13

Before every create, the duplicate audit searched:
- every canonical team, regardless of country;
- every alias;
- every provider mapping/provider name;
- reviewed Hebrew and provider-name variants;
using `private.normalize_entity_alias`.

Every pre-audit returned zero candidates. The same hash was recomputed after the three table locks were held; any drift would have aborted the transaction.

Each successful transaction created:
- one canonical Hebrew team with the Telesport/Winner-reviewed spelling and league country;
- a preferred Hebrew alias;
- the exact Sportmonks English name as an English alias;
- reviewed punctuation variants where applicable;
- one Sportmonks `manual_override` mapping with `mapping_confidence = NULL`.

| SM team | New canonical id | Canonical name | audit SHA-256 |
| ---: | --- | --- | --- |
| 14 | `f75859be-74a3-468e-8cca-35e47bebc3d2` | מנצ'סטר יונייטד | `b2d8461b6fd47696ff607f995a92db2600a276df0b2dde61035d59384c1976c8` |
| 83 | `a31f3c0c-a4e6-4da6-a0ef-3d384e2a392f` | ברצלונה | `13c2796436a7e22671d8b36d9228d1764f145a7005cc7c5246235a6210f7779d` |
| 109 | `d873aef4-db7e-4002-88c0-80b80d89f76b` | פיורנטינה | `82ff7c9a324521dba9fc0f0a17063de17f6e1586a08f3bdae1daa1951ee2a28c` |
| 459 | `0e97b03e-ccd5-44d6-bb6a-b5a61b3e6a65` | אוסאסונה | `e609aa6b53fa28f5cf50bfe284fff938d2a1f4f351e32036587c286bad861716` |
| 503 | `b9813325-f5de-4309-92e3-39d405052a40` | באיירן מינכן | `da62e4e24493e7701a21dcd898a79b97ad06d998ae7115ad58fa78cb756054dc` |
| 589 | `160725b4-ed0e-4f58-bda6-65e269a22363` | בית"ר ירושלים | `3b3d1192d675376b0c82ebe5a014645f612899f1f61b6ed948dde1f3fc2494c5` |
| 708 | `265d161f-2d65-4918-bff2-f73c7a489827` | אטאלנטה | `25b62c9d7548f40868570b46830f275d9273e30d528da6ab1197898aade2ca1b` |
| 2726 | `ab017488-5469-4229-8c2a-ff3729b4fcc4` | הופנהיים | `99dce11e7238426fb5fe8433d51c36e169fe5857a9f1f6cd9607ee8ae0ddada1` |
| 3321 | `1fffa2c1-9ea0-4093-a728-0a2605203bed` | באייר לברקוזן | `d447fdd4666d6f895598b86e2090c9711cf397a0287502f55853f4c65e6f4576` |
| 3468 | `9316b187-caec-4a02-8149-930e53ca9c21` | ריאל מדריד | `6609604d34830893f99599dd8a81fc161c66797015b0f175149ab34c92e9f983` |
| 3543 | `0f2c51bb-c261-44cd-9619-36f80d0baba8` | פרייבורג | `7a71fc947f218d7ee2824b0e7c25cb38d66cd4aeca51be1622b0a896642b382f` |
| 4070 | `9cfcffe3-6a0e-46d6-8cf8-a43eec96fc8a` | פרוסינונה | `fb2d3ce6ea52737cd457b8b83e2028978745059ecb5336ff5f0b1160ec5208c7` |
| 7790 | `7b438c36-f9c3-409d-8c82-d328e9cbdc9a` | לצ'ה | `8a03030cfb572782efa9c7c96c3da6bffea2f313b85a787063bb6c5bfe705e21` |

Post-R5 counts:
- teams: 64 (= baseline 51 + 13);
- aliases: 87 (= baseline 57 + 30 reviewed aliases);
- provider team mappings: 91 (= baseline 78 + 13);
- Sportmonks team mappings: 49 (= baseline 36 + 13);
- no folded canonical duplicate;
- no Sportmonks canonical injectivity conflict.

## 5. R6 team attestations — completed 18/20 pilot teams

All successful R3/R5 identities were attested separately with:
- basis `multi_source_verified`;
- A2-B raw capture/artifact evidence;
- independent official/cross-provider/Toto/Telesport evidence as applicable;
- the duplicate audit SHA-256 from the locked mapping transaction;
- reviewed Hebrew-English equivalence where the provider name and canonical language differ.

| SM | Canonical | event | generation |
| ---: | --- | --- | --- |
| 3 | סנדרלנד | `a809e662-df07-4569-b34b-d66bbe8107ab` | `1a19caa2-ec08-4def-9ebb-36a02124b21f` |
| 14 | מנצ'סטר יונייטד | `706a54d0-c4b8-46dc-ba05-73b3f9981b29` | `c4782bf0-236a-471b-bcf4-901624990347` |
| 71 | לידס | `6b4b5892-34e1-45e2-bcea-7b684bc7b28a` | `a3091d28-0979-4d70-8f22-5fd28eb35775` |
| 83 | ברצלונה | `75d88095-237b-4c0d-ad3d-85ef52abf07a` | `19a50a52-dad9-4403-a4e9-420473925c9a` |
| 109 | פיורנטינה | `5c7b61e6-204c-4842-9f23-6bd8f99a4405` | `958232e0-a784-4328-9038-addcec98d0c4` |
| 459 | אוסאסונה | `43c33c91-3916-497d-a0c3-36bb64a8784a` | `eba24203-11d0-4ed0-bea4-8dada3768357` |
| 503 | באיירן מינכן | `0d0e89b0-98d4-4a05-a3a9-734bbdafff08` | `5fc9887c-39f3-462f-8f37-96c6ca20b749` |
| 516 | הפועל באר שבע | `60875c17-a2f6-4394-9e6f-b9306a28336e` | `d4421e2a-d8f7-4b19-8449-d8896879c156` |
| 571 | מכבי חיפה | `38d45672-02b3-407b-a7a6-065f16ab3fef` | `f6e10d35-3b0e-4e90-9e2c-fc12712e95fe` |
| 589 | בית"ר ירושלים | `b148efc8-0280-43c3-9a9b-0c3666b10f47` | `c938162b-450b-4988-9595-ef910d5d1ef6` |
| 708 | אטאלנטה | `ab37be9a-a54b-4073-a4f9-f831325509a5` | `cdecaca1-81bd-4014-8102-2ded1025172b` |
| 2726 | הופנהיים | `70d06ff8-73ff-4821-9c3f-a4d50ca263b9` | `bbb003a4-1710-4ef4-adaf-5907043a66e5` |
| 3321 | באייר לברקוזן | `54f9c613-6035-4641-8c64-880a675e666b` | `51816b82-aa7e-4a1e-be28-0b049bf6e99e` |
| 3468 | ריאל מדריד | `55adcbf4-e6c5-44bf-9d0d-43bc290c6594` | `dc4956e8-4b71-4135-b3e6-ba560f26d643` |
| 3543 | פרייבורג | `571ecdb1-183c-49d2-9b74-d8bd82b057c6` | `ec1346e5-c943-441e-9119-b74c2f1b9377` |
| 4070 | פרוסינונה | `a7cd5c56-dcca-4157-956f-85b02ea856dd` | `1cca2901-31ec-4325-b48a-299b4ffee98c` |
| 6900 | הפועל פתח תקווה | `9094fed5-e299-4d84-a961-11397f7b1a08` | `1388df2e-8623-4088-b7e0-ab45bb4e4b3d` |
| 7790 | לצ'ה | `b5c09f6a-169a-4557-b126-f47afbf31b59` | `2e247037-34a8-4180-b525-db0f0a3cc2f4` |

Every row above is attestation version 1. No team evidence refresh or revoke event exists.

## 6. Scheduled-vs-actual kickoff evidence

Sportmonks fixture 19721180 stores Maccabi Haifa–Hapoel Be'er Sheva at 17:30Z. The canonical Toto/IFA schedule stores 17:00Z.

The operation evidence records the reviewed explanation: the match was scheduled for 19:00 Israel time and delayed on match day to 19:30 because of exceptional traffic around Sammy Ofer. This is treated as scheduled-vs-actual kickoff, not a wrong identity.

It is retained as an A2-B regression case: fixture identity must not depend on exact kickoff equality alone.

## 7. R7 partial validation — passed

Current verified state after R2/R3/R5/R6:

- active Sportmonks competition attestations: 5;
- competition `attest` events: 5;
- competition refresh/revoke events: 0;
- active Sportmonks team attestations: 18;
- team `attest` events: 18;
- team refresh/revoke events: 0;
- Match Ledger observations: 0;
- fixture mints: 0;
- provider ingest runs: 0;
- provider-ref conflicts V2: 0;
- readiness has only `mapping_unattested` informational rows for other Sportmonks mappings;
- folded canonical duplicates: none;
- Sportmonks team injectivity conflicts: none;
- V1 ingest EXECUTE for service_role: false;
- V2 ingest EXECUTE for service_role: false;
- V2 ingest EXECUTE for anon/authenticated: false;
- D-057 mapping guard triggers: all enabled;
- no Sportmonks fixture mapping was written during this execution window.

## 8. R4 deferred — Bournemouth and Sevilla

Two pilot identities remain deliberately unresolved in Stage 1 attestation state:

- Sportmonks 52 — AFC Bournemouth -> existing canonical `fcd3541d-c509-4d27-ac8d-6c403ef629e1` / בורנמות'
- Sportmonks 676 — Sevilla -> existing canonical `f1cc2c0b-b7a3-40f7-a18f-423fdc71344b` / סביליה

Reason for deferral: active Winner round 264301 contains:
- Bournemouth–Leeds at 2026-10-31 15:00Z;
- Getafe–Sevilla at 2026-11-01 13:00Z.

Adding these Sportmonks mappings can legitimately let the active V3 precompute path create current-round provider fixture mappings. The reviewed runbook defaults to waiting until round 264301 settles rather than mixing that live side effect into the identity reconciliation window.

R4 completion must:
1. re-run the locked duplicate audit for 52 and 676;
2. insert the manual_override mapping with confidence NULL, or promote the correct V3 row if it appeared first;
3. add the reviewed English/punctuation aliases;
4. attest each identity separately;
5. run full R7 for 20/20 pilot teams.

## 9. Remaining gates

M2B is still NO-GO.

Before any provider ingest:
- complete R4 after round 264301 settles;
- amend/re-run A2-B pilot tooling under the V2/readiness semantics;
- rehearse recovery;
- keep uncovered 1A/1C/squad-state historical readers gated or version them;
- resolve the Toto exact-name + country duplicate risk through an alias-aware/country-tolerant resolver or a standing post-import duplicate gate;
- create and review the immutable tiny-pilot ingest run allowlist;
- only then consider the separate M2B grant-only activation.

No provider ingest, fixture mint, Match Ledger observation or historical backfill occurred during this reconciliation execution.
