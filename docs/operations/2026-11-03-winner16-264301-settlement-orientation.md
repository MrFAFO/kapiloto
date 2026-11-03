# Winner 16 round 264301 — swapped field scores and settlement repair (D-062)

Status: fix on branch `fix/winner16-settlement-safety-v2`. It is not merged, not deployed, and nothing in production has been changed. Round 264301 is **not** repaired.

## What production shows

Round 264301 was re-synced after all 16 games ended:
- 16 games are `finished`;
- the round is `under_review`;
- 3 games are `settled`: games 2, 3 and 9, all draws;
- 13 games are `under_review`.

The latest live sync reported `touchedGames 16, settledGames 0, underReviewGames 13`.

The stored `field_home_score`, `field_away_score` and `field_outcome` of the 13 non-draw games are swapped. Example: game 7, Liverpool–Arsenal, is stored as 1–0 with outcome 1; the real result is 0–1. The same swapped values were also written to `public.fixtures` (`home_score`, `away_score`).

## Root cause

The modern Telesport page writes the score away first, and the parser read it home first.

Evidence from `https://www.telesport.co.il/winner-16`, 2026-11-03:

1. **Component source.** The row component in Telesport's own JavaScript bundle renders:
   ```
   span.tt-team.tt-team1 = name_1
   span.tt-score         = status_id > 1 ? `${score_2} - ${score_1}` : "-"
   span.tt-team.tt-team2 = name_2
   span.tt-result        = result ?? "?"
   ```
   The classic desktop table component renders `<td class="scoreCol"><span>{score_1}</span> - <span>{score_2}</span></td>` and bolds `name_1` when `result` is 1 and `name_2` when it is 2.
2. **CSS.** The rules are `.tt-row { direction: rtl; display: flex }` and `.tt-score { direction: ltr }`. So team1 (home) is drawn on the right, team2 (away) on the left, and the score left to right between them. A visitor sees each number next to its team, so the page looks correct, while the DOM text is away–home. Neither Unicode BiDi nor the text extraction reverses anything: the DOM text itself is away first.
3. **Structured payload.** The server-rendered page embeds the same data, for example `{"toto_id":1,"result":"1","score_1":2,"score_2":1,"name_1":"הפועל תל אביב","name_2":"מכבי חיפה"}`. That is Hapoel Tel Aviv 2–1, yet the row text reads `1 - 2`.
4. **Same moment, both layouts.** With cookie `ts-design=classic`, the same page server-renders the classic table: game 1 is `<span>2</span> - <span>1</span>`. The modern row on that page reads `1 - 2`.
5. **Reproduction.** Running the old parser on the captured page reproduces the stored values exactly (1–2, 1–0, 0–2, 1–3, 1–3 for games 1, 7, 10, 12 and 15). Each of the 13 non-draw rows contradicts its own marker. For example, `Liverpool 1 - 0 Arsenal` has marker 2.

Verdict on "the score is simply reversed": partially confirmed. The modern layout is reversed for every status, live included. The classic table is not reversed. PR #50's global swap fixes the modern layout but breaks the table; a test on the real classic markup fails under it.

The legacy section parser (`<h2>ווינר 16 - מספר מחזור : N</h2>` plus `td` cells) does not engage on today's classic page verbatim, because React's `<!-- -->` text separators sit inside the heading. Both captured pages are therefore read by the modern parser. The legacy parser stays correct for the table layout it targets.

## Why fail-closed held, and its limits

The rule held where 365Scores could be matched:
- 9 games matched 365Scores. Their scores conflicted, and the outcomes agreed because the markers are right, so they stayed `under_review`.
- 4 games did not match 365Scores (games 4, 5, 6 and 11, because of different spellings) and stayed `under_review` as unverified.
- The 3 draws read the same either way, matched 365Scores and settled correctly.

No wrong `pool_settlement_outcome` was written.

Fail-closed did not protect field state. Field scores are written on every sync without any check. While games were live, provisional ticket and consensus results (`currently_hit` / `currently_miss`) were computed from the swapped `field_outcome`.

## Production path and gates

1. **Telesport fetch and parse.** Two entry points run the live sync:
   - `/api/internal/cron/round-sync` (Vercel, daily 05:17 UTC, or invoked manually) runs `runAutomaticRoundSync`, then `SupabaseCurrentRoundLoader`, then `runAutomaticLiveSync`;
   - `POST /api/v1/rounds/{roundId}/live-sync` runs it for any signed-in user, triggered from the round page.

   The sync fetches `winner-16` and calls `parseTelesportWinner16StateHtml`.
   - Gate: the round number on the page must equal the round being synced, otherwise the result is `source_round_mismatch`.
   - Gate: a round already marked `settled` is skipped.
   - Gate: a sync within 25 seconds of the previous one returns `fresh`.
