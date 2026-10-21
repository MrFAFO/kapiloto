-- Fixture-scoped Kapiloto intelligence foundation.
-- Round runs continue to own Toto-cycle budgeting/single-flight, while each
-- research task/output now carries the canonical fixture identity and can be
-- published independently for reuse by non-Toto Match Intelligence surfaces.

-- ---------------------------------------------------------------------------
-- Canonical fixture identity on research rows
-- ---------------------------------------------------------------------------

alter table public.kapiloto_research_requests
  add column fixture_id uuid references public.fixtures(id) on delete set null;

alter table public.kapiloto_research_attempts
  add column fixture_id uuid references public.fixtures(id) on delete restrict;

alter table public.kapiloto_analyses
  add column fixture_id uuid references public.fixtures(id) on delete restrict;

alter table public.kapiloto_freshness_signals
  add column fixture_id uuid references public.fixtures(id) on delete cascade;

update public.kapiloto_research_requests r
set fixture_id = g.fixture_id
from public.round_games g
where r.round_game_id = g.id
  and r.fixture_id is null;

update public.kapiloto_research_attempts a
set fixture_id = g.fixture_id
from public.round_games g
where a.round_game_id = g.id
  and a.fixture_id is null;

update public.kapiloto_analyses a
set fixture_id = g.fixture_id
from public.round_games g
where a.round_game_id = g.id
  and a.fixture_id is null;

update public.kapiloto_freshness_signals s
set fixture_id = g.fixture_id
from public.round_games g
where s.round_game_id = g.id
  and s.fixture_id is null;

alter table public.kapiloto_analyses
  alter column fixture_id set not null;

alter table public.kapiloto_freshness_signals
  alter column fixture_id set not null;

-- Freshness is a property of a football fixture. Keep the Toto row link only
-- as optional context so Match Intelligence can emit signals outside a pool.
alter table public.kapiloto_freshness_signals
  alter column round_game_id drop not null;

create index kapiloto_research_requests_fixture_time_idx
  on public.kapiloto_research_requests (fixture_id, created_at desc)
  where fixture_id is not null;

create index kapiloto_research_attempts_fixture_idx
  on public.kapiloto_research_attempts (fixture_id)
  where fixture_id is not null;

create index kapiloto_analyses_fixture_time_idx
  on public.kapiloto_analyses (fixture_id, generated_at desc);

create index kapiloto_freshness_signals_fixture_time_idx
  on public.kapiloto_freshness_signals (fixture_id, observed_at desc);

alter table public.kapiloto_analyses
  add constraint kapiloto_analyses_id_fixture_id_key
  unique (id, fixture_id);

alter table public.kapiloto_analyses
  add constraint kapiloto_analyses_run_fixture_key
  unique (research_run_id, fixture_id);

-- A market prior and an analysis must refer to the same canonical fixture.
alter table public.fixture_market_snapshots
  add constraint fixture_market_snapshots_id_fixture_id_key
  unique (id, fixture_id);

alter table public.kapiloto_analyses
  add constraint kapiloto_analyses_market_snapshot_fixture_fk
  foreign key (market_snapshot_id, fixture_id)
  references public.fixture_market_snapshots(id, fixture_id)
  on delete restrict;

-- Existing code still inserts round_game_id. Populate/validate fixture_id at
-- the DB boundary so old and new callers cannot silently disagree.
create or replace function private.kapiloto_resolve_fixture_from_round_game()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_fixture_id uuid;
begin
  if new.round_game_id is null then
    return new;
  end if;

  select g.fixture_id
    into v_fixture_id
  from public.round_games g
  where g.id = new.round_game_id;

  if v_fixture_id is null then
    raise exception 'round_game_id % has no canonical fixture', new.round_game_id;
  end if;

  if new.fixture_id is null then
    new.fixture_id := v_fixture_id;
  elsif new.fixture_id <> v_fixture_id then
    raise exception 'round_game_id and fixture_id refer to different fixtures';
  end if;

  return new;
end;
$$;

create trigger kapiloto_requests_resolve_fixture
before insert on public.kapiloto_research_requests
for each row execute function private.kapiloto_resolve_fixture_from_round_game();

create trigger kapiloto_attempts_resolve_fixture
before insert on public.kapiloto_research_attempts
for each row execute function private.kapiloto_resolve_fixture_from_round_game();

create trigger kapiloto_analyses_resolve_fixture
before insert on public.kapiloto_analyses
for each row execute function private.kapiloto_resolve_fixture_from_round_game();

create trigger kapiloto_freshness_resolve_fixture
before insert on public.kapiloto_freshness_signals
for each row execute function private.kapiloto_resolve_fixture_from_round_game();

-- ---------------------------------------------------------------------------
-- Fixture-scoped immutable publication history + current pointer
-- ---------------------------------------------------------------------------

