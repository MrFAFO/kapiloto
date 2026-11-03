# V4 Pilot Identity Reconciliation — Execution Record

Date: 2026-10-31 (R1–R3, R5, R6, partial R7); 2026-11-03 (R4, R6 for 52/676, full R7)  
Reviewed plan: `docs/operations/2026-10-31-v4-pilot-identity-reconciliation.md`  
Plan merge commit: `0bde9b1562c4917e562c10038afd5bafbe7dbab4`  
Provider: `sportmonks`

This record captures the production identity writes performed after two independent adversarial reviews and the reconciled PR #28 runbook. It does not authorize provider ingest or M2B.

Status: **all 25 pilot identities are complete.** 5/5 competitions and 20/20 teams are attested, and the full R7 passed on 2026-11-03 (§9). The post-import duplicate audit after natural precompute and Toto cycles is still pending (§10). M2B remains NO-GO.

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

The remaining two pilot identities, Sportmonks 52 and 676, were attested on 2026-11-03 after R4 (§8).

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

## 8. R4 + R6 — Bournemouth and Sevilla — completed 2/2 (2026-11-03)

R4 was deferred on 2026-10-31 because active Winner round 264301 contained Bournemouth–Leeds (game 10, 2026-10-31 15:00Z) and Getafe–Sevilla (game 12, 2026-11-01 13:00Z). A new Sportmonks team mapping could have let V3 precompute write current-round fixture mappings. That reason no longer applies.

### 8.1 Precondition: round 264301 settled

PR #51 (D-062) was merged as `fe8ca2de470393bd6ab9fe2b494a12c8fb5faaf2`, and the reviewed guarded correction (`docs/operations/sql/winner16-264301-orientation-correction.sql`) was executed and post-checked in production. The R4 read-only preflight observed this independently at `2026-11-03T20:31:34Z`:

- round 264301: `settled`;
- 16/16 games have `settlement_status = settled`, and 0 games are `under_review`;
- 0 games whose `fixtures` score differs from the stored field score;
- 0 `kapiloto_eval_scores` rows for its fixtures;
- round 264401 is `open` and is the only open round. Neither Bournemouth nor Sevilla appears in it; their only round games are 264301 games 10 and 12, both settled.

### 8.2 Preflight (read only, 2026-11-03 20:31–20:47 UTC)

- `origin/main` at `fe8ca2d`. Production `supabase_migrations` and the repository have the same 42 migration versions, the latest `20261102193946`.
- Match Ledger observations 0, fixture mints 0, provider ingest runs and items 0, observation attestation sidecars 0.
- `service_role` EXECUTE: V1 ingest false, V2 ingest false. V2 ingest for anon/authenticated: false.
- The three D-057 guard triggers are enabled. No other non-internal trigger exists on `teams`, `team_aliases` or `provider_team_mappings`.
- No `sportmonks` mapping, active attestation or attestation event exists for 52 or 676. Neither canonical team has a mapping from any provider. `api-football` 52 is Crystal Palace, a different provider namespace.
- The canonical rows match the reviewed values byte for byte:
  - `fcd3541d-c509-4d27-ac8d-6c403ef629e1` / `בורנמות'` (ASCII apostrophe U+0027) / `GB`;
  - `f1cc2c0b-b7a3-40f7-a18f-423fdc71344b` / `סביליה` / `ES`.
- Global folded canonical duplicates: none. Aliases pointing at two teams: none. Sportmonks team or competition injectivity violations: none.
- `provider_identity_attestation_conflicts('sportmonks')` and `match_ledger_provider_ref_conflicts_v2('sportmonks')` were both empty: every Sportmonks mapping was already attested.
- Sportmonks fixture mappings: 32.

### 8.3 Locked duplicate audit

Audit query version `kapiloto-v4-r4-team-identity-audit-v1`. For one target it returns one jsonb document with:
- every `teams`, `team_aliases` and `provider_team_mappings` (all providers) row whose `private.normalize_entity_alias` form equals a search term;
- the Sportmonks rows for the provider ref and for the target canonical team;
- the target's team row, aliases and mappings from every provider;
- the Sportmonks attestations and attestation events for the ref or the canonical team.

