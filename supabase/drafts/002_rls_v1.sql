-- Kapiloto RLS / grants v1 DRAFT
-- Not yet applied to a Supabase project.

-- ---------------------------------------------------------------------------
-- Security baseline
-- ---------------------------------------------------------------------------

-- Public schema tables are intentionally not granted to anon.
-- Starting with Supabase's 2026 Data API defaults, exposure is explicit.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

-- Private schema is never intended to be an exposed Data API schema.
revoke all on schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Private RLS helpers
-- ---------------------------------------------------------------------------

create or replace function private.is_active_group_member(
  p_group_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = p_user_id
      and gm.status = 'active'
  );
$$;

create or replace function private.is_group_admin(
  p_group_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = p_user_id
      and gm.status = 'active'
      and gm.role in ('owner', 'admin')
  );
$$;

create or replace function private.users_share_active_group(
  p_user_a uuid,
  p_user_b uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members a
    join public.group_members b on b.group_id = a.group_id
    where a.user_id = p_user_a
      and b.user_id = p_user_b
      and a.status = 'active'
      and b.status = 'active'
  );
$$;

create or replace function private.can_view_user_ticket(
  p_ticket_id uuid,
  p_viewer uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_tickets target
    join public.group_round_settings settings
      on settings.group_id = target.group_id
     and settings.round_id = target.round_id
    join public.rounds r on r.id = target.round_id
    where target.id = p_ticket_id
      and (
        target.user_id = p_viewer
        or (
          target.state in ('submitted', 'locked')
          and private.is_active_group_member(target.group_id, p_viewer)
          and (
            settings.visibility_policy = 'immediate'
            or (
              settings.visibility_policy = 'after_round_lock'
              and now() >= r.lock_at
            )
            or (
              settings.visibility_policy = 'after_own_submission'
              and exists (
                select 1
                from public.user_tickets viewer_ticket
                where viewer_ticket.group_id = target.group_id
                  and viewer_ticket.round_id = target.round_id
                  and viewer_ticket.user_id = p_viewer
                  and viewer_ticket.state in ('submitted', 'locked')
              )
            )
          )
        )
      )
  );
$$;

revoke all on function private.is_active_group_member(uuid, uuid) from public, anon;
revoke all on function private.is_group_admin(uuid, uuid) from public, anon;
revoke all on function private.users_share_active_group(uuid, uuid) from public, anon;
revoke all on function private.can_view_user_ticket(uuid, uuid) from public, anon;

