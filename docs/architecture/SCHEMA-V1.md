# Schema v1 — Pre-Migration Design

Status: **applied to the Kapiloto development Supabase project on 2026-10-18; production use is not yet enabled**.

Source drafts:
- `supabase/drafts/001_schema_v1.sql`
- `supabase/drafts/002_rls_v1.sql`
- `supabase/drafts/003_kapiloto_research_rpc.sql`
- `supabase/drafts/004_kapiloto_attempt_rpc.sql`

Applied migration history is tracked under `supabase/migrations/`.

## Current database state

The dedicated Kapiloto development project now contains Schema v1, RLS v1, the research-request RPC and attempt-queue RPC. All public/private application tables have RLS enabled. Raw Kapiloto/provider tables intentionally have no authenticated Data API grants. The five Kapiloto execution RPCs are executable by `service_role` only.

Before production use, complete authenticated cross-user/group isolation tests, configure runtime secrets, seed canonical round data, and finish the remaining auth/application flows.

## Important Schema v1 choices

### Editable ticket vs submitted snapshot
A user's weekly ticket has one stable mutable `user_tickets` identity and current `user_ticket_picks`.

Every explicit submission produces immutable:
- `ticket_versions`
- `ticket_version_picks`

Consensus references immutable ticket versions.

This avoids using the same row as both autosaving draft and historical evidence.

### Doubles are derived from the pick
There is no double boolean.
- single: 1 / X / 2
- double: 1X / X2 / 12

The database trigger checks the group's max-double limit.

### Pool settlement is separate from football result
`round_games` stores both:
- field score/outcome;
- Toto pool settlement outcome/status.

Final scoring uses pool settlement only.

### Demand-driven AI research
Kapiloto uses a round-state row, immutable published snapshots and separate execution attempts:
- no run exists until a user explicitly requests Kapiloto, Recheck or Diego assistance;
- each logical run targets the shared 16-fixture snapshot;
- one row in `kapiloto_round_research_state` is locked with `FOR UPDATE` before run creation;
- `current_run_id` atomically publishes one coherent snapshot;
- budget slots 1..3 plus a partial unique active-run index enforce the global cap and single-flight semantics;
- retries are `kapiloto_research_attempts` inside the same logical run;
- stale data can make a refresh eligible but never starts research itself;
- Consult creates only run 1; later runs require explicit Recheck/refresh intent;
- authenticated clients cannot write research tables directly.

### Grounded probability research
Kapiloto research persists three probability layers:
- structured prior (`p_prior`);
- raw Sol pre-match estimate (`p_sol`);
- server-derived final estimate (`p_final`).

All are integer basis points summing to 10,000. Only `p_final` drives picks/double ranking.

Research runs freeze `research_cutoff_at` and a fixture card that pins Toto orientation, settlement semantics and provider/prior versions.

The preferred execution topology is fixture fan-out. Attempts are keyed by task so one fixture can retry without repaying for the other 15. Publication is still one atomic 16-row snapshot.

Claim-level evidence is stored separately from factors and is grounded through URL retrieval, quote verification, server source registry/tiering and cutoff checks.

### Public vs private data
`private.auth_username_aliases` contains the username-to-auth-identifier mapping and is never exposed to the Data API.

Provider mappings and AI input provenance are also server/ops-only.

### Explicit Data API exposure
The RLS draft uses explicit per-table grants because current Supabase projects no longer assume every new public table should automatically be exposed.

### RLS boundary
Browser writes are intentionally narrow:
- own current ticket;
- own current picks;
- own profile update.

Privileged multi-row transitions are server operations:
- signup/profile + username alias;
- create group;
- join by code;
- approve/reject join;
- role/owner changes;
- group round settings;
- submit/snapshot ticket;
- consensus generation;
- football ingestion/settlement;
- Kapiloto generation;
- Diego generation/apply;
- audit writes.

## Before migration

### Kapiloto research concurrency tests
- 20 simultaneous first Consult requests create exactly one logical run and one budget slot;
- simultaneous eligible Rechecks create exactly one next run;
- duplicate Idempotency-Key with the same body never creates a second run;
- duplicate Idempotency-Key with a different body is rejected;
- an expired worker lease cannot publish after a retry owns the run;
- a transient terminal failure refunds its slot and clears active_run_id;
- a deterministic model-output failure follows the configured consume/refund policy;
- publication inserts the complete fixture snapshot and flips current_run_id in one transaction;
- every persisted prior/Sol/final probability triple sums to exactly 10,000 basis points;
- fixture output with mismatched home/away identity or unverified orientation cannot publish;
- a factor cannot reference evidence from another analysis;
- post-cutoff evidence cannot publish into a pre-match analysis;
- a zombie fixture task cannot overwrite the successful attempt for the same task key;
- readers never observe a mixture of two run IDs;
- Diego input rows all belong to one pinned completed research_run_id;
- GET/read paths never create research;
- a fourth non-refunded budget slot is impossible at the database level.

### Kapiloto grounding/evaluation tests
- web-search result URL that was never retrieved is rejected as evidence;
- quote mismatch rejects/downgrades the evidence;
- wrong-team/stale-player evidence fails validation;
- source published after research_cutoff_at is rejected;
- live-blog/match-report fixtures are excluded from pre-match evidence;
- research worker role cannot read actual result/settlement/evaluation tables;
- home/away echo mismatch rejects structured output;
- p_sol normalization and p_final derivation are deterministic/versioned;
- double ranking uses p_final and stable integer ratio ordering;
- source registry deny-list and unknown-domain behavior are enforced;
- HTML/Markdown/URLs in free-text output are sanitized;
- fan-out retries one fixture task without creating a new logical run.

Required tests:
- user A cannot read group B data;
- member cannot read another member's draft;
- after-own-submission visibility behaves correctly;
- after-round-lock visibility behaves correctly;
- max-double enforcement cannot be bypassed;
- picks from another round cannot be inserted into a ticket;
- immutable ticket versions cannot be modified by authenticated clients;
- consensus source versions remain reproducible;
- Diego proposals are private to their user;
- private username aliases are not reachable through Data API;
- server lock time wins over client clock.

## Open implementation detail

The final transaction-safe submit operation still needs an implementation choice. Preferred direction:
- a narrowly scoped authenticated RPC/wrapper that validates ownership and uses a private transactional implementation, **or**
- a server-only database connection that invokes a private transaction function.

Do not implement submission as multiple independent browser/Data-API writes.