The hash is SHA-256 of the document's jsonb text form, the same normalization as `private.provider_identity_evidence_sha256`.

Search terms:
- Bournemouth: `בורנמות'`, the reviewed variant `בורנמות׳` (geresh U+05F3), the Sportmonks name `AFC Bournemouth`, and the official short name `Bournemouth` (PL-MW).
- Sevilla: `סביליה`, the Sportmonks name `Sevilla`, and the official name `Sevilla FC` (LL-J10, LL-CLUBS).

The audit was first run read-only, twice with identical results, then re-run inside each write transaction after the locks were held. The transaction required the locked hash to equal the reviewed one and aborted on any drift; a test with a wrong expected hash confirmed the abort. Both transactions were first rehearsed in production with `ROLLBACK`, and a read-only check confirmed nothing persisted.

| Identity | Locked `duplicate_audit_sha256` | Candidate shape under the lock |
| --- | --- | --- |
| 52 AFC Bournemouth | `97b46fbcc6e2cb0bc9283bd8c34057bc234d57c091ebd43edd14a62da28e40a9` | 1 team hit (the target); 1 alias hit, on the target (`בורנמות'`, telesport-winner16); 0 provider-name hits; Sportmonks ref absent; no Sportmonks row for the target; no attestation or event |
| 676 Sevilla | `0ce7665836ab9bfa1c8df4daf3d6a0e974d0e057f5594940fd7b6dc9c4fd3ff9` | 1 team hit (the target); 1 alias hit, on the target (`סביליה`, telesport-winner16); 0 provider-name hits; Sportmonks ref absent; no Sportmonks row for the target; no attestation or event |

### 8.4 Mapping transactions

One transaction per identity, without attestation. Each transaction:
- set `lock_timeout = '5s'` and `kapiloto.identity_operator = 'on'`;
- took `LOCK TABLE public.teams, public.team_aliases, public.provider_team_mappings IN SHARE ROW EXCLUSIVE MODE` and asserted the three locks were held;
- ran the audit and required the reviewed hash and the unique candidate shape;
- qualified every mapping statement with `provider = 'sportmonks'`;
- inserted the mapping with a plain `INSERT`, with no `ON CONFLICT`. The reviewed R3 promotion branch, for a V3 `confirmed` row pointing at the target, was not needed. Any other row would have stopped the transaction;
- added only the reviewed aliases, and only when absent;
- then re-asserted:
  - the mapping as written;
  - one Sportmonks ref per canonical team, for the target and globally;
  - the unchanged candidate shape;
  - no folded canonical duplicate;
  - no alias pointing at two teams;
  - the exact row-count deltas.

Both ran as `mapping_action = inserted_manual_override`:

| Provider ref | Canonical team | Provider name | Status | Confidence | `last_verified_at` | xid |
| ---: | --- | --- | --- | --- | --- | ---: |
| 52 | `fcd3541d-c509-4d27-ac8d-6c403ef629e1` | `AFC Bournemouth` | `manual_override` | `NULL` | `2026-11-03T20:51:17.26338Z` | 152181 |
| 676 | `f1cc2c0b-b7a3-40f7-a18f-423fdc71344b` | `Sevilla` | `manual_override` | `NULL` | `2026-11-03T20:52:37.495764Z` | 152197 |

Aliases added (`is_preferred = false`):

| Team | Alias id | Alias | Language | Source |
| --- | --- | --- | --- | --- |
| Bournemouth | `a7048913-95b7-43e9-85e6-d6a5ea5781a6` | `AFC Bournemouth` | `en` | `sportmonks_reconciliation` |
| Bournemouth | `63e7c705-c65a-4a46-a2b1-646b5b940b1d` | `בורנמות׳` | `he` | `v4-pilot-reconciliation` |
| Sevilla | `80a8a22c-e186-4c2d-8d6e-e84b6433f825` | `Sevilla` | `en` | `sportmonks_reconciliation` |

No other alias was added. The existing `telesport-winner16` aliases are unchanged.

Counts:
- teams: 103 → 103;
- aliases: 169 → 172;
- provider team mappings: 123 → 125;
- Sportmonks team mappings: 81 → 83.

