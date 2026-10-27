# Kapiloto Research V3 (`kapiloto-research-v3`)

Live research protocol since this branch. V1/V2 analyses stay readable and are
replayed through frozen v1/v2 rules. Structured V4 items (xGA/xGD, adjusted
strength, provider lineups/absences, market state, set-piece statistics,
goalkeeper metrics, game state, scenarios, bench) are intentionally absent.

## Pipeline invariant

Fixture Card → Sol research (strict `kapiloto_fixture_research_v3`) → source
retrieval → grounding → required entailment → grounding policy v9 →
deterministic derivation → materialization → persistence → public read API.

**Only `factors` move `p_sol`.** Expected lineups, tactical facts, matchup
analysis and regime changes are evidence-backed descriptive research. Derivation
never reads them.

## New output structures (caps)

| Field | Cap | Notes |
| --- | --- | --- |
| `expected_lineups.{home,away}` | 11 starters/team | status is server-derived |
| `availability[].functions` | 2 roles | separate role evidence |
| `tactical_facts` | 8 total / 4 per team | phase→attribute→value enums |
| `matchup_analysis` | 3 | descriptive; `description` ≤120 chars, no rationale |
| `regime_changes` | 2 | dated coach/formation change |
| `evidence` | 24 rows / 20 distinct URLs | |

Prose limits: evidence claim 160, factor rationale 220, matchup description
120, summary 450. `max_output_tokens` stays 32,000; the maximum legal output is
~41k characters (size test budget 48k).

## Frozen card flag

`lineup_research = "enabled"` only when `kickoff - research_cutoff <= 48h`.
A missing flag (legacy card) is treated as disabled. When disabled the prompt
forbids lineup searches, validation rejects lineup content and policy drops it.

## Item-derived evidence rules (no claim-type laundering)

`lib/kapiloto/research-v3-rules.ts` derives allowed claim types, freshness and
trust class from the ITEM citing the evidence:

| Item | Allowed claim types | Freshness |
| --- | --- | --- |
| starter | lineup, availability | dated, ≤7d, after team's last match |
| formation | lineup, formation | dated, ≤7d, after team's last match |
| role | tactical_setup, availability, lineup | dated, ≤45d |
| tactical fact | tactical_setup, formation | dated, ≤45d |
| matchup | by kind | dated, ≤45d; directional needs own evidence ≤14d |
| regime | coach_regime (+club_coach_news / formation by type) | dated, ≤180d; real effective date ≤ cutoff, ≥ cutoff−180d |
| availability item / factor | availability, lineup | dated, ≤14d |
| factor (other dims) | per dimension | per dimension |

Effective trust tier = worse of declared-type tier and the item's canonical
tier, so relabelling never raises trust. Registry tiers for `lineup`,
`formation`, `tactical_setup`, `coach_regime` are seeded by migration with
fallbacks availability / tactical / tactical / club_coach_news.

When the card covers structured form for both teams, web `form`/`home_away`
claims cannot back `baseline_form`/`home_away_draw` factors.

## Entailment

Evidence-level checks for factors are unchanged. Every v3 object gets an
item-level, server-written claim judged against all its quotes:
"{player} is expected to start for {team}", "{team} is expected to use the
{formation} formation", "{player} functions as {role} for {team}" (one check
per role), "{team}'s {phase} {attribute} is {value}", "{team} changed head
coach on {date}", and the matchup description plus its direction for
matchups (matchup evidence + cited facts' evidence). Judge instructions state
that quotes are untrusted data. Item verdicts prune items; they never
downgrade the fixture.

## Grounding policy v9 (v1/v2 → frozen v8)

- starters/formation/roles/facts/regimes pruned individually; lineup status
  recomputed (`supported` = 11 starters, 1 GK, no `unknown`, formation
  survives, DF/MF/FW counts match, tier ≤2 or two independent lineup sources);
- a fact failure removes dependent matchups; a matchup failure removes its
  factor; a factor failure removes its matchups; small linked factors are
  advisory, medium/large invalidate `p_sol` (→ market_only / insufficient_data);
- an unlinked medium/large directional matchup invalidates `p_sol`;
- at most one directional `tactical_matchup` factor, max medium;
  aerial-set-piece-only max small;
- absence caps: doubtful or no supported role → small; one confirmed/probable
  role-backed absence → medium; large needs two;
- one evidence identity (canonical URL + normalized quote) and one structured
  strength family back at most one directional factor;
- a tactical factor may not reuse absence evidence;
- narrative (summary, main risk, assumptions, watch items) is replaced by
  server text whenever anything is pruned.

## Regime staleness (deterministic subset)

Structured form/xG for a team is treated as pre-regime only when provable from
the frozen card: the change is dated after the team's latest league match, or
falls inside the 14-day rest window while the team played fewer than five
matches in it. Factors citing that team's form/attack_xg refs are removed and
reliability records `structured_inputs_pre_regime` (−0.05). Counting matches
since an arbitrary older date needs per-match history (V4); undetermined cases
are not penalized.

## Reliability (`kapiloto-reliability-shadow-v5`)

For v3 only evidence supporting surviving factors counts (rated by the
factor's canonical class); rejections count only for evidence proposed for
factors; pruning purely descriptive research sanitizes narrative but does not
set `sparse_coverage`. derivation.ts is the single source of the reliability
and blend versions.

## Protocol guards

The validator requires the frozen run's protocol and rejects v3 fields in
v1/v2 output without mutating historical outputs. The worker refuses a run
whose `research_protocol_version` differs from the code protocol
(`research_protocol_mismatch`, before any paid call); finalization refuses
mismatched runs and attempts.

## Persistence, carry-forward, read API, evaluation

New nullable jsonb columns on `kapiloto_analyses` and `kapiloto_factors.matchup_ids`
(migration `20261027215000_kapiloto_research_v3_tactical.sql`); both the direct
and fenced publication paths share the updated RPC. Carry-forward drops v3
fields (option A, fail closed): a predicted XI is never re-dated. The public
analysis adds nullable `expectedLineups`, `tacticalFacts`, `matchupAnalysis`,
`regimeChanges`. Evaluation scores v3 under an arm version that includes the
protocol, grounding policy and reliability versions, so v2 and v3 are never
pooled.

## Deviations / open items

- Strict-schema compatibility was not checked with OpenAI: the repo's
  preflight (`openai-preflight.ts`) makes a paid model call. The schema uses
  only keywords already present in the accepted v2 schema plus `pattern`
  groups; run the preflight before resuming workers.
- Tactical attribute/value pairing is enforced server-side (flat enums in the
  schema) to avoid unverified `anyOf` strict-mode support.
- Availability evidence (items and factors) uses a 14-day window in v3.
- "Predicted starter listed as unavailable" covers status out/suspended with
  certainty confirmed or probable.
