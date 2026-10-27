-- Autonomous round-import provenance and post-lock schedule immutability.

create table if not exists public.round_import_provenance (
  round_id uuid primary key references public.rounds(id) on delete cascade,
  lock_source_type text not null
    check (lock_source_type in ('source', 'derived_safety')),
  lock_source_ref text,
  lock_is_derived boolean not null default false,
  source_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    lock_source_type <> 'derived_safety'
    or lock_is_derived = true
  )
);

alter table public.round_import_provenance enable row level security;

create or replace function public.guard_locked_round_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if now() >= old.lock_at and (
    new.external_round_number is distinct from old.external_round_number
    or new.starts_at is distinct from old.starts_at
    or new.lock_at is distinct from old.lock_at
    or new.source is distinct from old.source
    or new.source_version is distinct from old.source_version
  ) then
    raise exception 'round_schedule_locked_immutable';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_locked_round_schedule on public.rounds;
create trigger trg_guard_locked_round_schedule
before update on public.rounds
for each row
execute function public.guard_locked_round_schedule();

create or replace function public.guard_locked_round_game_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_lock_at timestamptz;
begin
  select r.lock_at
    into v_lock_at
  from public.rounds r
  where r.id = old.round_id;

  if v_lock_at is not null
     and now() >= v_lock_at
     and (
       new.round_id is distinct from old.round_id
       or new.fixture_id is distinct from old.fixture_id
       or new.game_number is distinct from old.game_number
       or new.home_team_id is distinct from old.home_team_id
       or new.away_team_id is distinct from old.away_team_id
       or new.competition_id is distinct from old.competition_id
       or new.competition_name_snapshot is distinct from old.competition_name_snapshot
       or new.competition_stage_snapshot is distinct from old.competition_stage_snapshot
       or new.leg_number is distinct from old.leg_number
       or new.aggregate_home_score is distinct from old.aggregate_home_score
       or new.aggregate_away_score is distinct from old.aggregate_away_score
       or new.neutral_venue is distinct from old.neutral_venue
       or new.kickoff_at is distinct from old.kickoff_at
       or new.settlement_rule is distinct from old.settlement_rule
     ) then
    raise exception 'round_game_schedule_locked_immutable';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_locked_round_game_schedule on public.round_games;
create trigger trg_guard_locked_round_game_schedule
before update on public.round_games
for each row
execute function public.guard_locked_round_game_schedule();

create or replace function public.toto_import_round_snapshot_v2(
  p_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_round_id uuid;
  v_lock_source_type text;
  v_lock_source_ref text;
  v_lock_is_derived boolean;
  v_source_metadata jsonb;
  v_lock_at timestamptz;
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'round_snapshot_invalid';
  end if;

  v_lock_source_type := coalesce(
    nullif(trim(p_snapshot ->> 'lock_source_type'), ''),
    'source'
  );
  v_lock_source_ref := nullif(trim(p_snapshot ->> 'lock_source_ref'), '');
  v_lock_is_derived := coalesce(
    (p_snapshot ->> 'lock_is_derived')::boolean,
    false
  );
  v_source_metadata := coalesce(p_snapshot -> 'source_metadata', '{}'::jsonb);

  if v_lock_source_type not in ('source', 'derived_safety') then
    raise exception 'round_snapshot_invalid_lock_source';
  end if;

  if v_lock_source_type = 'derived_safety' and not v_lock_is_derived then
    raise exception 'round_snapshot_invalid_lock_provenance';
  end if;

  if jsonb_typeof(v_source_metadata) is distinct from 'object' then
    raise exception 'round_snapshot_invalid_source_metadata';
  end if;

  v_result := public.toto_import_round_snapshot(p_snapshot);
  v_round_id := (v_result ->> 'round_id')::uuid;

  select r.lock_at into v_lock_at
  from public.rounds r
  where r.id = v_round_id;

  insert into public.round_import_provenance (
    round_id,
    lock_source_type,
    lock_source_ref,
    lock_is_derived,
    source_metadata,
    created_at,
    updated_at
  )
  values (
    v_round_id,
    v_lock_source_type,
    v_lock_source_ref,
    v_lock_is_derived,
    v_source_metadata,
    now(),
    now()
  )
  on conflict (round_id)
  do update set
    lock_source_type = excluded.lock_source_type,
    lock_source_ref = excluded.lock_source_ref,
    lock_is_derived = excluded.lock_is_derived,
    source_metadata = excluded.source_metadata,
    updated_at = now()
  where now() < v_lock_at;

  return v_result || jsonb_build_object(
    'lock_source_type', v_lock_source_type,
    'lock_source_ref', v_lock_source_ref,
    'lock_is_derived', v_lock_is_derived
  );
end;
$$;

revoke all on function public.toto_import_round_snapshot_v2(jsonb)
from public, anon, authenticated;

grant execute on function public.toto_import_round_snapshot_v2(jsonb)
to service_role;