Since the start of R4, production shows exactly 2 mapping writes, 3 new aliases, 0 new teams, 2 team attestation events and 0 competition attestation events. The nine other deferred Class-B refs (8, 19, 106, 116, 377, 594, 625, 1099, 13258) have no mapping and no attestation.

### 8.5 Attestations (R6)

Each identity got one `public.provider_identity_attest_team` call alone in its own transaction, after the read-only checks below:
- its mapping had committed;
- no attestation or event existed for the ref or the canonical team;
- readiness showed only the expected `mapping_unattested` info row.

The calls used:
- basis `multi_source_verified`;
- `attested_by = kapiloto-v4-pilot-identity-reconciliation-r4-2026-11-03`;
- `reviewed_by = kapiloto-v4-pilot-identity-reconciliation-pr28`.

| SM | Canonical | event | generation | version | evidence SHA-256 |
| ---: | --- | --- | --- | ---: | --- |
| 52 | בורנמות' | `bdcbdf97-8d4b-4ef6-9b9b-17781bf48f6e` | `7273492d-dc43-40d9-a2a5-7e00b45770f9` | 1 | `69d34319d93c3a75e2d91fade64740ef7635624297069f79bf897ab2357de11a` |
| 676 | סביליה | `876063e5-a607-4636-89c4-9a217b90329f` | `4c6142a9-714e-4ba5-b374-b5a69756830b` | 1 | `703d57c5c7d6c07c94ca5ea8710c320dfe76bb9090cc914b67e10120c1adeac4` |

Recorded at:
- 52: `2026-11-03T20:52:11.778652Z`;
- 676: `2026-11-03T20:53:14.849171Z`.

Both are by `postgres`, with snapshots `manual_override` and confidence `NULL`.

Each evidence object (`kapiloto-provider-identity-attestation-evidence-v1`) carries:
- the locked `duplicate_audit_sha256` and its audit query version;
- an explicit reviewed English↔Hebrew equivalence:
  - `AFC Bournemouth` ≡ `בורנמות'` (GB);
  - `Sevilla` ≡ `סביליה` (ES);
- the A2-B artifact: `13010316459` (run `41124224068`), SHA-256 `3b01187a6ce6b63621a40f34d384c2ba6d8231aa0c45a72504ab46a1f6900ad3`. On 2026-11-03 the GitHub API still showed this digest, and the artifact had not expired. The Sportmonks fixtures cited:
  - Bournemouth: `19722125`, raw SHA-256 `e5c49cc01290c1ccaa22c298ab8008600013f4312a0fc70b771217d6307c9411`, Manchester United (14) v AFC Bournemouth (52), 2026-10-25 14:00Z;
  - Sevilla: `19732644`, raw SHA-256 `3357620c409f929143c73ba956a597bbb5f0abf2d218edf43c625547edf46959`, Sevilla (676) v Osasuna (459), 2026-10-26 20:00Z;
- official sources, retrieved 2026-11-03 with content SHA-256 and a minimal excerpt:
  - PL-MW (`bf5c06fe…0ef4`): "Sunday 25 October 14:00 GMT Man Utd v Bournemouth", which is 14:00Z because BST ended 2026-10-25 01:00Z; also "Saturday 31 October … Bournemouth v Leeds".
  - PL-CLUBS (`62e4313c…44f2`): "For 2026/27 those clubs are: AFC Bournemouth, …".
  - LL-J10 (`e33a81cb…2951`): Sevilla FC (home) v CA Osasuna, 2026-10-26T20:00:00+00:00 (21:00 CET), FullTime 2–0.
  - LL-CLUBS (`6f3a8c3e…9801`): the LALIGA EA SPORTS 2026/27 club list includes Sevilla FC.
- the Toto/Winner canonical row:
  - Bournemouth: 264301 game 10, fixture `5137683f-61b1-481f-9032-a9a8f27d3234`, home v Leeds (attested Sportmonks 71), Premier League, settled 2–0, 365Scores event 4742020;
  - Sevilla: 264301 game 12, fixture `347fe43f-8811-408d-b1a2-7c3fb79bf236`, away at Getafe, La Liga, settled 3–1, 365Scores event 4750806;
