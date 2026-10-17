# Schema v1 — Pre-Migration Design

Status: **draft, not applied to Supabase**.

Files:
- `supabase/drafts/001_schema_v1.sql`
- `supabase/drafts/002_rls_v1.sql`

## Why this is still a draft

We have intentionally not created/applied a Supabase project schema yet. The next database step should happen only after:
1. external architecture/security reviews are reconciled;
2. a Supabase project is explicitly created/approved;
3. the draft is iterated with `execute_sql`;
4. advisors and isolation tests pass;
5. a clean migration is generated.

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
