# Fable combined red-team — Kapiloto grounding + structured-data architecture

You are the adversarial architecture reviewer for Kapiloto.

This is review-only. Do not edit code, deploy, mutate production, or trigger paid AI research.

## Context

Two independent Opus reviews have now diagnosed two coupled problems:

### A. Grounding / publication policy
Read:
- `docs/reviews/grounding-policy-review-packet.md`
- `docs/prompts/OPUS-KAPILOTO-GROUNDING-REVIEW.md`

Key conclusions from the completed Opus grounding review:
- Evidence reference trimming can make partially unsupported factors look fully supported.
- Raw Sol output is overwritten by sanitized output, preventing safe replay.
- `p_sol` can survive after directional factors are removed.
- Grounding/materialization/finalization currently apply inconsistent policies.
- Opus proposed a single deterministic grounding policy, applied after entailment, with item-level removal, directional factor gating, an evidence-backed probability deviation envelope, reliability penalties, and raw-output persistence.

### B. Structured football data pipeline
Read:
- `docs/prompts/OPUS-KAPILOTO-STRUCTURED-DATA-AUDIT.md`
- `docs/architecture/FOOTBALL-DATA-PROVIDER-SPIKE.md`

Key conclusions from the completed Opus structured-data audit:
- Round 264201 Fixture Cards contained no real structured context.
- `recent_matches`, table, squad and coach are never populated.
- Sportmonks analytics ingestion exists but has no production caller and currently targets the round fixture itself instead of historical fixtures.
- API-Football is currently used mainly for market/fixture sync; objective facts are not being fed into Sol.
- The output schema forces every factor to cite URL+quote evidence, so even objective form facts must be re-proved from web articles.
- Opus proposed a provider ingestion layer → immutable canonical facts → deterministic derived features → frozen Fixture Card v3 → Sol + web qualitative context → structured/web grounding.
- Opus proposed structured evidence with `source_type: structured`, `fact_ref`, and deterministic verification.
- Opus proposed capability-specific providers rather than one global provider:
  - API-Football broad fixture/standings/market fallback
  - Sportmonks richer performance analytics where entitled
  - rating prior fallback when market is unavailable
- Opus proposed deterministic features for form, venue form, goals, streaks, rest/congestion, table, xG/xGA where covered, pressure, lineup continuity, missing-player importance, Elo/rating prior.

## Product principles from the owner

1. Paid football-data APIs exist specifically to provide reliable objective facts.
2. Objective facts should not depend on articles when the provider already exposes them.
3. Sol should primarily interpret the data and add qualitative context:
   - tactical implications
   - coach intent/comments
   - rotation
   - dressing-room/off-field issues
   - analyst interpretation
   - breaking news
4. Structured data must be compact, deterministic, cutoff-safe and replayable.
5. Missing provider data must never be treated as zero / no issue.
6. Coverage matters, but not at the cost of inventing confidence.
7. We do not want a second full paid research run merely to validate architecture.
8. Weekly AI budget is hard-constrained, so avoid unnecessary model calls.

## Your mission

Challenge the **combined architecture**, not each review separately.

You must specifically attack the following questions:

### 1. Structured-vs-web authority
- Is it always correct to treat structured provider facts as authoritative?
- Which fields can be trusted directly and which should require cross-checking or conflict handling?
- Can provider data itself be stale, mis-mapped, partial, or logically inconsistent?
- Should a web source ever override a structured fact, and under what deterministic rule?

### 2. Feature engineering risk
- Are Opus's proposed deterministic features sufficient?
- Which features are too naive for football?
- Are last-6 form, xG trend, pressure share, rest days, lineup continuity, etc. likely to double count the same latent signal?
- Which features should be omitted from V1 because they add complexity without proven predictive value?

### 3. Market prior interaction
- Does limiting structured-only factors to a small deviation when a market prior exists make sense?
- Could this make Kapiloto too market-like and eliminate its value?
- How should we prevent double counting public information already priced by the market?
- Is a rating prior fallback preferable to a flat league base, and what are the failure modes?

### 4. Grounding-policy envelope
- Does the proposed deterministic deviation envelope actually solve the rejected-evidence problem, or merely hide black-box dependence inside a cap?
- Should the system instead discard `p_sol` whenever any directional factor is removed?
- Can the same factor splitting/presentation artifact still game the envelope?
- Propose a better deterministic alternative if you have one.

### 5. Structured evidence contract
- Is `source_type: structured` + `fact_ref` + deep-equal asserted value enough?
- How should structured evidence express derivation lineage?
- Should Sol cite a derived feature, raw fact, or both?
- How should reliability differ for raw provider facts vs deterministically derived features vs web evidence?

### 6. Provider-by-capability design
Evaluate whether these assignments are sensible:
- API-Football: fixture mapping, standings, market prior, broad fallback
- Sportmonks: recent results where entitled, stats, xG, pressure, lineups/sidelined, squad/coach
- Rating prior: fallback when market unavailable
Identify any capability where the primary/fallback should be reversed or where dual-source verification is necessary.

### 7. Ingestion schedule / freshness
- Is 48h / 12h / 2h enough?
- Which capabilities need different refresh cadence?
- Which snapshots are immutable vs refreshable?
- How should the system handle late injury news without making provider ingestion expensive?

### 8. Minimal rollout
Opus proposed first slice:
- durable market capture
- results + standings
- form/home-away/goals/streaks/rest/table
- Card v3
- structured citations
Then later xG/pressure/Elo, then sidelined/squad/coach.

Challenge this sequencing.
Could we get a better quality gain with a smaller or different first slice?

### 9. Historical replay limitation
For round 264201, some original raw Sol factors were overwritten.
Do not propose inventing them.
Decide what can be meaningfully shadow-replayed and what must wait for the next organically requested round.

### 10. Product behavior
Define what the user should see when:
- structured data is strong but web context is weak;
- web context is strong but structured coverage is partial;
- providers disagree;
- the market prior exists but no meaningful non-market edge survives;
- enough information exists to describe the match but not justify a pick.

## Required output

Return:

1. **Three strongest objections** to the combined Opus architecture.
2. **What you agree with completely.**
3. **What should be simplified for V1.**
4. **What should be stricter for safety/correctness.**
5. **What should be looser to avoid unnecessary insufficient_data.**
6. **Your provider-by-capability matrix.**
7. **Your minimal Fixture Card v3 recommendation.**
8. **Your minimal deterministic feature set for V1.**
9. **Your recommendation for p_sol / probability recalculation after evidence removal.**
10. **Your structured evidence / grounding contract.**
11. **Your rollout plan, stage by stage.**
12. **Exact tests you would require before production.**
13. **Verdict on whether Opus's first implementation slice should be adopted as-is, modified, or rejected.**
14. **A merged policy/architecture you would be willing to ship.**

Use the real code and existing provider capabilities. Do not hand-wave with generic football analytics advice.
