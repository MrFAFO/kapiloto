# Kapiloto V4 — Pilot Identity Reconciliation Plan

Status: **independent-review reconciled; identity decisions approved; production writes still gated by this runbook**  
Date: 2026-10-31  
Depends on: D-057, D-058, M2A production migration `20261031100000_kapiloto_v4_identity_attestations.sql`

This document is the reviewed operator plan for reconciling the five A2-B Sportmonks competitions and the 20 teams observed in the ten-fixture real-payload pilot.

Two independent adversarial reviews were completed against the original PR #28 plan. Both accepted the proposed real-world identities. Their procedural blockers are folded into this revision. No identity write was performed while the reviews were running.

The rules below are fail-closed. A failed assertion stops that identity. No operation exists merely to "make the pilot pass".

## 1. Verified production baseline

M2A production post-checks already established:

- V1 and V2 provider ingest are revoked from `service_role`;
- `private` is not exposed through Supabase Data API;
- Match Ledger has `0` observations;
- no team/competition attestation, event or observation sidecar existed before reconciliation;
- all five pilot competition mappings are `manual_override`;
- no Sportmonks team injectivity violation exists;
- `match_ledger_provider_ref_conflicts_v2('sportmonks')` is empty;
- readiness contains only expected `mapping_unattested` informational rows.

### R1 baseline snapshot — completed read-only

Captured from production at:

`2026-10-31T11:59:07.339225Z`

Contract:

`kapiloto-v4-pilot-r1-snapshot-v1`

SHA-256:

`99c7db9c9f2c6468fb9ff21d69f6a7f0f537920c7a615d6cc4d755768626f36a`

Counts frozen by the snapshot:

| Object | Count |
| --- | ---: |
| canonical teams | 51 |
| team aliases | 57 |
| provider team mappings | 78 |
| Sportmonks team mappings | 36 |
| team attestations | 0 |
| competition attestations | 0 |
| Match Ledger observations | 0 |

The snapshot also froze:
- all five target competition mappings;
- all 20 target Sportmonks team mapping states;
- identity candidates found through canonical names, aliases and provider names;
- Sportmonks injectivity conflicts: `[]`;
- provider-ref conflicts V2: `[]`;
- readiness: only `mapping_unattested`.

The exact R1 query uses `private.normalize_entity_alias` and hashes the canonical JSON result with SHA-256. This is the global operation baseline, not the per-identity duplicate hash used in attestation evidence.

## 2. A2-B provider evidence

GitHub Actions run: `41124224068`  
Artifact: `13010316459` — `kapiloto-v4-sportmonks-a2b-pilot`  
Artifact digest: `sha256:3b01187a6ce6b63621a40f34d384c2ba6d8231aa0c45a72504ab46a1f6900ad3`  
Entitlement snapshot SHA-256: `645917dcce248bd9c730c3795b73113b265be0f36d3c970696c9c566cdc78725`

The artifact freezes Sportmonks league ids, fixture ids, participant ids/names, orientation, kickoff and raw response hashes.

| League | SM fixture | Raw SHA-256 | Sportmonks kickoff UTC | Home | Away |
| --- | ---: | --- | --- | --- | --- |
| Premier League 8 | 19722124 | `9c10f18b25452207bfdd3af5122890bf4c8f7f7966d153d63227aa03e8edaeec` | 2026-10-25 16:30 | 3 Sunderland | 71 Leeds United |
| Premier League 8 | 19722125 | `e5c49cc01290c1ccaa22c298ab8008600013f4312a0fc70b771217d6307c9411` | 2026-10-25 14:00 | 14 Manchester United | 52 AFC Bournemouth |
| Bundesliga 82 | 19735139 | `22e54178f1204a98c9fde9ac6f12a9cc2469c08fedd7076b9a5f5638faa8a6c7` | 2026-10-25 16:30 | 3543 SC Freiburg | 503 FC Bayern München |
| Bundesliga 82 | 19735140 | `c765b1a9760d1d7184e036d027d80d62d3e591b962af6c877a1b8af81dd8e140` | 2026-10-25 14:30 | 2726 TSG Hoffenheim | 3321 Bayer 04 Leverkusen |
| La Liga 564 | 19732644 | `3357620c409f929143c73ba956a597bbb5f0abf2d218edf43c625547edf46959` | 2026-10-26 20:00 | 676 Sevilla | 459 Osasuna |
| La Liga 564 | 19732648 | `e556abac3cd0a314f4ef88e683217bbdb7524248fbe3575777ccc30101be7fd1` | 2026-10-25 20:00 | 83 FC Barcelona | 3468 Real Madrid |
| Serie A 384 | 19713536 | `d025b2a3369414e024f69e7a47f83af5cc2b933972f2e74ba5925f64a52f7a02` | 2026-10-29 17:30 | 4070 Frosinone | 7790 Lecce |
| Serie A 384 | 19713537 | `531908e3b04bf538b70771aed781c683195bb01c565f4d10e46ed8dd1c9b0341` | 2026-10-29 19:45 | 109 Fiorentina | 708 Atalanta |
| Ligat ha'Al 372 | 19721180 | `a3bffbc2ffb4550aa908e8db8d162a31f50d62db4969cff9ea693988b664c48c` | 2026-10-26 17:30 | 571 Maccabi Haifa | 516 Hapoel Be'er Sheva |
| Ligat ha'Al 372 | 19721184 | `69b04a168d918ca398f0e092b4b397cb4ee3f3322dbdce37305c9f5d6f8e3ddc` | 2026-10-25 18:15 | 6900 Hapoel Petah Tikva | 589 Beitar Jerusalem |

