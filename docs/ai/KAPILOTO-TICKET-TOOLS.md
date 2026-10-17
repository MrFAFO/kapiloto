# Kapiloto Ticket-Level Tools

## Purpose
Kapiloto assists at two scopes: individual fixture and complete 16-match ticket.

These are separate operations and caches.

## Fixture analysis output
- primary_pick;
- suggested_double;
- confidence;
- concise summary;
- key_factors;
- main_risk;
- sources;
- generated_at;
- valid_until.

## Recommend doubles
Input:
- all 16 latest fixture analyses;
- group max_doubles;
- user's current ticket.

Output per candidate:
- game_number;
- current_pick;
- suggested_pick;
- uncertainty_score;
- marginal_coverage_value;
- explanation.

The output includes a proposed final set of doubles, never exceeding max_doubles.

Kapiloto's AI recommendation is separate from the democratic group consensus algorithm. Keep them separate in UI, database and naming.

## Review my ticket
Detect:
- risky singles;
- redundant doubles;
- doubles allocated to highly one-sided games;
- stale picks after new team news;
- picks that conflict strongly with current research.

Return a ranked change list rather than rewriting everything.

## Fill my ticket
Generate one pick for every active game and no more than group max_doubles.

Server-side deterministic validation is mandatory. Reject or repair model output that violates Toto pick rules.

## Refresh/versioning
Ticket-level AI reviews reference exact fixture-analysis versions. If fixture analyses change, the ticket review becomes stale.

Store:
- input analysis version IDs;
- model configuration;
- generated_at;
- proposed picks;
- user acceptance/rejection when useful for analytics.

## Safe apply flow
recommendation -> preview diff -> explicit apply -> draft validation -> user submit.

AI never directly mutates a submitted ticket.