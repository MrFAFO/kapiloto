# Kapiloto V4 — Pilot Identity Reconciliation Plan

Status: **read-only reconciliation proposal; no production writes approved yet**  
Date: 2026-10-31  
Depends on: D-057, D-058, M2A production migration `20261031100000_kapiloto_v4_identity_attestations.sql`

This document is the operator plan for reconciling the five A2-B Sportmonks competitions and the 20 teams observed in the ten-fixture real-payload pilot.

It does **not** authorize any database write. The proposed decisions must pass independent review before mappings, canonical teams, aliases or attestations are changed.

## 1. Production state before reconciliation

Verified after M2A production application:

- V1 and V2 provider ingest are both revoked from `service_role`;
- `private` is not exposed through the Supabase Data API;
- Match Ledger has `0` observations;
- no team/competition attestation, attestation event or observation sidecar exists;
- `match_ledger_provider_ref_conflicts_v2('sportmonks')` returns no rows;
- the readiness report currently contains only expected `mapping_unattested` rows;
- all five pilot competition mappings remain `manual_override`;
- there is no current Sportmonks team injectivity violation (`provider_team_mappings` has no canonical team with two Sportmonks provider ids).

No historical ingest, fixture mapping or Match Ledger write is part of this plan.

## 2. Evidence snapshot

### A2-B artifact

GitHub Actions run: `41124224068`  
Artifact: `13010316459` — `kapiloto-v4-sportmonks-a2b-pilot`  
Artifact digest: `sha256:3b01187a6ce6b63621a40f34d384c2ba6d8231aa0c45a72504ab46a1f6900ad3`  
Entitlement snapshot SHA-256: `645917dcce248bd9c730c3795b73113b265be0f36d3c970696c9c566cdc78725`

The artifact is the provider-side identity evidence: Sportmonks league id, fixture id, kickoff and home/away participant ids/names. Official competition sources below independently confirm the competition membership and/or exact fixture pair.

### Official source keys

| Key | Official source | Purpose |
| --- | --- | --- |
| PL-CLUBS | Premier League — 2026/27 club list | Manchester United, Bournemouth, Sunderland, Leeds membership |
| PL-MW | Premier League — October fixture amendments | Manchester United–Bournemouth and Sunderland–Leeds fixture anchors |
| BL-CLUBS | Bundesliga — 2026/27 club list | Bayern, Freiburg, Hoffenheim, Leverkusen membership |
| BL-MD7 | Bundesliga — Matchday 7 | Freiburg–Bayern and Hoffenheim–Leverkusen fixture anchors |
| LL-CLUBS | LALIGA EA SPORTS — 2026/27 clubs | Barcelona, Real Madrid, Sevilla, Osasuna membership |
| LL-J10 | LALIGA — Matchday 10 results | Barcelona–Real Madrid and Sevilla–Osasuna fixture anchors |
| SA-CLUBS | Lega Serie A — club/statistics list | Fiorentina, Atalanta, Frosinone, Lecce membership |
| SA-MD9 | Lega Serie A — Matchday 9 official schedule | Fiorentina–Atalanta and Frosinone–Lecce fixture anchors |
| IFA-MD8 | Israel Football Association — Winner League Matchday 8 | Hapoel Petah Tikva–Beitar Jerusalem and Maccabi Haifa–Hapoel Beer Sheva anchors |

Source URLs used by the review:

- PL-CLUBS: `https://www.premierleague.com/en/news/4365156`
- PL-MW: `https://www.premierleague.com/en/news/4688862/fixture-amendments-for-premier-league-matches-in-october-and-november/`
- BL-CLUBS: `https://www.bundesliga.com/en/bundesliga/clubs`
- BL-MD7: `https://www.bundesliga.com/en/bundesliga/matchday/2026-2027/7/`
- LL-CLUBS: `https://www.laliga.com/en-US/laliga-easports/clubs`
- LL-J10: `https://www.laliga.com/en-GB/laliga-easports/results/2026-27/gameweek-10`
- SA-CLUBS: `https://www.legaseriea.it/serie-a/statistiche/clubs`
- SA-MD9: `https://en.legaseriea.it/serie-a/news/the-referees-for-the-9th-round-x4306`
- IFA-MD8: `https://www.football.org.il/leagues/games/?league_id=40`

## 3. Captured pilot fixtures