## 3. Independent official and cross-provider evidence

### Competition sources

| Key | Source |
| --- | --- |
| PL-CLUBS | `https://www.premierleague.com/en/news/4365156` |
| PL-MW | `https://www.premierleague.com/en/news/4688862/fixture-amendments-for-premier-league-matches-in-october-and-november/` |
| BL-CLUBS | `https://www.bundesliga.com/en/bundesliga/clubs` |
| BL-MD7 | `https://www.bundesliga.com/en/bundesliga/matchday/2026-2027/7/` |
| LL-CLUBS | `https://www.laliga.com/en-US/laliga-easports/clubs` |
| LL-J10 | `https://www.laliga.com/en-GB/laliga-easports/results/2026-27/gameweek-10` |
| SA-CLUBS | `https://www.legaseriea.it/serie-a/statistiche/clubs` |
| SA-MD9 | `https://en.legaseriea.it/serie-a/news/the-referees-for-the-9th-round-x4306` |
| IFA-MD8 | `https://www.football.org.il/leagues/games/?league_id=40` |

Production cross-provider competition mappings independently agree with the five canonical competition ids:

| Canonical competition | Sportmonks | Independent provider refs |
| --- | ---: | --- |
| Premier League | 8 | API-Football 39 |
| Bundesliga | 82 | API-Football 78 |
| Ligat Ha'al | 372 | API-Football 383; football-il-parse 902 |
| Serie A | 384 | API-Football 135 |
| La Liga | 564 | API-Football 140 |

No Sportmonks mapping row created or rewritten by V3 is counted as independent evidence.

### Telesport/Winner canonical spelling evidence

The canonical Hebrew spellings used by Toto matter structurally: the current Toto import selects `teams` by `lower(trim(canonical_name)) + country_code`; aliases do not prevent a duplicate.

The following spellings are now evidenced by Telesport/Winner rather than convention alone:

| SM id | Provider name | Canonical spelling | Telesport evidence |
| ---: | --- | --- | --- |
| 14 | Manchester United | מנצ'סטר יונייטד | repo `scripts/provider-spike.round-264101.json`; current Telesport results/broadcasts |
| 83 | FC Barcelona | ברצלונה | `https://m.telesport.co.il/winner-16/global`; current Winner board |
| 109 | Fiorentina | פיורנטינה | `https://m.telesport.co.il/article/recommendations/6ae301b4eb56be0f63dfd894` |
| 459 | Osasuna | אוסאסונה | `https://m.telesport.co.il/article/recommendations/6a954b571a5985b0cb93c0ab`; Telesport broadcasts |
| 503 | FC Bayern München | באיירן מינכן | `https://m.telesport.co.il/winner-16/global` |
| 589 | Beitar Jerusalem | בית"ר ירושלים | repo `scripts/provider-spike.round-264101.json`; current Winner board |
| 708 | Atalanta | אטאלנטה | `https://m.telesport.co.il/article/recommendations/6ae301b4eb56be0f63dfd894` |
| 2726 | TSG Hoffenheim | הופנהיים | repo `scripts/provider-spike.round-264101.json` |
| 3321 | Bayer 04 Leverkusen | באייר לברקוזן | current Telesport Winner board / game page |
| 3468 | Real Madrid | ריאל מדריד | `https://www.telesport.co.il/broadcasts` |
| 3543 | SC Freiburg | פרייבורג | current Telesport Winner board |
| 4070 | Frosinone | פרוסינונה | `https://www.telesport.co.il/game/6432774` |
| 7790 | Lecce | לצ'ה | `https://www.telesport.co.il/game/6432774` |