grant usage on schema private to authenticated;
grant execute on function private.is_active_group_member(uuid, uuid) to authenticated;
grant execute on function private.is_group_admin(uuid, uuid) to authenticated;
grant execute on function private.users_share_active_group(uuid, uuid) to authenticated;
grant execute on function private.can_view_user_ticket(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS on every public table
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.join_requests enable row level security;
alter table public.teams enable row level security;
alter table public.provider_team_mappings enable row level security;
alter table public.competitions enable row level security;
alter table public.provider_competition_mappings enable row level security;
alter table public.rounds enable row level security;
alter table public.round_games enable row level security;
alter table public.provider_fixture_mappings enable row level security;
alter table public.fixture_market_snapshots enable row level security;
alter table public.group_round_settings enable row level security;
alter table public.user_tickets enable row level security;
alter table public.user_ticket_picks enable row level security;
alter table public.ticket_versions enable row level security;
alter table public.ticket_version_picks enable row level security;
alter table public.consensus_versions enable row level security;
alter table public.consensus_source_submissions enable row level security;
alter table public.consensus_picks enable row level security;
alter table public.ticket_pick_results enable row level security;
alter table public.consensus_pick_results enable row level security;
alter table public.kapiloto_round_research_state enable row level security;
alter table public.kapiloto_research_requests enable row level security;
alter table public.kapiloto_research_runs enable row level security;
alter table public.kapiloto_research_attempts enable row level security;
alter table public.kapiloto_source_registry enable row level security;
alter table public.kapiloto_analyses enable row level security;
alter table public.kapiloto_evidence enable row level security;
alter table public.kapiloto_factors enable row level security;
alter table public.kapiloto_factor_evidence enable row level security;
alter table public.kapiloto_analysis_inputs enable row level security;
alter table public.kapiloto_freshness_signals enable row level security;
alter table public.diego_ticket_proposals enable row level security;
alter table public.diego_ticket_proposal_inputs enable row level security;
alter table public.diego_ticket_proposal_picks enable row level security;
alter table public.admin_audit_log enable row level security;

-- ---------------------------------------------------------------------------
-- Explicit Data API grants
-- ---------------------------------------------------------------------------

-- Identity
grant select, update on public.profiles to authenticated;

-- Group/member data. Multi-row privileged transitions are server-controlled,
-- so direct browser inserts/deletes are intentionally not granted here.
grant select on public.groups to authenticated;
grant select on public.group_members to authenticated;
grant select on public.join_requests to authenticated;

-- Canonical public football/reference data: read-only in the browser.
grant select on public.teams to authenticated;
grant select on public.competitions to authenticated;
grant select on public.rounds to authenticated;
grant select on public.round_games to authenticated;

-- Provider mappings are server/ops only: no authenticated grant.

-- Group round settings: read-only to clients.
grant select on public.group_round_settings to authenticated;

-- Current user draft can be directly read/written under RLS.
grant select, insert, update on public.user_tickets to authenticated;
grant select, insert, update, delete on public.user_ticket_picks to authenticated;

-- Immutable snapshots are read-only to the browser.
grant select on public.ticket_versions to authenticated;
grant select on public.ticket_version_picks to authenticated;

-- Consensus and scoring: browser read-only.
grant select on public.consensus_versions to authenticated;
grant select on public.consensus_source_submissions to authenticated;
grant select on public.consensus_picks to authenticated;
grant select on public.ticket_pick_results to authenticated;
grant select on public.consensus_pick_results to authenticated;

-- Kapiloto research is served through the application/API boundary.
-- Raw research/state/provenance tables receive no authenticated grants.

-- Diego: user can read own proposals; generation/apply are server-side.
grant select on public.diego_ticket_proposals to authenticated;
grant select on public.diego_ticket_proposal_inputs to authenticated;
grant select on public.diego_ticket_proposal_picks to authenticated;

-- Audit log: group admins may read their group's entries, no browser writes.
grant select on public.admin_audit_log to authenticated;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create policy profiles_select_shared_group
on public.profiles
for select
to authenticated
using (
  id = (select auth.uid())
  or private.users_share_active_group((select auth.uid()), id)
);

create policy profiles_update_self
on public.profiles
for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- Profile insertion is performed server-side during signup so the username
-- alias row and auth identity remain consistent.

-- ---------------------------------------------------------------------------
-- Groups / membership / join requests
-- ---------------------------------------------------------------------------

create policy groups_select_member
on public.groups
for select
to authenticated
using (
  private.is_active_group_member(id, (select auth.uid()))
);

create policy group_members_select_same_group
on public.group_members
for select
to authenticated
using (
  private.is_active_group_member(group_id, (select auth.uid()))
);

create policy join_requests_select_requester_or_admin
on public.join_requests
for select
to authenticated
using (
  user_id = (select auth.uid())
  or private.is_group_admin(group_id, (select auth.uid()))
);

-- Create group, request join by code, approve/reject, role changes, member removal,
-- join-code rotation and ownership transfer are server-side transactional actions.

-- ---------------------------------------------------------------------------
-- Global round/reference data
-- ---------------------------------------------------------------------------

create policy teams_select_authenticated
on public.teams for select to authenticated using (true);

create policy competitions_select_authenticated
on public.competitions for select to authenticated using (true);

create policy rounds_select_authenticated
on public.rounds for select to authenticated using (true);

create policy round_games_select_authenticated
on public.round_games for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Group round settings
-- ---------------------------------------------------------------------------

create policy group_round_settings_select_member
on public.group_round_settings
for select
to authenticated
using (
  private.is_active_group_member(group_id, (select auth.uid()))
);

-- ---------------------------------------------------------------------------
-- User tickets
-- ---------------------------------------------------------------------------

create policy user_tickets_select_visible
on public.user_tickets
for select
to authenticated
using (
  private.can_view_user_ticket(id, (select auth.uid()))
);

create policy user_tickets_insert_self_member
on public.user_tickets
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and private.is_active_group_member(group_id, (select auth.uid()))
  and state = 'draft'
);

create policy user_tickets_update_self_before_lock
on public.user_tickets
for update
to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.rounds r
    where r.id = round_id
      and now() < r.lock_at
  )
)
with check (
  user_id = (select auth.uid())
  and state in ('draft', 'submitted')
);

create policy user_ticket_picks_select_visible_ticket
on public.user_ticket_picks
for select
to authenticated
using (
  private.can_view_user_ticket(user_ticket_id, (select auth.uid()))
);

create policy user_ticket_picks_insert_own_open_ticket
on public.user_ticket_picks
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_tickets t
    join public.rounds r on r.id = t.round_id
    where t.id = user_ticket_id
      and t.user_id = (select auth.uid())
      and t.state in ('draft', 'submitted')
      and now() < r.lock_at
  )
);

create policy user_ticket_picks_update_own_open_ticket
on public.user_ticket_picks
for update
to authenticated
using (
  exists (
    select 1
    from public.user_tickets t
    join public.rounds r on r.id = t.round_id
    where t.id = user_ticket_id
      and t.user_id = (select auth.uid())
      and t.state in ('draft', 'submitted')
      and now() < r.lock_at
  )
)
with check (
  exists (
    select 1
    from public.user_tickets t
    join public.rounds r on r.id = t.round_id
    where t.id = user_ticket_id
      and t.user_id = (select auth.uid())
      and t.state in ('draft', 'submitted')
      and now() < r.lock_at
  )
);