create table public.kapiloto_fixture_publications (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.fixtures(id) on delete cascade,
  analysis_id uuid not null,
  research_run_id uuid not null references public.kapiloto_research_runs(id) on delete restrict,
  version_no integer not null check (version_no > 0),
  previous_analysis_id uuid references public.kapiloto_analyses(id) on delete restrict,
  published_at timestamptz not null default now(),
  foreign key (analysis_id, fixture_id)
    references public.kapiloto_analyses(id, fixture_id) on delete restrict,
  unique (fixture_id, version_no),
  unique (analysis_id)
);

create index kapiloto_fixture_publications_fixture_time_idx
  on public.kapiloto_fixture_publications (fixture_id, published_at desc);

create table public.kapiloto_fixture_intelligence_state (
  fixture_id uuid primary key references public.fixtures(id) on delete cascade,
  current_analysis_id uuid,
  current_publication_id uuid references public.kapiloto_fixture_publications(id) on delete restrict,
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default now(),
  foreign key (current_analysis_id, fixture_id)
    references public.kapiloto_analyses(id, fixture_id) on delete restrict,
  check (
    (current_analysis_id is null and current_publication_id is null and version = 0)
    or
    (current_analysis_id is not null and current_publication_id is not null and version > 0)
  )
);

create or replace function private.reject_kapiloto_publication_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Kapiloto fixture publications are immutable';
end;
$$;

create trigger kapiloto_fixture_publications_immutable
before update or delete on public.kapiloto_fixture_publications
for each row execute function private.reject_kapiloto_publication_change();

-- Atomic, idempotent server-only publication. A completed round run may publish
-- its fixture analyses independently while the round can still keep a coherent
-- run manifest for Toto/Diego.
create or replace function public.kapiloto_publish_fixture_analysis(
  p_analysis_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fixture_id uuid;
  v_run_id uuid;
  v_run_status text;
  v_state public.kapiloto_fixture_intelligence_state%rowtype;
  v_publication_id uuid;
  v_version bigint;
begin
  select a.fixture_id, a.research_run_id, r.status
    into v_fixture_id, v_run_id, v_run_status
  from public.kapiloto_analyses a
  join public.kapiloto_research_runs r on r.id = a.research_run_id
  where a.id = p_analysis_id;

  if v_fixture_id is null then
    raise exception 'Kapiloto analysis % not found', p_analysis_id;
  end if;

  if v_run_status <> 'completed' then
    raise exception 'Kapiloto analysis can only be published from a completed run';
  end if;

  insert into public.kapiloto_fixture_intelligence_state (fixture_id)
  values (v_fixture_id)
  on conflict (fixture_id) do nothing;

  select s.*
    into v_state
  from public.kapiloto_fixture_intelligence_state s
  where s.fixture_id = v_fixture_id
  for update;

  if v_state.current_analysis_id = p_analysis_id then
    return jsonb_build_object(
      'fixture_id', v_fixture_id,
      'analysis_id', p_analysis_id,
      'publication_id', v_state.current_publication_id,
      'version', v_state.version,
      'replayed', true
    );
  end if;

  v_version := v_state.version + 1;

  insert into public.kapiloto_fixture_publications (
    fixture_id,
    analysis_id,
    research_run_id,
    version_no,
    previous_analysis_id
  )
  values (
    v_fixture_id,
    p_analysis_id,
    v_run_id,
    v_version,
    v_state.current_analysis_id
  )
  returning id into v_publication_id;

  update public.kapiloto_fixture_intelligence_state
  set current_analysis_id = p_analysis_id,
      current_publication_id = v_publication_id,
      version = v_version,
      updated_at = now()
  where fixture_id = v_fixture_id;

  return jsonb_build_object(
    'fixture_id', v_fixture_id,
    'analysis_id', p_analysis_id,
    'publication_id', v_publication_id,
    'version', v_version,
    'replayed', false
  );
end;
$$;

revoke all on function public.kapiloto_publish_fixture_analysis(uuid)
from public, anon, authenticated;

grant execute on function public.kapiloto_publish_fixture_analysis(uuid)
to service_role;

-- Public schema security: research/publication provenance remains server-only.
alter table public.kapiloto_fixture_publications enable row level security;
alter table public.kapiloto_fixture_intelligence_state enable row level security;

comment on column public.kapiloto_analyses.fixture_id is
  'Canonical football fixture identity. round_id/round_game_id remain Toto-cycle context during migration.';

comment on table public.kapiloto_fixture_publications is
  'Immutable fixture-scoped intelligence publication history.';

comment on table public.kapiloto_fixture_intelligence_state is
  'Current published Kapiloto intelligence pointer per canonical fixture.';