This resolves the first independent review's spelling blocker. Before the first write, the operation note must freeze the retrieved-at timestamp and the relevant minimal source excerpt or content hash for each dynamic page. The immutable PR commit records the reviewed extracted spelling and source URL, but it is not a substitute for the pre-write evidence pack.

## 4. Review reconciliation

Both independent reviews accepted:
- all five competition identities;
- the five existing team mappings;
- Bournemouth -> existing `בורנמות'`;
- Sevilla -> existing `סביליה`;
- the real-world identity of all 13 proposed new teams.

The first review returned a partial GO because:
1. three Winner-known teams might already exist;
2. ten proposed Hebrew spellings lacked Winner evidence;
3. duplicate-audit semantics were underspecified.

Runtime reconciliation resolved (1): production still has 51 teams and none of the 13 proposed new canonical rows exists under the reviewed canonical spellings. The expanded candidate audit also found no alias/provider-name collision.

Telesport evidence in §3 resolves (2).

This revision resolves (3) with an atomic per-identity audit in §8.

The second review independently observed the same production catalog and approved all 25 identity decisions, but found two procedural blockers:
1. the duplicate audit was not atomic with the write;
2. operator predicates were not required to include `provider = 'sportmonks'`.

Both are mandatory below.

## 5. Competition decisions — APPROVED

All five existing Sportmonks rows remain `manual_override` and point to the intended canonical competition.

| SM id | Canonical id | Decision |
| ---: | --- | --- |
| 8 | `ccdbb89d-e575-4e15-820d-f5d1ecdc3a85` | attest |
| 82 | `11ef12f9-86cf-4634-9ed7-cf9f7113e214` | attest |
| 372 | `06b70ffa-847c-44d2-a346-3683ac9115c3` | attest |
| 384 | `a2b7daf8-1d1d-4b79-8801-b47ad6cde38c` | attest |
| 564 | `2116127b-f4f6-40d5-bdbc-bc60cb70dc0d` | attest |

Basis: `multi_source_verified`.

Competition attestations do not wait for teams. Competition injectivity is independent, and M2A ingest remains disabled.

## 6. Team decisions — APPROVED identities

### A. Existing mapping -> promote to manual_override -> attest

| SM id | Provider name | Canonical id | Canonical name | Independent evidence |
| ---: | --- | --- | --- | --- |
| 3 | Sunderland | `60b20670-8dcd-4091-85b2-1053446cab54` | סנדרלנד | API-Football 746; Toto fixture; PL evidence |
| 71 | Leeds United | `72bfd482-213d-4b7f-8939-544eb4329682` | לידס | API-Football 63; Toto fixture; PL evidence |
| 516 | Hapoel Be'er Sheva | `8430f0cd-e215-4ba9-858e-ae1707b9d37c` | הפועל באר שבע | Toto/IFA fixture evidence |
| 571 | Maccabi Haifa | `40b796e4-b939-4160-a24a-044e8bc703fb` | מכבי חיפה | football-il-parse 4539; Toto/IFA fixture evidence |
| 6900 | Hapoel Petah Tikva | `2a4abd6e-816d-46b8-8554-33e4205ebe38` | הפועל פתח תקווה | football-il-parse 4542; API-Football 4488; distinct Maccabi Petah Tikva row |

The existing confidence value is left unchanged. D-058 does not treat it as trust.

### B. Existing canonical team, missing Sportmonks mapping -> attach -> attest

| SM id | Provider name | Canonical id | Canonical name |
| ---: | --- | --- | --- |
| 52 | AFC Bournemouth | `fcd3541d-c509-4d27-ac8d-6c403ef629e1` | בורנמות' |
| 676 | Sevilla | `f1cc2c0b-b7a3-40f7-a18f-423fdc71344b` | סביליה |

Production has exactly one reviewed canonical candidate for each and currently no Sportmonks 52/676 row.

### C. Canonical absent -> create -> map -> attest

Production contains none of the following canonical teams under the reviewed normalized canonical/provider names.

