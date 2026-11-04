# V4 Deferred Class-B Identities (7 of 9) — Execution Record

Date: 2026-11-04 (production writes 10:50–10:58 UTC)
Decisions: D-057, D-058, D-059 (no new decision)
Provider: `sportmonks`
Repository state at start: `origin/main` = `1799c954cd6707754807a422a02dfbba8b7bb572` (PR #52 merged)

This record covers seven of the nine deferred Class-B identities left after pilot R4. Each had an existing canonical team and no Sportmonks mapping. Each was attached with the reviewed R4 pattern (`docs/operations/2026-10-31-v4-pilot-identity-reconciliation-execution.md` §8):
- one locked mapping transaction per identity;
- then one attestation per identity, alone in its own transaction.

No canonical team was created. It does not authorize provider ingest or M2B.

Status: **7/7 PASS.** Premier League 20/20, La Liga 18/20, Serie A 20/20. Elche 1099 and Athletic Club 13258 remain, deliberately untouched (§1). M2B remains NO-GO.

## 1. Scope

In scope (frozen by the league onboarding records, D-059):

| League | Sportmonks | Provider name | Canonical id | Canonical | Country |
| --- | ---: | --- | --- | --- | --- |
| Premier League | 8 | Liverpool | `aecaaa05-2dac-4190-b443-f985457f9443` | ליברפול | GB |
| Premier League | 19 | Arsenal | `1a6b21ee-d16b-4cf1-a2e5-ff5a1cbf6eb8` | ארסנל | GB |
| Premier League | 116 | Ipswich Town | `eefba343-60da-4cb7-ae01-78a539747db6` | איפסוויץ' (ASCII apostrophe U+0027) | GB |
| La Liga | 106 | Getafe | `9f672e5a-5644-4f90-8e12-8c4f55db46c0` | חטאפה | ES |
| La Liga | 377 | Rayo Vallecano | `20b1942a-068f-49b7-b0f3-169741ecec43` | ראיו ואייקאנו | ES |
| La Liga | 594 | Real Sociedad | `71971f07-cdcc-4a62-973c-ddedf1524907` | ריאל סוסיאדד | ES |
| Serie A | 625 | Juventus | `5818b519-2465-41c4-833b-5a559686539a` | יובנטוס | IT |

Out of scope, deliberately untouched:
- Sportmonks `1099` Elche → `אלצ'ה` (`2b1d092a-7ee9-441b-acd3-e053cde9262b`);
- Sportmonks `13258` Athletic Club → `אתלטיק בילבאו` (`e5619a70-7bf3-42da-a155-e03cfbbbcb18`).

Both play in open Winner round 264401:
- game 12: Osasuna v Athletic Bilbao, 2026-11-07 17:30Z;
- game 13: Elche v Betis, 2026-11-08 13:00Z.

A new Sportmonks team mapping could let V3 precompute map those current-round fixtures, so they stay deferred until 264401 is no longer active. This is the same containment rule as R4.

## 2. Preconditions

The R4 natural-cycle observation window was reported complete in the operation handoff:
- natural precompute cycles ran with no duplicate or conflict;
- a structured sync completed at 2026-11-04 06:07:24Z;
- round 264401 was updated at 2026-11-04 08:15:04Z;
- Bournemouth 52 and Sevilla 676 kept their mappings and attestations.

The preflight below re-confirmed the resulting state independently: no duplicate or conflict, 32 Sportmonks fixture mappings, and 52/676 unchanged.

## 3. Fresh read-only preflight (2026-11-04 10:38–10:48 UTC)

1. `origin/main` = `1799c95` (PR #52 merge).
2. Round 264301: `settled`. 16/16 games have `settlement_status = settled`, 0 are under review, 0 fixture-score mismatches and 0 `kapiloto_eval_scores` rows.
3. Round 264401: `open`, the only open round, 16 games, all `upcoming`/`pending`.
4. None of the seven canonical teams appears in any 264401 game. Their only round games are settled 264301 games 7, 9, 11, 12, 14 and 16.
5. Elche (264401 game 13, home) and Athletic Club (264401 game 12, away) do participate. They are out of scope.
6. No `sportmonks` mapping exists for 8, 19, 116, 106, 377, 594 or 625. None of the seven canonical teams has a mapping from any provider.
7. No active Sportmonks attestation or attestation event exists for any of the seven refs or canonical teams.
8. Canonical rows match the reviewed UUID, name and country byte for byte, checked against the UTF-8 hex.
9. For each of the seven, the normalized canonical name resolves to exactly one team, the target.
10. Each team's only alias is its `telesport-winner16` Hebrew alias. None of the exact Sportmonks English names exists as an alias anywhere.
11. Sportmonks team and competition injectivity violations: 0.
12. `provider_identity_attestation_conflicts('sportmonks')`: empty. `match_ledger_provider_ref_conflicts_v2('sportmonks')`: 0.
13. Match Ledger observations: 0.
14. Fixture mints: 0.
15. Provider ingest runs and items: 0. Observation attestation sidecars: 0.
16. EXECUTE on V1 and V2 ingest for `service_role`, `anon` and `authenticated`: all false. `provider_identity_attest_team` is executable only by `service_role` among the API roles, as designed.
17. The three D-057 guard triggers are enabled (`O`). No other non-internal trigger exists on `teams`, `team_aliases` or `provider_team_mappings`.
18. Baselines: 32 Sportmonks fixture mappings (the full set was captured); teams 103; aliases 172; provider team mappings 127; Sportmonks team mappings 83; active team attestations 83; team events 83; competition attestations 5. Production migrations: 42, latest `20261102193946`.

Global folded canonical duplicates and aliases pointing at two teams: none.

R7 on 2026-11-03 recorded 125 provider team mappings; the preflight found 127. The two extra rows are `football-il-parse` mappings from natural V3 sync. The Sportmonks count was unchanged at 83, and no row touches the seven targets.

## 4. Locked duplicate audit

The audit query is `kapiloto-v4-r4-team-identity-audit-v1`, unchanged. The generator emits the same jsonb expression as R4: regenerating Bournemouth's R4 audit with it reproduced the R4 SQL byte for byte. Its contents and hash normalization are described in the pilot execution record §8.3.

Search terms, normalized with `private.normalize_entity_alias`:

| Identity | Terms |
| --- | --- |
| 8 | `ליברפול`, `Liverpool`, `Liverpool FC` |
| 19 | `ארסנל`, `Arsenal`, `Arsenal FC` |
| 116 | `איפסוויץ'`, `איפסוויץ׳` (geresh, search only), `Ipswich Town`, `Ipswich` |
| 106 | `חטאפה`, `Getafe`, `Getafe CF` |
| 377 | `ראיו ואייקאנו`, `Rayo Vallecano` |
| 594 | `ריאל סוסיאדד`, `Real Sociedad` |
| 625 | `יובנטוס`, `Juventus`, `Juventus FC` |

Each audit was run read-only twice with identical hashes, then recomputed inside its write transaction after the three locks were held. The write required the locked hash to equal the reviewed one.

All seven had the same candidate shape under the lock:
- 1 team hit, the target, equal to the target row;
- 1 alias hit, the target's own `telesport-winner16` Hebrew alias;
- 0 provider-name hits from any provider;
- the Sportmonks ref absent;
- no Sportmonks row for the target;
- no attestation and no event.

| Identity | Locked `duplicate_audit_sha256` |
| --- | --- |
| 8 Liverpool | `28d89321c0ba0be36424dc6fee8e6d108cd88039cca7b2bff64d64326d51bbfe` |
| 19 Arsenal | `150ae6acce93bcdf514a848bcd36b6426bcc12ddc4775ced7eb3b8ceea86b681` |
| 116 Ipswich Town | `bca6ae23cb75bc861bac6f8d1fa7dd621a88834195ec72180530f175bf91e312` |
| 106 Getafe | `3aabbd1c10cbf282fd457853abfff0608a0119c5046dbce02e0586d0c883b0cf` |
| 377 Rayo Vallecano | `e3115b9e133021e399a066bdac16663a68d45f71231bcdbd5f2934df63595cf0` |
| 594 Real Sociedad | `adb969f7d26cbf57c7476cd60f512daf87d572c9d78335c84d014cc1d6e9dd6a` |
| 625 Juventus | `6b367d3d23c6e4b1c27a77e20b53111679753790cc821b49349a51691a9e5b88` |

## 5. Drift-guard rehearsal (before the first commit)

All seven write transactions were first run in production ending in `ROLLBACK`. Each reported `inserted_manual_override`, one English alias and counts of +1 mapping and +1 alias.

The Liverpool transaction was then run with a deliberately wrong expected hash (64 zeros). It aborted with `cb7_liverpool_audit_drift: locked 28d89321… <> reviewed 0000…`.

A read-only check afterwards found nothing persisted:
- no Sportmonks row for any of the nine refs;
- 0 mappings for the nine teams;
- 0 of the seven English aliases;
- counts unchanged.

## 6. Mapping transactions

Each identity ran in its own transaction, without attestation. Each transaction:
- set `lock_timeout = '5s'` and `kapiloto.identity_operator = 'on'`;
- took `LOCK TABLE public.teams, public.team_aliases, public.provider_team_mappings IN SHARE ROW EXCLUSIVE MODE` and asserted the three locks were held;
- recomputed the audit and required the reviewed hash and the unique candidate shape;
- qualified every statement with `provider = 'sportmonks'`;
- inserted with a plain `INSERT`, with no `ON CONFLICT`. The reviewed R3 promotion branch, for a V3 `confirmed` row on the target, was not needed. Any other row would have stopped the transaction;
- added only the exact Sportmonks English name as an `en` alias, and only when absent.

Before commit, each transaction re-asserted:
- the mapping as written;
- one Sportmonks ref per canonical team, for the target and globally;
- no Sportmonks row for 1099 or 13258 or their canonical teams;
- an unchanged candidate shape;
- no folded canonical duplicate;
- no alias pointing at two teams;
- exact row-count deltas.

All seven ran as `mapping_action = inserted_manual_override`, with `mapping_status = manual_override` and `mapping_confidence = NULL`:

| Ref | Canonical id | `provider_name` | `last_verified_at` | xid | Alias added (`en`, `sportmonks_reconciliation`, not preferred) |
| ---: | --- | --- | --- | ---: | --- |
| 8 | `aecaaa05…9443` | `Liverpool` | `2026-11-04T10:50:48.38235Z` | 158315 | `68368298-b32f-433c-b3f7-136ba4862282` `Liverpool` |
| 19 | `1a6b21ee…6eb8` | `Arsenal` | `2026-11-04T10:52:34.707971Z` | 158333 | `d1993700-de0e-4b48-96f7-6983e028eeee` `Arsenal` |
| 116 | `eefba343…6db7` | `Ipswich Town` | `2026-11-04T10:53:18.182096Z` | 158340 | `72649a46-827e-467e-9167-0c8b42e12653` `Ipswich Town` |
| 106 | `9f672e5a…46c0` | `Getafe` | `2026-11-04T10:54:37.487111Z` | 158359 | `10b76dac-bcc2-4554-bb22-7e6aa88a668c` `Getafe` |
| 377 | `20b1942a…ec43` | `Rayo Vallecano` | `2026-11-04T10:55:29.250906Z` | 158366 | `f0fdfa92-a2ea-4882-9954-19929f7792e6` `Rayo Vallecano` |
| 594 | `71971f07…4907` | `Real Sociedad` | `2026-11-04T10:56:15.721851Z` | 158383 | `1d6e5e21-9613-4075-9955-f9b1341adac0` `Real Sociedad` |
| 625 | `5818b519…539a` | `Juventus` | `2026-11-04T10:57:16.794819Z` | 158391 | `b4756ea0-3282-4528-8c41-2c55c7b8fc5c` `Juventus` |

No other alias was added. The existing `telesport-winner16` aliases are unchanged.

## 7. Attestations

Each `public.provider_identity_attest_team` call ran alone in its own transaction, after its mapping transaction had committed. Before each call, a fail-closed read-only gate required:
- the persisted mapping exactly as written;
- one Sportmonks row for the team;
- no attestation or event for the ref or the team;
- the target's two aliases: the Telesport Hebrew one and the new English one;
- readiness showing exactly one row, `mapping_unattested` (info), for this ref;
- provider-ref conflicts V2 empty, the V2 ingest grant false and 0 observations;
- `private.provider_identity_evidence_issue(evidence)` returning null.

Calls used:
- basis `multi_source_verified`;
- `attested_by = kapiloto-v4-class-b-deferred-seven-2026-11-04`;
- `reviewed_by` set to the league onboarding that froze the identity:
  - `kapiloto-v4-premier-league-onboarding-2026-10-31`;
  - `kapiloto-v4-laliga-onboarding-2026-11-01`;
  - `kapiloto-v4-serie-a-onboarding-2026-11-01`.

| SM | Canonical | event | generation | version | evidence SHA-256 | recorded at |
| ---: | --- | --- | --- | ---: | --- | --- |
| 8 | ליברפול | `b288c5d3-420b-48f5-908e-32b79573e243` | `5e334556-a0cd-4891-8e18-ae4d32a1678d` | 1 | `9235795553ccf6cf0d8ac99d214c7fc58d25665d3901148d98e1d852097bea04` | `10:51:49.599067Z` |
| 19 | ארסנל | `7f82a2bf-1c15-4f82-88d6-4c967b28a617` | `3d9988bb-1163-435b-9e77-f203d05cf789` | 1 | `c205932502e6b3c6d3c37800ca56c19df1caf24e0e61af770d6e325514a38ce4` | `10:52:59.441238Z` |
| 116 | איפסוויץ' | `6aa0ae01-6ed8-40a4-bfd0-31127317381d` | `25a8a668-1b43-4316-8f8d-ed22da64daa8` | 1 | `fc81b1000d79dfa23bd49d8551ef4fbf202248ed1ba26d7289da5d19ebf205f4` | `10:53:46.655264Z` |
| 106 | חטאפה | `8dfa0177-385d-4dcd-ad59-a114a1153fd4` | `c36fa63e-71e4-43a8-8805-1b0bebdfb7f8` | 1 | `69f87f0fbf304d254c220bbdb3dc495f1165becbcf7395ae0fb73945101d9df8` | `10:55:02.229849Z` |
| 377 | ראיו ואייקאנו | `02728179-6194-4cc1-8380-4961d93afe48` | `b4162e22-5a75-4d5d-b291-37d8bd18e696` | 1 | `7d5332da6db7829f91f0af8e77b0201d68c8552ad161cc18cc432461b7f08a6b` | `10:55:54.257386Z` |
| 594 | ריאל סוסיאדד | `602f06ec-0d95-4d8f-8c04-7b7efc975f52` | `c709b85f-e2e5-4d42-a730-e5d9769a894d` | 1 | `01909888a388329cd96649f92ecf3b8cf374cf776d2bb003a0ed342193d8c118` | `10:56:42.475952Z` |
| 625 | יובנטוס | `fdf7bc82-5446-44f7-a84f-6a1334abfd06` | `abe0d0e2-5d75-4078-a144-e241ac2e3462` | 1 | `e9917f11ffcfa10eaeb816f7fa674727754058a4ecc4bf2c8579e0d019836cb2` | `10:57:44.142967Z` |

All seven were recorded on 2026-11-04 by `postgres`, with snapshots `manual_override` and confidence `NULL`.

Each evidence object (`kapiloto-provider-identity-attestation-evidence-v1`) carries:
- the locked `duplicate_audit_sha256` and its audit query version;
- an explicit reviewed English↔Hebrew equivalence: provider name, canonical id, canonical name, country, assertion;
- `sportmonks_season_roster_capture`, the immutable roster artifact for the league:

  | League | Run / head | Artifact (ZIP SHA-256) | Season | Season-team raw SHA-256 | Team-set SHA-256 |
  | --- | --- | --- | --- | --- | --- |
  | PL 8 | `41202611579` / `589ee761…` | `13043202540` (`ec674031…9cb7`) | `28083` 2026/2027 | `ff3955e3…281e` | `e864984e…32d9` |
  | LL 564 | `41294737035` / `4a45d53c…` | `13079016059` (`94773815…2ddb25`) | `27965` | `dedae5dd…8ebfc` | `40b74af3…ab3e6` |
  | SA 384 | `41309277420` / `382334d8…` | `13084702085` (`28bf4ba6…76f2`) | `27895` | `6139a884…601c6` | `ab4d4193…c2b9a` |

  Each roster has 20 teams and 0 duplicate provider names. The source also carries the league raw SHA, the target's provider id and name, and a GitHub API check: at 2026-11-04 ~10:40Z each artifact digest matched, `expired = false`, and the run id and head SHA matched;
- official league membership, retrieved 2026-11-04 with a content SHA-256 and a minimal excerpt:
  - PL-CLUBS `https://www.premierleague.com/en/news/4365156` (`179ebf63…51ae`): the 2026/27 club list includes Arsenal, Ipswich Town and Liverpool;
  - LL-CLUBS `https://www.laliga.com/en-US/laliga-easports/clubs` (`7b4cc2a2…a982`): "Clubs and Teams of LALIGA EA SPORTS 2026/27" lists Getafe CF (1983), Rayo Vallecano (1924) and Real Sociedad (1909);
  - SA `https://en.legaseriea.it/serie-a` (`54d8bad8…6093`): the Serie A Enilive 2026/27 Matchday 11 list includes Fiorentina v Juventus;
- the Toto/Winner canonical row from settled round 264301 (canonical origin: Telesport Winner 16 import, alias source `telesport-winner16`):

  | Identity | Game | Fixture | Side | Opponent | Kickoff | Field | 365Scores |
  | --- | ---: | --- | --- | --- | --- | --- | ---: |
  | Liverpool | 7 | `9864866e-7444-4f9e-ae57-b21bf1c725d3` | home | Arsenal | 2026-11-01T16:30Z | 0–1 | 4742014 |
  | Arsenal | 7 | same | away | Liverpool | 2026-11-01T16:30Z | 0–1 | 4742014 |
  | Ipswich Town | 9 | `1bf0e940-73dd-4843-8e00-f32e35960dc3` | away | Hull (SM 22) | 2026-10-31T15:00Z | 2–2 | 4742015 |
  | Rayo Vallecano | 11 | `42690081-414d-4c41-838f-042ba1e63a05` | home | Celta (SM 36) | 2026-10-31T15:15Z | 3–0 | 4750803 |
  | Getafe | 12 | `347fe43f-8811-408d-b1a2-7c3fb79bf236` | home | Sevilla (SM 676) | 2026-11-01T13:00Z | 3–1 | 4750806 |
  | Real Sociedad | 14 | `e7b5d4f7-7f2a-47c2-8440-31353ab2b946` | away | Athletic Bilbao (unmapped, out of scope) | 2026-11-01T20:00Z | 2–1 | 4750811 |
  | Juventus | 16 | `7d4212c8-fa9a-46f7-a524-ec3e1f6aea21` | home | Napoli (SM 597) | 2026-11-01T19:45Z | 2–0 | 4732646 |

  An opponent's Sportmonks ref is cited only when that opponent was attested before this operation;
- `reviewed_name_equivalence`: same senior football club;
- `reviewed_onboarding_record`: the league onboarding record at the immutable commit `1799c954cd6707754807a422a02dfbba8b7bb572`, §2, the deferred Class-B table (D-059).

The new Sportmonks mapping rows are explicitly excluded as identity evidence.

## 8. League post-checks

Read from persisted rows against the frozen roster refs:

| League | Canonical | Sportmonks mapped | `manual_override` | Actively attested (agreeing, v1, one `attest` event each) | Missing | Readiness |
| --- | --- | --- | --- | --- | --- | --- |
| Premier League 8 (10:54:15Z) | 20/20 | 20/20 | 20/20 | 20/20 | — | empty |
| La Liga 564 (10:56:58Z) | 20/20 | 18/20 | 18/20 | 18/20 | 1099, 13258 | empty |
| Serie A 384 (10:58:11Z) | 20/20 | 20/20 | 20/20 | 20/20 | — | empty |

Legacy rows keep confidence `1.0000`: 8 in the Premier League, 6 in La Liga and 6 in Serie A. All others are `NULL`. La Liga's Elche and Athletic canonical rows exist unchanged: `ES`, each with only its Telesport alias.

## 9. Final production validation (2026-11-04T11:00:47Z, read only)

Per identity, for all seven:
- the mapping exists exactly as written: ref, canonical id, provider name, `manual_override`, confidence `NULL`;
- one Sportmonks row for the team, and one mapping from any provider;
- the active attestation is version 1, `multi_source_verified`. Its generation id, latest event id, evidence SHA and `duplicate_audit_sha256` equal §4 and §7;
- exactly 1 `attest` event and no refresh or revoke. The event matches §7, with snapshots `manual_override` / `NULL` / provider name;
- exactly 2 aliases: the Telesport Hebrew one and the new English one;
- 0 fixture mappings involve the team, from any provider;
- the team is not in 264401.

Global:
- writes since 10:50:00Z:
  - 0 teams;
  - exactly the 7 aliases above;
  - exactly 7 Sportmonks team mappings (8, 19, 116, 106, 377, 594, 625) and no other provider's mapping;
  - exactly 7 team attestation events, in the same order, and 0 competition events;
- counts:
  - teams 103 (unchanged); aliases 179 (= 172 + 7);
  - provider team mappings 134 (= 127 + 7); Sportmonks team mappings 90 (= 83 + 7);
  - active Sportmonks team attestations 90 and team events 90, all `attest`;
  - Sportmonks mappings without an agreeing attestation: 0;
  - competition attestations 5 and competition events 5, unchanged;
- duplicates and conflicts:
  - folded canonical duplicates 0; aliases pointing at two teams 0;
  - Sportmonks team injectivity 0; competition injectivity 0; attestation team injectivity 0;
  - readiness empty; provider-ref conflicts V2 0;
- ledger and grants:
  - Match Ledger observations 0, fixture mints 0, provider ingest runs 0 and items 0, observation sidecars 0;
  - EXECUTE on V1 and V2 ingest for `service_role`, `anon` and `authenticated`: all false;
  - the three D-057 guard triggers are enabled;
  - production migrations unchanged: 42, latest `20261102193946`;
- Sportmonks fixture mappings: 32, identical to the pre-write baseline set; 0 added and 0 removed;
- 264301 is still `settled`, 16/16.

Elche 1099 and Athletic Club 13258: no Sportmonks mapping, no mapping from any provider, no attestation, no event. Each has only its Telesport alias and 0 fixture mappings. Both are still in 264401.

## 10. Round 264401 containment

- None of the seven targets participates in 264401.
- After the writes, a natural sync updated round 264401 at 2026-11-04T11:00:03.845Z. Afterwards, all 16 games still match the pre-write baseline:
  - same fixture, home and away teams;
  - `upcoming` / `pending`;
  - no field score or pool outcome;
  - the same Sportmonks fixture mapping per game (games 1–5, 8–11 and 14 mapped; games 6, 7, 12, 13, 15 and 16 unmapped).
- No current-round fixture mapping, result or settlement state was mutated.

## 11. Writes performed

| Target | Operation | Rows |
| --- | --- | ---: |
| `public.provider_team_mappings` | `INSERT` (Sportmonks `manual_override`, confidence `NULL`), one transaction per identity | 7 |
| `public.team_aliases` | `INSERT` (exact Sportmonks English name, `en`, `sportmonks_reconciliation`), inside the same mapping transactions | 7 |
| `public.provider_identity_attest_team` | RPC, one call per transaction; writes the projection and event rows | 7 attestations / 7 events |

The seven rehearsals ended in `ROLLBACK` and the wrong-hash abort persisted nothing.

## 12. Writes not performed

- Elche 1099 and Athletic Club 13258 were not touched.
- No canonical team was created, and no team, competition or fixture row was updated.
- No existing mapping or alias was updated or deleted, and no other provider's mapping was touched.
- No `ON CONFLICT DO UPDATE` and no fuzzy resolution was used.
- No competition attestation, refresh or revoke.
- No M2B, no ingest grant and no M2C privilege change.
- No Match Ledger observation, fixture mint, ingest run or historical backfill.
- No Winner round result or settlement state was changed.
- No migration was created or applied.

## 13. Remaining

- Identity:
  - Elche 1099 → `אלצ'ה`;
  - Athletic Club 13258 → `אתלטיק בילבאו`.

  Both are deferred only because they participate in open Winner round 264401. Revisit them with the same pattern once 264401 is no longer active.
- M2B is still NO-GO. The remaining gates are listed in the master roadmap, Gate 6.