| League | Sportmonks fixture | Capture raw SHA-256 | Provider kickoff UTC | Home | Away | Official cross-check |
| --- | ---: | --- | --- | --- | --- | --- |
| Premier League 8 | 19722124 | `9c10f18b25452207bfdd3af5122890bf4c8f7f7966d153d63227aa03e8edaeec` | 2026-10-25 16:30 | 3 Sunderland | 71 Leeds United | PL-MW exact |
| Premier League 8 | 19722125 | `e5c49cc01290c1ccaa22c298ab8008600013f4312a0fc70b771217d6307c9411` | 2026-10-25 14:00 | 14 Manchester United | 52 AFC Bournemouth | PL-MW exact |
| Bundesliga 82 | 19735139 | `22e54178f1204a98c9fde9ac6f12a9cc2469c08fedd7076b9a5f5638faa8a6c7` | 2026-10-25 16:30 | 3543 SC Freiburg | 503 FC Bayern München | BL-MD7 exact pair/date |
| Bundesliga 82 | 19735140 | `c765b1a9760d1d7184e036d027d80d62d3e591b962af6c877a1b8af81dd8e140` | 2026-10-25 14:30 | 2726 TSG Hoffenheim | 3321 Bayer 04 Leverkusen | BL-MD7 exact pair/date |
| La Liga 564 | 19732644 | `3357620c409f929143c73ba956a597bbb5f0abf2d218edf43c625547edf46959` | 2026-10-26 20:00 | 676 Sevilla | 459 Osasuna | LL-J10 exact |
| La Liga 564 | 19732648 | `e556abac3cd0a314f4ef88e683217bbdb7524248fbe3575777ccc30101be7fd1` | 2026-10-25 20:00 | 83 FC Barcelona | 3468 Real Madrid | LL-J10 exact |
| Serie A 384 | 19713536 | `d025b2a3369414e024f69e7a47f83af5cc2b933972f2e74ba5925f64a52f7a02` | 2026-10-29 17:30 | 4070 Frosinone | 7790 Lecce | SA-MD9 exact |
| Serie A 384 | 19713537 | `531908e3b04bf538b70771aed781c683195bb01c565f4d10e46ed8dd1c9b0341` | 2026-10-29 19:45 | 109 Fiorentina | 708 Atalanta | SA-MD9 exact |
| Ligat ha'Al 372 | 19721180 | `a3bffbc2ffb4550aa908e8db8d162a31f50d62db4969cff9ea693988b664c48c` | **2026-10-26 17:30** | 571 Maccabi Haifa | 516 Hapoel Be'er Sheva | IFA-MD8 pair/date; **kickoff discrepancy, see §8** |
| Ligat ha'Al 372 | 19721184 | `69b04a168d918ca398f0e092b4b397cb4ee3f3322dbdce37305c9f5d6f8e3ddc` | 2026-10-25 18:15 | 6900 Hapoel Petah Tikva | 589 Beitar Jerusalem | IFA-MD8 exact |

## 4. Competition reconciliation proposal

All five rows already point to the intended canonical competition and are `manual_override`.

| Sportmonks id | Provider name | Canonical competition id | Current status | Proposed action |
| ---: | --- | --- | --- | --- |
| 8 | Premier League | `ccdbb89d-e575-4e15-820d-f5d1ecdc3a85` | manual_override | attest only |
| 82 | Bundesliga | `11ef12f9-86cf-4634-9ed7-cf9f7113e214` | manual_override | attest only |
| 372 | Ligat ha'Al | `06b70ffa-847c-44d2-a346-3683ac9115c3` | manual_override | attest only |
| 384 | Serie A | `a2b7daf8-1d1d-4b79-8801-b47ad6cde38c` | manual_override | attest only |
| 564 | La Liga | `2116127b-f4f6-40d5-bdbc-bc60cb70dc0d` | manual_override | attest only |

Proposed basis: `multi_source_verified`.

Evidence for every competition must include:
- A2-B entitlement snapshot hash;
- artifact digest;
- the official competition source key;
- duplicate-audit hash of the current canonical competition catalog;
- reviewer/operator label.

No competition mapping mutation is proposed.

## 5. Team reconciliation proposal

### 5.1 Existing mapping, existing canonical team — promote then attest (5)

These rows existed before D-058 at `confirmed` confidence 1. They are **not grandfathered**.

| SM id | Provider name | Existing canonical id | Canonical name | Current | Proposed |
| ---: | --- | --- | --- | --- | --- |
| 3 | Sunderland | `60b20670-8dcd-4091-85b2-1053446cab54` | סנדרלנד | confirmed/1 | promote exact row to manual_override, then attest |
| 71 | Leeds United | `72bfd482-213d-4b7f-8939-544eb4329682` | לידס | confirmed/1 | promote exact row, then attest |
| 516 | Hapoel Be'er Sheva | `8430f0cd-e215-4ba9-858e-ae1707b9d37c` | הפועל באר שבע | confirmed/1 | promote exact row, then attest |
| 571 | Maccabi Haifa | `40b796e4-b939-4160-a24a-044e8bc703fb` | מכבי חיפה | confirmed/1 | promote exact row, then attest |
| 6900 | Hapoel Petah Tikva | `2a4abd6e-816d-46b8-8554-33e4205ebe38` | הפועל פתח תקווה | confirmed/1 | promote exact row, then attest |