| SM id | Provider name | Country | Canonical name |
| ---: | --- | --- | --- |
| 14 | Manchester United | GB | מנצ'סטר יונייטד |
| 83 | FC Barcelona | ES | ברצלונה |
| 109 | Fiorentina | IT | פיורנטינה |
| 459 | Osasuna | ES | אוסאסונה |
| 503 | FC Bayern München | DE | באיירן מינכן |
| 589 | Beitar Jerusalem | IL | בית"ר ירושלים |
| 708 | Atalanta | IT | אטאלנטה |
| 2726 | TSG Hoffenheim | DE | הופנהיים |
| 3321 | Bayer 04 Leverkusen | DE | באייר לברקוזן |
| 3468 | Real Madrid | ES | ריאל מדריד |
| 3543 | SC Freiburg | DE | פרייבורג |
| 4070 | Frosinone | IT | פרוסינונה |
| 7790 | Lecce | IT | לצ'ה |

New manual-override mappings use `mapping_confidence = NULL`.

Reason: confidence is not the D-058 trust root, and writing `1` would unnecessarily recreate the old "confidence 1 looks trusted" convention that Stage 1 deliberately replaced.

## 7. Alias policy

Every newly attached/created identity gets its exact Sportmonks English provider name as an `en` alias when not already present.

For newly created teams, seed only reviewed useful Hebrew variants. At minimum:

- Manchester United: `מנצ׳סטר יונייטד`
- Beitar Jerusalem: `ביתר ירושלים`, `בית״ר ירושלים`
- Lecce: `לצ׳ה`

For existing Bournemouth, add `בורנמות׳` if absent.

Aliases help V3/provider matching and audits. They **do not** prevent Toto duplicates because Toto's current team lookup ignores aliases.

Do not seed speculative aliases merely to increase recall.

## 8. Atomic duplicate/collision audit — mandatory

### 8.1 Audit scope

For one target identity the audit covers:

1. every `public.teams` row, regardless of country;
2. every `public.team_aliases` row;
3. every `public.provider_team_mappings` row from every provider;
4. the specific Sportmonks provider ref;
5. current Sportmonks injectivity for the proposed canonical team.

All text matching uses the existing immutable DB function:

`private.normalize_entity_alias(text)`

That function normalizes geresh/gershayim variants, apostrophes, maqaf/dash variants, Hebrew marks, whitespace and case.

Inputs include:
- reviewed Hebrew canonical name;
- reviewed Hebrew punctuation variants;
- Sportmonks provider name;
- any official/provider variant explicitly included in the evidence pack.

### 8.2 Transaction rule for a canonical creation or attach

Each R4/R5 identity transaction must:

1. `SET LOCAL lock_timeout = '5s'`;
2. take:

   `LOCK TABLE public.teams, public.team_aliases, public.provider_team_mappings IN SHARE ROW EXCLUSIVE MODE`;

3. run the identity-scoped audit **after the locks are held**;
4. serialize the exact audit rows plus audit-query-version into canonical JSON;
5. compute SHA-256;
6. abort unless the result has exactly the expected candidate shape;
7. perform the mapping/canonical/alias write;
8. re-run the relevant candidate/injectivity assertions before commit;
9. return the audit hash for the later attestation evidence.

This in-transaction hash is the authoritative `duplicate_audit_sha256`.

The R1 global snapshot hash is not reused as an identity duplicate hash.

### 8.3 Provider qualification

Every operator mapping statement and assertion must explicitly include:

`provider = 'sportmonks'`

Provider id values are not globally unique. Production already demonstrates collisions, e.g. provider team id `52` means different clubs in different providers.

Existing-row promotion predicates must include:
- `provider = 'sportmonks'`;
- exact `provider_team_id`;
- expected `team_id`;
- expected `mapping_status = 'confirmed'`;
- expected existing `mapping_confidence`;
- one-row assertion.

New mapping prechecks/inserts must include:
- `provider = 'sportmonks'`;
- exact provider ref;
- exact proposed canonical id;
- expected provider ref absent or the R4 race branch below.

## 9. Concurrency and partial-failure rules

### V3 race branch for R4

If Sportmonks 52 or 676 is inserted by V3 before the operator insert:

- if it points to the reviewed canonical team and is `confirmed`, do not insert;
- route it through the exact R3 promotion path;
- if it points anywhere else, stop and investigate;
- never use `ON CONFLICT DO UPDATE` to force the reviewed answer.

The same rule applies if V3 inserts any R5 target provider ref before its operator transaction.

### Toto/import race

The R4/R5 table locks make the audit atomic against concurrent Toto team creation and V3 mapping inserts during each short identity transaction.

Per-identity transactions are retained for R5. One ambiguous identity must not roll back or contaminate verified siblings.