create policy user_ticket_picks_delete_own_open_ticket
on public.user_ticket_picks
for delete
to authenticated
using (
  exists (
    select 1
    from public.user_tickets t
    join public.rounds r on r.id = t.round_id
    where t.id = user_ticket_id
      and t.user_id = (select auth.uid())
      and t.state in ('draft', 'submitted')
      and now() < r.lock_at
  )
);

-- ---------------------------------------------------------------------------
-- Immutable ticket snapshots
-- ---------------------------------------------------------------------------

create policy ticket_versions_select_visible_ticket
on public.ticket_versions
for select
to authenticated
using (
  private.can_view_user_ticket(user_ticket_id, (select auth.uid()))
);

create policy ticket_version_picks_select_visible_version
on public.ticket_version_picks
for select
to authenticated
using (
  exists (
    select 1
    from public.ticket_versions v
    where v.id = ticket_version_id
      and private.can_view_user_ticket(v.user_ticket_id, (select auth.uid()))
  )
);

-- No INSERT/UPDATE/DELETE grant to authenticated on immutable versions.

-- ---------------------------------------------------------------------------
-- Consensus
-- ---------------------------------------------------------------------------

create policy consensus_versions_select_member
on public.consensus_versions
for select
to authenticated
using (
  private.is_active_group_member(group_id, (select auth.uid()))
);

create policy consensus_sources_select_member
on public.consensus_source_submissions
for select
to authenticated
using (
  exists (
    select 1
    from public.consensus_versions c
    where c.id = consensus_version_id
      and private.is_active_group_member(c.group_id, (select auth.uid()))
  )
);

create policy consensus_picks_select_member
on public.consensus_picks
for select
to authenticated
using (
  exists (
    select 1
    from public.consensus_versions c
    where c.id = consensus_version_id
      and private.is_active_group_member(c.group_id, (select auth.uid()))
  )
);

-- Consensus generation is a server/admin operation.

-- ---------------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------------

create policy ticket_results_select_visible_ticket
on public.ticket_pick_results
for select
to authenticated
using (
  exists (
    select 1
    from public.ticket_versions v
    where v.id = ticket_version_id
      and private.can_view_user_ticket(v.user_ticket_id, (select auth.uid()))
  )
);

create policy consensus_results_select_member
on public.consensus_pick_results
for select
to authenticated
using (
  exists (
    select 1
    from public.consensus_versions c
    where c.id = consensus_version_id
      and private.is_active_group_member(c.group_id, (select auth.uid()))
  )
);

-- ---------------------------------------------------------------------------
-- Kapiloto
-- ---------------------------------------------------------------------------

-- No authenticated table policies or grants are defined for Kapiloto research.
-- The browser reads the published response model through the application/API boundary
-- and requests Consult/Recheck through one privileged server path.
-- This prevents clients from fabricating runs, attempts, analyses or freshness signals.

-- ---------------------------------------------------------------------------
-- Diego
-- ---------------------------------------------------------------------------

create policy diego_proposals_select_own
on public.diego_ticket_proposals
for select
to authenticated
using (user_id = (select auth.uid()));

create policy diego_inputs_select_own_proposal
on public.diego_ticket_proposal_inputs
for select
to authenticated
using (
  exists (
    select 1
    from public.diego_ticket_proposals p
    where p.id = proposal_id
      and p.user_id = (select auth.uid())
  )
);

create policy diego_picks_select_own_proposal
on public.diego_ticket_proposal_picks
for select
to authenticated
using (
  exists (
    select 1
    from public.diego_ticket_proposals p
    where p.id = proposal_id
      and p.user_id = (select auth.uid())
  )
);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

create policy admin_audit_log_select_group_admin
on public.admin_audit_log
for select
to authenticated
using (
  group_id is not null
  and private.is_group_admin(group_id, (select auth.uid()))
);

-- ---------------------------------------------------------------------------
-- Server-only tables: no authenticated policies/grants
-- ---------------------------------------------------------------------------
-- private.auth_username_aliases
-- public.provider_team_mappings
-- public.provider_competition_mappings
-- public.provider_fixture_mappings
-- public.fixture_market_snapshots
-- public.kapiloto_round_research_state
-- public.kapiloto_research_requests
-- public.kapiloto_research_runs
-- public.kapiloto_research_attempts
-- public.kapiloto_source_registry
-- public.kapiloto_analyses
-- public.kapiloto_evidence
-- public.kapiloto_factors
-- public.kapiloto_factor_evidence
-- public.kapiloto_analysis_inputs
-- public.kapiloto_freshness_signals
-- When the real Supabase project exists:
-- 1) verify which schemas are exposed by the Data API;
-- 2) ensure private is NOT exposed;
-- 3) run Database/Security Advisors;
-- 4) test cross-group isolation with two test users and two groups;
-- 5) test that authenticated cannot directly mutate immutable/system tables.