Each promotion must:
- use `kapiloto.identity_operator = 'on'`;
- include provider id **and expected canonical id/status/confidence** in the `WHERE`;
- assert exactly one changed row;
- run separately from the attestation RPC.

### 5.2 No Sportmonks mapping, but canonical team already exists — attach then attest (2)

| SM id | Provider name | Existing canonical id | Canonical name | Country | Proposed |
| ---: | --- | --- | --- | --- | --- |
| 52 | AFC Bournemouth | `fcd3541d-c509-4d27-ac8d-6c403ef629e1` | בורנמות' | GB | insert manual_override mapping, add provider-name alias if absent, then attest |
| 676 | Sevilla | `f1cc2c0b-b7a3-40f7-a18f-423fdc71344b` | סביליה | ES | insert manual_override mapping, add provider-name alias if absent, then attest |

Before insert, re-check:
- provider ref is still unmapped;
- no other Sportmonks ref maps to the canonical id;
- the canonical row and country are unchanged;
- duplicate audit still resolves to the same single canonical target.

### 5.3 Canonical team absent — proposed canonical creation (13)

The production canonical catalog was reviewed across GB/ES/DE/IT/IL **and rows with null country**. No existing canonical/alias candidate was found for these 13 identities.

| SM id | Provider name | Country | Proposed canonical name | Provider alias to add | Evidence |
| ---: | --- | --- | --- | --- | --- |
| 14 | Manchester United | GB | מנצ'סטר יונייטד | Manchester United | PL-CLUBS + PL-MW + capture 19722125 |
| 83 | FC Barcelona | ES | ברצלונה | FC Barcelona | LL-CLUBS + LL-J10 + capture 19732648 |
| 109 | Fiorentina | IT | פיורנטינה | Fiorentina | SA-CLUBS + SA-MD9 + capture 19713537 |
| 459 | Osasuna | ES | אוססונה | Osasuna | LL-CLUBS (`CA Osasuna`) + LL-J10 + capture 19732644 |
| 503 | FC Bayern München | DE | באיירן מינכן | FC Bayern München | BL-CLUBS + BL-MD7 + capture 19735139 |
| 589 | Beitar Jerusalem | IL | בית"ר ירושלים | Beitar Jerusalem | IFA-MD8 + capture 19721184 |
| 708 | Atalanta | IT | אטאלנטה | Atalanta | SA-CLUBS + SA-MD9 + capture 19713537 |
| 2726 | TSG Hoffenheim | DE | הופנהיים | TSG Hoffenheim | BL-CLUBS + BL-MD7 + capture 19735140 |
| 3321 | Bayer 04 Leverkusen | DE | באייר לברקוזן | Bayer 04 Leverkusen | BL-CLUBS + BL-MD7 + capture 19735140 |
| 3468 | Real Madrid | ES | ריאל מדריד | Real Madrid | LL-CLUBS + LL-J10 + capture 19732648 |
| 3543 | SC Freiburg | DE | פרייבורג | SC Freiburg | BL-CLUBS + BL-MD7 + capture 19735139 |
| 4070 | Frosinone | IT | פרוזינונה | Frosinone | SA-CLUBS + SA-MD9 + capture 19713536 |
| 7790 | Lecce | IT | לצ'ה | Lecce | SA-CLUBS + SA-MD9 + capture 19713536 |

Creation is proposed, not approved.

For each team, the operator transaction would:
1. re-run the country + null-country team/alias duplicate audit;
2. assert the Sportmonks provider ref is still absent;
3. insert one `teams` row;
4. insert the Sportmonks English name as an `en` alias (`source = 'sportmonks_reconciliation'`);
5. insert the Sportmonks mapping as `manual_override` with confidence 1 and `last_verified_at = statement_timestamp()`;
6. assert exactly one new provider mapping and no injectivity conflict;
7. commit.

Attestation is a **separate transaction/RPC** after the creation transaction commits.

The Hebrew canonical spelling is operator-owned data. Independent review should explicitly approve the 13 proposed Hebrew spellings before any insert.

## 6. Proposed attestation evidence contract

Proposed basis for all 25 attestations (5 competitions + 20 teams):

`multi_source_verified`

Example team evidence:

```json
{
  "contract_version": "kapiloto-provider-identity-attestation-evidence-v1",
  "sources": [
    {
      "kind": "sportmonks_a2b_artifact",
      "artifact_id": "13010316459",
      "artifact_sha256": "3b01187a6ce6b63621a40f34d384c2ba6d8231aa0c45a72504ab46a1f6900ad3",
      "provider_fixture_id": "19722125",
      "raw_payload_sha256": "e5c49cc01290c1ccaa22c298ab8008600013f4312a0fc70b771217d6307c9411"
    },
    {
      "kind": "official_competition",
      "source_key": "PL-MW"
    }
  ],
  "reviewed_by": "kapiloto-v4-pilot-identity-reconciliation-2026-10-31",
  "duplicate_audit_sha256": "<computed immediately before write>",
  "decision": "sportmonks:14 -> canonical Manchester United"
}
```

The duplicate audit hash is **not** precomputed in this document. It must be generated from the actual pre-write database snapshot, so a later catalog change cannot reuse a stale duplicate review.

## 7. Write sequence if the plan is approved

### R1 — capture a pre-write reconciliation snapshot

Read-only export of:
- all 5 competition mappings;
- all 20 target team mappings;
- canonical team/alias candidates;
- current Sportmonks injectivity report;
- current readiness/conflict reports.

Hash the snapshot and record it in the operation note.

### R2 — attest five competitions

One RPC call / one transaction per competition.

Expected after R2:
- 5 active competition attestations;
- no team attestation yet;
- no mapping mutation;
- no Match Ledger observation.

### R3 — promote the five existing team mappings

One guarded operator transaction per row with exact expected-old predicates.

Do **not** attest in the same transaction.

### R4 — create mappings for Bournemouth and Sevilla

One operator transaction per identity.

Do not create a new canonical team.

### R5 — create 13 canonical teams + mappings

One operator transaction per identity.

If any duplicate audit is ambiguous, stop that identity and leave it unresolved. Do not create it merely to complete the pilot.

### R6 — attest 20 teams

One attestation RPC / one transaction per team.

### R7 — post-write validation

Must all pass:

- exactly 5 active pilot competition attestations;
- exactly 20 active pilot team attestations;
- all 25 corresponding mappings are `manual_override`;
- no Sportmonks team/competition injectivity violation;
- `provider_identity_attestation_conflicts('sportmonks')` has no blocking issue for the pilot refs;
- `match_ledger_provider_ref_conflicts_v2('sportmonks')` remains empty;
- Match Ledger observation count remains `0`;
- V1 and V2 ingest remain revoked from `service_role`;
- Stage 0 identity-mapping guards remain enabled.

No fixture mapping should be created by R1–R7.

## 8. Explicit discrepancy: Maccabi Haifa–Hapoel Beer Sheva

Sportmonks capture `19721180` records kickoff `2026-10-26 17:30:00` UTC.

The Israel Football Association records the same Matchday 8 pair, orientation and date at **19:00 Israel time**, i.e. **17:00 UTC** on 2026-10-26.

This 30-minute discrepancy is material and must stay visible.

Decision proposed for review:
- it does **not** block team identity attestation for Sportmonks ids 571/516 because identity is supported independently by existing canonical mappings, provider participant names, IFA team/fixture evidence and the competition mapping;
- it **does** block treating capture `19721180` as an exact kickoff cross-check;
- the discrepancy must be carried into PR #19/A2-B amendment and considered by the later fixture-identity pilot;
- V2 ingest must still independently classify the canonical fixture under D-058 rather than inheriting trust from this reconciliation.

## 9. Items that remain outside this reconciliation

This plan does not:

- enable V2 ingest;
- create a `provider_ingest_run`;
- create or change any provider fixture mapping;
- persist any Match Ledger observation;
- amend/run PR #19;
- solve the uncovered squad-state/1A historical readers that still block M2B;
- start a backfill.

## 10. Review questions before any write

Independent reviewers should answer:

1. Are the 13 canonical creations justified, or does any proposed identity have a plausible existing canonical duplicate?
2. Are the proposed Hebrew canonical names acceptable and consistent with the existing catalog?
3. Is `multi_source_verified` appropriate for all 25 attestations?
4. Are the official source anchors sufficient when combined with the captured Sportmonks fixture/participant ids?
5. Does the 30-minute Maccabi Haifa–Hapoel Beer Sheva discrepancy block only fixture-time evidence, or should it block either team attestation?
6. Should Bournemouth/Sevilla attach to the existing canonical ids shown above?
7. Is one operator transaction per mapping/canonical creation plus one separate attestation RPC per identity the safest operational sequence?
8. Is any additional pre-write injectivity or alias collision check required?
9. Should any of the 13 new canonical teams use a different canonical spelling?
10. Is there any reason to postpone competition attestations until team reconciliation is complete?

No write begins until these questions are resolved and the exact write plan is approved.