A committed correct mapping with a failed later attestation is safe under D-058: it remains `mapping_unattested` and cannot enter V2 trusted reads.

### Active round 264301 side effect

Production round `264301` currently contains:

- game 10: Bournemouth–Leeds, kickoff `2026-10-31T15:00:00Z`;
- game 12: Getafe–Sevilla, kickoff `2026-11-01T13:00:00Z`.

Adding Sportmonks 52/676 can let V3 create correct current-round fixture mappings on a later precompute cycle.

This is not a V4 trust write, but it is a live production side effect.

Default operational choice: **defer R4 for 52/676 until round 264301 is settled**. If an operator explicitly chooses to run it earlier, the operation note must record acceptance of this side effect and compare provider fixture mappings before/after.

## 10. Attestation evidence contract

Basis for all 25 identities:

`multi_source_verified`

Evidence must never cite the V3-created Sportmonks mapping row itself as independent identity evidence.

Each evidence object includes, as applicable:

- A2-B artifact id and SHA-256;
- provider fixture id and raw payload SHA-256;
- exact official competition source;
- independent API-Football / football-il mapping when available;
- Toto/Winner fixture id or reviewed canonical row where applicable;
- exact Telesport canonical-spelling source for new teams;
- score anchor where available;
- source local time, time zone and UTC conversion where kickoff is used;
- immutable reconciliation-plan commit;
- pre-write evidence retrieval timestamp/hash or archived minimal excerpt;
- explicit operator Hebrew-English equivalence assertion when attaching an English provider identity to an existing Hebrew row;
- authoritative in-transaction `duplicate_audit_sha256`;
- reviewer/operator label.

Example:

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
    },
    {
      "kind": "telesport_spelling",
      "canonical_name": "מנצ'סטר יונייטד",
      "source": "scripts/provider-spike.round-264101.json"
    }
  ],
  "reviewed_by": "kapiloto-v4-pilot-identity-reconciliation-2026-10-31",
  "duplicate_audit_sha256": "<hash returned by locked identity transaction>",
  "decision": "sportmonks:14 -> canonical Manchester United"
}
```

Every attestation RPC remains a separate transaction because D-058's first-write rule requires it.

## 11. Maccabi Haifa–Hapoel Beer Sheva kickoff discrepancy — resolved

Sportmonks capture `19721180` stores:

`2026-10-26T17:30:00Z` = 19:30 Israel time.

The canonical Toto/IFA schedule held 19:00 Israel time = `17:00Z`.

Contemporary reports establish that the match was originally scheduled for 19:00 and was delayed by 30 minutes on match day because of exceptional traffic around Sammy Ofer. It actually began at 19:30.

Therefore:

- Sportmonks is not evidence of a wrong fixture;
- the canonical/Toto row represents scheduled time;
- Sportmonks represents the updated actual kickoff;
- this does not block ids 571 or 516;
- this does not block competition 372;
- the evidence must retain both timestamps and the reason;
- fixture identity must continue to rely on pair/orientation/competition/date plus D-058 classification, never exact kickoff alone.

Sources:
- `https://www.ynet.co.il/sport/israelisoccer/article/syhul116nml`
- `https://m.sport5.co.il/articles.aspx?FolderID=64&docID=565316&showHeader=false`

This is a useful A2-B regression case for scheduled-vs-actual provider kickoff semantics.

## 12. Reviewed execution sequence

### R1 — global read-only snapshot

**DONE.**

Snapshot hash and counts are in §1.

Before the first write, also freeze the minimal dynamic-web evidence pack used by the attestation sources, with retrieval timestamps and hashes/immutable excerpts.

### R2 — attest five competitions

One RPC / one transaction per competition.

Preconditions:
- mapping still exists;
- still `manual_override`;
- still points to reviewed canonical id;
- no active attestation;
- cross-provider evidence still agrees.

Expected:
- 5 active competition attestations;
- 5 competition attest events;
- no team attestation;
- no Match Ledger write.

### R3 — promote five existing team mappings

One short guarded operator transaction per identity.

- `SET LOCAL kapiloto.identity_operator = 'on'`;
- provider-qualified exact-old predicates;
- mapping status changes `confirmed -> manual_override`;
- confidence is left unchanged;
- assert one row;
- do not attest in the same transaction.

Then R6 may attest each successful identity separately.

### R4 — attach Bournemouth and Sevilla

Default: defer until production round 264301 settles.

