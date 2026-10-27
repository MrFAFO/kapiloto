-- Transaction-safe Toto draft persistence and immutable submission snapshots.

create or replace function public.toto_save_ticket_draft(
  p_group_id uuid,
  p_round_id uuid,
  p_user_id uuid,
  p_expected_revision bigint,
  p_picks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.user_tickets%rowtype;
  v_lock_at timestamptz;
  v_max_doubles integer;
  v_pick_count integer;
  v_distinct_count integer;
  v_double_count integer;
  v_invalid_count integer;
  v_now timestamptz := now();
begin
  if jsonb_typeof(p_picks) is distinct from 'array' then
    raise exception 'ticket picks must be a JSON array';
  end if;

  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = p_user_id
      and gm.status = 'active'
  ) then
    raise exception 'ticket_user_not_active_member';
  end if;

  select r.lock_at
    into v_lock_at
  from public.rounds r
  where r.id = p_round_id;

  if v_lock_at is null then
    raise exception 'ticket_round_not_found';
  end if;

  if v_now >= v_lock_at then
    raise exception 'ticket_round_locked';
  end if;

  select s.max_doubles
    into v_max_doubles
  from public.group_round_settings s
  where s.group_id = p_group_id
    and s.round_id = p_round_id;

  if v_max_doubles is null then
    raise exception 'ticket_group_round_settings_missing';
  end if;

  select
    count(*),
    count(distinct nullif(item ->> 'round_game_id', '')),
    count(*) filter (where item ->> 'pick' in ('1X', 'X2', '12')),
    count(*) filter (
      where
        nullif(item ->> 'round_game_id', '') is null
        or item ->> 'pick' not in ('1', 'X', '2', '1X', 'X2', '12')
    )
  into
    v_pick_count,
    v_distinct_count,
    v_double_count,
    v_invalid_count
  from jsonb_array_elements(p_picks) item;

  if v_pick_count > 16 then
    raise exception 'ticket_too_many_picks';
  end if;

  if v_distinct_count <> v_pick_count then
    raise exception 'ticket_duplicate_fixture';
  end if;

  if v_invalid_count <> 0 then
    raise exception 'ticket_invalid_pick_payload';
  end if;

  if v_double_count > v_max_doubles then
    raise exception 'ticket_maximum_doubles_exceeded';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_picks) item
    left join public.round_games g
      on g.id = (item ->> 'round_game_id')::uuid
     and g.round_id = p_round_id
    where g.id is null
  ) then
    raise exception 'ticket_fixture_not_in_round';
  end if;

  select t.*
    into v_ticket
  from public.user_tickets t
  where t.group_id = p_group_id
    and t.round_id = p_round_id
    and t.user_id = p_user_id
  for update;

  if not found then
    if p_expected_revision is not null and p_expected_revision <> 0 then
      raise exception 'ticket_revision_conflict';
    end if;

    insert into public.user_tickets (
      group_id,
      round_id,
      user_id,
      state,
      revision,
      created_at,
      updated_at
    )
    values (
      p_group_id,
      p_round_id,
      p_user_id,
      'draft',
      0,
      v_now,
      v_now
    )
    returning * into v_ticket;
  elsif p_expected_revision is not null
        and v_ticket.revision <> p_expected_revision then
    raise exception 'ticket_revision_conflict';
  end if;

  if v_ticket.state = 'locked' then
    raise exception 'ticket_is_locked';
  end if;

  delete from public.user_ticket_picks
  where user_ticket_id = v_ticket.id;

  insert into public.user_ticket_picks (
    user_ticket_id,
    round_game_id,
    pick,
    updated_at
  )
  select
    v_ticket.id,
    (item ->> 'round_game_id')::uuid,
    item ->> 'pick',
    v_now
  from jsonb_array_elements(p_picks) item;

  update public.user_tickets
  set revision = revision + 1,
      updated_at = v_now
  where id = v_ticket.id
  returning * into v_ticket;

  return jsonb_build_object(
    'ticket_id', v_ticket.id,
    'state', v_ticket.state,
    'revision', v_ticket.revision,
    'pick_count', v_pick_count,
    'doubles_used', v_double_count,
    'max_doubles', v_max_doubles,
    'submitted_at', v_ticket.submitted_at
  );
end;
$$;