2. **Telesport state.** Each game's status is mapped from the status text.
   - New: a finished row must have a readable score that agrees with its marker, otherwise it becomes `under_review` with no score.
3. **365Scores lookup.** Only dates with a finished game that has a marker are fetched. A fetch error leaves that date unverified.
4. **Identity match** (`matchScores365FinalResult`). Exact normalized names on both sides, same Israel date, ±6h kickoff, exactly one candidate. New: the reviewed 365Scores spellings are added.
5. **Payload** (`buildTelesportGameUpdate`).
   - The status never moves back from finished to live or upcoming.
   - A finished game with a marker is `settled` only if 365Scores agrees on score and outcome; new: Telesport's own score is also required. Otherwise it is `under_review`.
   - Exceptional statuses are `under_review`.
   - Settled and void games are skipped.
6. **`public.toto_apply_game_state_v1`** (one transaction per game).
   - It writes the field scores unconditionally and derives `field_outcome` from them.
   - `settlement_status` and `pool_settlement_outcome` are set only from the payload. A settled or void game refuses any different settlement (`game_state_settlement_immutable`).
   - It also writes `fixtures` (status and scores) and upserts `ticket_pick_results` and `consensus_pick_results`.
   - It recomputes the round status: `settled` only when every game is settled or void.

The Supabase Edge Function `kapiloto-live-sync` (pg_cron every 2 minutes) fetches `toto.aspx`, which now redirects to `winner-16`. It reads only the plain-text classic heading, finds none, and returns `winner16_section_not_found` without writing. Its deployed version was not verified.

## Remediation after merge and deploy (operator)

A normal sync repairs the round with no SQL, provided all of these hold:
- Telesport's current Winner 16 page still shows round 264301. Check with a read-only fetch first.
- No newer round is `open` or `upcoming` in Kapiloto. `chooseCurrentRound` prefers those over an `under_review` round.

Deploying the fix is effectively the repair. Two paths run the same live sync:
- the round page (`components/current-round-ticket.tsx`) calls `POST /api/v1/rounds/{roundId}/live-sync` for any signed-in user;
- the daily cron runs `round-sync`.

So the first page view after deploy may already settle the 13 games.

Steps:
1. Before deploying, run the read-only state query below and keep its output.
2. Merge and deploy to Vercel. No migration is needed.
3. If no page view has synced the round yet, invoke `/api/internal/cron/round-sync` once (Bearer `CRON_SECRET`). Expect `liveSync.value` to be `{status: "synced", settledGames: 13, underReviewGames: 0}`.
4. Run the query again. Every game should match the table below, and the round should be `settled`.
5. A later sync returns `round_settled` and writes nothing.

If 365Scores is unavailable for a date, the affected games stay `under_review`. Retry later; never settle them by hand.

**Contingency.** If Telesport has already moved to the next round, or a newer round is open, the normal sync can no longer reach 264301.
- `docs/operations/sql/winner16-264301-orientation-correction.sql` is the reviewed guarded correction. It holds frozen evidence per game and applies the normal rule to it (Telesport score = 365Scores score, marker = outcome).
- Per game it compares and sets: correct and settled is skipped; the stored swapped or already-corrected score under review is settled through `toto_apply_game_state_v1`; any other state aborts with no effect.
- It is tested on the real migration chain. It is **not applied** and needs a separate review and explicit approval.

### Expected result per game

| # | Home – Away | Stored now (field) | Correct (field and pool) | 365Scores event |
|---|---|---|---|---|
| 1 | הפועל תל אביב – מכבי חיפה | 1–2, 2 | 2–1, 1 | 4739299 |
| 2 | מכבי נתניה – הפועל ירושלים | 1–1, X (settled) | unchanged | 4739301 |
| 3 | בני סכנין – עירוני טבריה | 1–1, X (settled) | unchanged | 4739298 |
| 4 | הפועל חיפה – הפועל פתח תקווה | 1–2, 2 | 2–1, 1 | 4739296 (reviewed alias) |
| 5 | מ.ס אשדוד – בני יהודה | 1–3, 2 | 3–1, 1 | 4739086 (reviewed alias) |
| 6 | מכבי יפו – הפועל כפר סבא | 3–0, 1 | 0–3, 2 | 4739083 (reviewed alias) |
| 7 | ליברפול – ארסנל | 1–0, 1 | 0–1, 2 | 4742014 |
| 8 | קובנטרי – סנדרלנד | 1–3, 2 | 3–1, 1 | 4742016 |
| 9 | האל – איפסוויץ' | 2–2, X (settled) | unchanged | 4742015 |
| 10 | בורנמות' – לידס | 0–2, 2 | 2–0, 1 | 4742020 |
| 11 | ראיו ואייקאנו – סלטה ויגו | 0–3, 2 | 3–0, 1 | 4750803 (reviewed alias) |
| 12 | חטאפה – סביליה | 1–3, 2 | 3–1, 1 | 4750806 |
| 13 | אלצ'ה – ולנסיה | 1–0, 1 | 0–1, 2 | 4750808 |
| 14 | אתלטיק בילבאו – ריאל סוסיאדד | 1–2, 2 | 2–1, 1 | 4750811 |
| 15 | מילאן – אינטר | 1–3, 2 | 3–1, 1 | 4732643 |
| 16 | יובנטוס – נאפולי | 0–2, 2 | 2–0, 1 | 4732646 |