For each:
- locked atomic audit from §8;
- if provider row remains absent: insert manual_override mapping with `mapping_confidence = NULL`;
- if V3 inserted the reviewed confirmed row first: promote it instead;
- add exact English Sportmonks alias if absent;
- add reviewed punctuation alias where specified;
- assert no injectivity/collision;
- commit;
- attest later via R6.

### R5 — create 13 canonical teams + mappings

One identity per transaction.

For each:
- locked atomic audit from §8;
- require no existing canonical/alias/provider candidate;
- require Sportmonks ref absent;
- create exactly one canonical row with the exact Telesport-evidenced Hebrew name and reviewed country;
- insert English Sportmonks alias;
- insert only reviewed Hebrew punctuation aliases;
- insert mapping:
  - provider = `sportmonks`;
  - provider ref exact;
  - `mapping_status = 'manual_override'`;
  - `mapping_confidence = NULL`;
  - provider name exact;
  - `last_verified_at = statement_timestamp()`;
- assert candidate uniqueness and Sportmonks injectivity again;
- commit;
- attest later via R6.

Any ambiguity aborts only that identity.

### R6 — attest successful team identities

One RPC / one transaction per team.

No batch transaction.

The evidence object uses the identity transaction's locked duplicate-audit hash.

### R7 — post-write validation

Required assertions:

- exactly 5 active pilot competition attestations;
- exactly 20 active pilot team attestations only when all 20 identities have completed;
- every pilot mapping is `manual_override`;
- new manual mappings have confidence null; five legacy rows retain their old confidence;
- exactly one initial `attest` event per completed identity, no unexpected refresh/revoke;
- no `shadow_mapping_for_attested_canonical`;
- no Sportmonks team/competition injectivity violation;
- no unexpected folded canonical/alias duplicate;
- no `mint_without_mapping`;
- provider-ref-conflicts V2 remains empty;
- Match Ledger observations remain `0`;
- V1/V2 ingest remain revoked from `service_role`;
- Stage 0 guards remain enabled;
- before/after counts for teams, aliases and mappings match the successful operation ledger;
- if all 13 R5 creations succeed from the R1 baseline, canonical team count is exactly `64`.

After the next two natural precompute cycles and the next Toto round import:
- rerun the duplicate/collision audit;
- rerun readiness/conflict reports;
- check that no canonical duplicate appeared.

The operation note records, per identity:
- step;
- preconditions;
- audit hash;
- rows changed;
- canonical id;
- attestation event/generation;
- result;
- stop reason if failed.

## 13. Rollback and recovery

### Wrong mapping before attestation

Correct or delete it under the D-057 operator override. It carries no D-058 trust without attestation.

### Wrong active attestation

1. revoke through the audited D-058 RPC;
2. repair mapping in a separate operator transaction;
3. re-attest in a new generation if corrected.

### Newly created canonical team

Delete only if:
- unattested or already revoked;
- no fixture/round/V4 row references it;
- its mapping/aliases are removed.

Once a Toto fixture or other production row references the canonical team, do not try to erase history. Use revoke/re-point/re-attest recovery.

Attestation event history is retained.

## 14. Explicit M2B follow-up blocker: Toto identity lookup

The current Toto import matches teams by exact canonical name + country and ignores aliases. It can create a null-country duplicate for a cup/European appearance even when a league-country canonical team already exists.

Before M2B historical Match Ledger activation, do one of:

1. implement a reviewed alias-aware, country-tolerant Toto identity resolver with versioned semantics; or
2. implement a standing post-import duplicate report/gate that blocks affected V4 consumers until resolved.

This issue does not invalidate the 25 pilot identities. It is a downstream canonical-consistency blocker before historical ingest is activated.

## 15. Final GO/NO-GO after independent reviews

Identity decisions:

- 5/5 competitions: **GO**
- 5/5 existing team mapping promotions: **GO**
- Bournemouth/Sevilla existing-canonical attachments: **GO identity decision**
- 13/13 canonical creations: **GO identity decision**

Operational execution:

- R1: **DONE**
- R2: **GO after dynamic source evidence pack is frozen**
- R3: **GO after dynamic source evidence pack is frozen**
- R4: **DEFER by default until round 264301 settles**, unless live V3 side effect is explicitly accepted
- R5: **GO after dynamic source evidence pack is frozen and the exact locked transaction is reviewed immediately before execution**
- R6: **GO only for identities whose preceding mapping/canonical step succeeded**
- R7: mandatory

M2B remains **NO-GO**.

No provider ingest, provider-ingest run, fixture mapping, Match Ledger observation or backfill is authorized by this reconciliation plan.