create or replace function public.toto_submit_ticket(
  p_group_id uuid,
  p_round_id uuid,
  p_user_id uuid,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.user_tickets%rowtype;
  v_lock_at timestamptz;
  v_max_doubles integer;
  v_pick_count integer;
  v_distinct_count integer;
  v_double_count integer;
  v_version_id uuid;
  v_version_no integer;
  v_now timestamptz := now();
begin
  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = p_user_id
      and gm.status = 'active'
  ) then
    raise exception 'ticket_user_not_active_member';
  end if;

  select r.lock_at
    into v_lock_at
  from public.rounds r
  where r.id = p_round_id;

  if v_lock_at is null then
    raise exception 'ticket_round_not_found';
  end if;

  if v_now >= v_lock_at then
    raise exception 'ticket_round_locked';
  end if;

  select s.max_doubles
    into v_max_doubles
  from public.group_round_settings s
  where s.group_id = p_group_id
    and s.round_id = p_round_id;

  if v_max_doubles is null then
    raise exception 'ticket_group_round_settings_missing';
  end if;

  select t.*
    into v_ticket
  from public.user_tickets t
  where t.group_id = p_group_id
    and t.round_id = p_round_id
    and t.user_id = p_user_id
  for update;

  if not found then
    raise exception 'ticket_not_found';
  end if;

  if v_ticket.state = 'locked' then
    raise exception 'ticket_is_locked';
  end if;

  if p_expected_revision is not null
     and v_ticket.revision <> p_expected_revision then
    raise exception 'ticket_revision_conflict';
  end if;

  select
    count(*),
    count(distinct p.round_game_id),
    count(*) filter (where p.pick in ('1X', 'X2', '12'))
  into
    v_pick_count,
    v_distinct_count,
    v_double_count
  from public.user_ticket_picks p
  where p.user_ticket_id = v_ticket.id;

  if v_pick_count <> 16 or v_distinct_count <> 16 then
    raise exception 'ticket_requires_16_picks';
  end if;

  if v_double_count > v_max_doubles then
    raise exception 'ticket_maximum_doubles_exceeded';
  end if;

  if (
    select count(*)
    from public.user_ticket_picks p
    join public.round_games g on g.id = p.round_game_id
    where p.user_ticket_id = v_ticket.id
      and g.round_id = p_round_id
  ) <> 16 then
    raise exception 'ticket_fixture_not_in_round';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_ticket.id::text, 1));

  select coalesce(max(v.version_no), 0) + 1
    into v_version_no
  from public.ticket_versions v
  where v.user_ticket_id = v_ticket.id;

  insert into public.ticket_versions (
    user_ticket_id,
    version_no,
    state_at_snapshot,
    submitted_at,
    created_at
  )
  values (
    v_ticket.id,
    v_version_no,
    'submitted',
    v_now,
    v_now
  )
  returning id into v_version_id;

  insert into public.ticket_version_picks (
    ticket_version_id,
    round_game_id,
    pick
  )
  select
    v_version_id,
    p.round_game_id,
    p.pick
  from public.user_ticket_picks p
  where p.user_ticket_id = v_ticket.id;

  update public.user_tickets
  set state = 'submitted',
      submitted_at = v_now,
      revision = revision + 1,
      updated_at = v_now
  where id = v_ticket.id
  returning * into v_ticket;

  update public.consensus_versions
  set stale_at = coalesce(stale_at, v_now),
      stale_reason = coalesce(stale_reason, 'member_resubmitted_ticket')
  where group_id = p_group_id
    and round_id = p_round_id
    and is_current = true;

  return jsonb_build_object(
    'ticket_id', v_ticket.id,
    'state', v_ticket.state,
    'revision', v_ticket.revision,
    'submitted_at', v_ticket.submitted_at,
    'version_id', v_version_id,
    'version_no', v_version_no,
    'pick_count', v_pick_count,
    'doubles_used', v_double_count,
    'max_doubles', v_max_doubles
  );
end;
$$;

revoke all on function public.toto_save_ticket_draft(uuid, uuid, uuid, bigint, jsonb)
from public, anon, authenticated;
revoke all on function public.toto_submit_ticket(uuid, uuid, uuid, bigint)
from public, anon, authenticated;

grant execute on function public.toto_save_ticket_draft(uuid, uuid, uuid, bigint, jsonb)
to service_role;
grant execute on function public.toto_submit_ticket(uuid, uuid, uuid, bigint)
to service_role;