- the immutable reviewed plan, `0bde9b1562c4917e562c10038afd5bafbe7dbab4`, section 6.B.

The new Sportmonks mapping rows are explicitly excluded as identity evidence.

## 9. Full R7 — passed 20/20 (2026-11-03T20:53:33Z)

The assertions read the persisted mapping, attestation and event rows directly, not RPC return values. The expected canonical ids and the 18 earlier event/generation ids are taken from this record.

Competitions:
- 5/5 active pilot attestations, each agreeing with a `manual_override` mapping to the reviewed canonical id;
- each has exactly 1 `attest` event and 0 refresh/revoke events, at version 1;
- every event and generation id equals §2.

Teams:
- 20/20 active pilot attestations, basis `multi_source_verified`, version 1;
- all 20 pilot mappings are `manual_override` and point at the attested canonical id;
- confidence is as reviewed:
  - the five legacy rows 3, 71, 516, 571 and 6900 keep `1.0000`;
  - the other 15, including 52 and 676, are `NULL`;
- each identity has exactly 1 initial `attest` event and 0 refresh/revoke events;
- the 18 earlier event and generation ids are unchanged;
- no failing pilot ref.

Global Sportmonks state:
- 83 active team attestations and 83 team events (all `attest`);
- 5 competition attestations.

Readiness (`provider_identity_attestation_conflicts('sportmonks')`) is empty:
- no `shadow_mapping_for_attested_canonical`;
- no `mint_without_mapping`;
- no blocking or warning row;
- no `mapping_unattested`.

Duplicates and conflicts:
- `match_ledger_provider_ref_conflicts_v2('sportmonks')`: empty;
- Sportmonks team injectivity violations: 0. Competition injectivity violations: 0;
- folded canonical duplicates: 0. Aliases pointing at two teams: 0.

Ledger and ingest:
- Match Ledger observations 0, fixture mints 0, provider ingest runs 0, provider ingest items 0, observation attestation sidecars 0;
- EXECUTE: V1 ingest for `service_role`, anon and authenticated is false. V2 ingest for `service_role`, anon and authenticated is false;
- the three D-057 guard triggers are enabled.

Counts:
- teams 103, aliases 172, provider team mappings 125, Sportmonks team mappings 83;
- Sportmonks fixture mappings 32, unchanged from the preflight;
- fixture mappings involving Bournemouth or Sevilla: 0.

No unauthorized Match Ledger, fixture-mint, ingest-run or fixture-mapping write occurred.

## 10. Natural-cycle audit — pending

Complete now, at 2026-11-03T20:53Z:
- the duplicate, collision and injectivity reports;
- readiness;
- provider-ref conflicts V2.

All are clean (§9).

Still required by the reviewed plan (§12, R7), after the next two natural precompute cycles and the next Toto round import:
- rerun the duplicate/collision audit;
- rerun the readiness and conflict reports;
- check that no canonical duplicate appeared. Toto's exact-name + country team lookup ignores aliases, so a null-country duplicate is the risk to look for.

Also compare the Sportmonks fixture mappings with the baseline of 32. The new mappings may legitimately let V3 map future Bournemouth or Sevilla fixtures. Record any such row in the follow-up audit.

Do not trigger an ingest or historical workflow to satisfy this check.

## 11. Remaining gates

M2B is still NO-GO.

R4 and the full 20/20 R7 close the "Bournemouth 52 / Sevilla 676 reconciliation and full 20/20 R7" blocker in D-060 and D-061. Before any provider ingest:
- the natural-cycle audit (§10) is clean;
- the Toto exact-name + country duplicate risk is resolved, through an alias-aware, country-tolerant resolver or a standing post-import duplicate gate (plan §14);
- A2-B is amended and re-run under the V2/readiness semantics;
- the two-session rehearsal on real PostgreSQL (non-production) proves the in-flight V2 ingest drain/revoke semantics (D-061);
- the immutable tiny-pilot ingest run allowlist is created and reviewed;
- only then, the separate grant-only M2B migration.

No provider ingest, fixture mint, Match Ledger observation or historical backfill occurred during this reconciliation execution.
