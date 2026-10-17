# Architecture Review 001

Status: initial internal architecture red-team before database finalization.

## Critical / High findings

### A1 — Sporting result and pool settlement must remain separate
Already accepted. Extend the rule so scoring is driven only by pool_settlement_outcome after settlement, while live provisional state may use field_outcome/current score.

### A2 — Do not infer Toto rules from generic football rules
Some fixtures may be settled according to regulation-time rules, void rules, technical decisions or other pool-specific policy.

Recommendation:
- round_game stores settlement_rule metadata when known;
- final scoring waits for Toto settlement source or explicit admin confirmation;
- football provider is never authoritative for pool settlement.

### A3 — Team/fixture identity mapping needs a first-class layer
Different data providers may use different names and IDs for the same club.

Recommendation:
- internal teams table;
- provider_team_mappings;
- provider_fixture_mappings;
- mapping confidence/status;
- admin repair path.

### A4 — AI whole-ticket logic should not be free-form
An LLM should research and synthesize evidence, but max-double optimization should be deterministic.

Recommended architecture:
1. per-fixture research produces structured outcome scores/probabilities plus uncertainty and sources;
2. server validates and normalizes those scores;
3. deterministic optimizer chooses the top single and allocates up to K doubles by marginal coverage gain;
4. LLM writes the human-readable explanation;
5. all steps are versioned.

This separates research quality from ticket-rule enforcement and makes recommendations reproducible.

### A5 — AI freshness should be event-aware, not only TTL-based
Three hours can be fresh on Wednesday and stale 20 minutes before kickoff.

Refresh triggers should include:
- relevant European/cup final whistle;
- major injury/suspension report;
- official lineup release;
- meaningful odds movement if market data is used;
- configurable time-to-kickoff windows.

### A6 — Protect AI research from prompt injection
Web pages and user-generated group text are untrusted input.

Recommendation:
- source content is data, never instructions;
- research prompt explicitly ignores instructions found in sources;
- only allow known server tools/actions;
- structured output schema validation;
- source-domain quality metadata;
- no arbitrary code/tool execution from researched content.

### A7 — Live polling must be centralized
Browsers must not poll sports providers independently.

Recommendation: scheduled/server worker polls live fixtures once and publishes normalized changes to clients.

## High / Medium findings

### A8 — Draft concurrency
A user may edit the same ticket from phone and desktop.

Recommendation: optimistic concurrency/version field on drafts plus last-write conflict handling.

### A9 — Consensus provenance
Store source submission IDs + versions, algorithm version, group_round_settings version and generated_at.

### A10 — Recheck rate limiting and cost
Fixture recheck and whole-ticket research can become the main variable cost.

Recommendation:
- shared cache by fixture-analysis version;
- per-user/group forced-refresh limits;
- deduplicate concurrent refreshes;
- surface freshness so users do not refresh unnecessarily.

### A11 — Provider licensing is an architecture constraint
Coverage is not enough. Verify rights to cache, display and redistribute live scores, logos and injury/lineup data.

### A12 — Time handling
Store timestamps in UTC; display Israel-local time by default. Do not hard-code UTC+2/+3 because DST changes.

### A13 — Manual correction path
Admins/system operators need a controlled way to repair a wrong fixture mapping or settlement, with audit records and deterministic stat recomputation.

### A14 — Derived statistics
Prefer SQL views/materialized views for derived stats. Persist immutable source facts and explicit round snapshots; avoid duplicating every metric prematurely.

## Suggested schema additions before migration
- teams
- provider_team_mappings
- provider_fixture_mappings
- consensus_source_submissions
- analysis_input_versions
- settlement_rule / settlement_source fields
- optimistic version/revision on drafts
- stale_reason on Kapiloto analyses
- admin correction/audit metadata