"Stored now" for games other than 1, 7, 10, 12 and 15 is inferred from reproduction, not read from production. Confirm it with the query before relying on the contingency.

### Read-only queries

State of the round:
```sql
select g.game_number, ht.canonical_name as home, at.canonical_name as away,
       g.status, g.field_home_score, g.field_away_score, g.field_outcome,
       g.settlement_status, g.pool_settlement_outcome, g.settlement_source,
       f.status as fixture_status, f.home_score as fixture_home, f.away_score as fixture_away,
       r.status as round_status
from public.round_games g
join public.rounds r on r.id = g.round_id
join public.teams ht on ht.id = g.home_team_id
join public.teams at on at.id = g.away_team_id
join public.fixtures f on f.id = g.fixture_id
where r.source = 'telesport-winner16' and r.external_round_number = '264301'
order by g.game_number;
```

Shadow evaluation exposure. `kapiloto_eval_scores` is immutable and derives the outcome from `fixtures` scores of finished fixtures, with no settlement gate:
```sql
select s.fixture_id, s.arm, s.arm_version, s.evaluation_mode, s.status,
       s.outcome, s.home_goals_90, s.away_goals_90, s.scored_at
from public.kapiloto_eval_scores s
where s.fixture_id in (
  select g.fixture_id from public.round_games g
  join public.rounds r on r.id = g.round_id
  where r.source = 'telesport-winner16' and r.external_round_number = '264301'
)
order by s.fixture_id, s.arm;
```
Any row for a non-draw game scored a swapped outcome. Such rows cannot be updated, and a re-run will not replace them (`ignoreDuplicates`). They must be annotated or excluded from evaluation reports. Shadow evaluation is not scheduled (D-042/D-044), so rows exist only if someone ran it by hand.

## Blast radius

| Consumer | Reads | Exposure in 264301 |
|---|---|---|
| Round list (`app/matches/page.tsx`, via `current-round.ts`) | field scores | wrong final scores for 13 games, visible to users |
| Match page (`app/matches/[fixtureId]`) | `fixtures` scores | same |
| `ticket_pick_results` / `consensus_pick_results` | `field_outcome` while live; pool outcome once settled | wrong `currently_*` while live; now `under_review`; recomputed by the repair; no app reader yet |
| Shadow evaluation | `fixtures` of finished fixtures | wrong only if scored by hand; immutable (query above) |
| V4 Match Ledger, provider ingest, Prediction Registry | not these columns (V4 reads only `fixtures.status`) | none |
| Research inputs (`fixture-input-store`), `football_match_results` | not these columns | none |

## Trust boundary

- **D-004.** Kept. The pool outcome is never derived from the field score. Settlement requires both to agree, so a technical result or Toto ruling stays `under_review`.
- **D-029.** Team identity and orientation are frozen after lock (`guard_locked_round_game_schedule`). The defect was in reading the field score, not in fixture identity. The new marker check fails closed whenever orientation and marker disagree.
- **D-039.** D-039 calls Telesport non-authoritative for discovery and import. The settlement path makes Telesport the operational field source, gated by exact 365Scores corroboration (`SCORES365-SETTLEMENT-CROSSCHECK-001`). That gate was never in the decision log; D-062 records it. This is a documentation gap, not a new violation. The official Winner results API is blocked server-to-server and stays a preflight only.
- **D-061 / M2B.** Not touched. No V4 path, grant or ingest is involved. The M2B blocker "Winner round 264301 settlement" stays open until production is re-synced and settled under the normal rule.

## Follow-ups

- Field scores are written with no compare-and-set: a later sync can rewrite field scores even on a settled row, at the SQL level. Live sync skips settled rows, but the RPC does not enforce it.
- Shadow evaluation scores finished fixtures without a settlement gate.
- The Edge Function is a dead writer. If it is ever revived for the modern page, it must use the same orientation contract and aliases.
- Telesport's structured payload (`score_1` / `score_2`) or its `/api/toto` JSON would remove the reliance on text order altogether.
