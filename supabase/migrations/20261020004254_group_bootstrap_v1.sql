-- Server-only group bootstrap primitives used by the authenticated app.

create or replace function public.kapiloto_create_group(
  p_user_id uuid,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group_id uuid;
  v_join_code text;
  v_name text;
begin
  v_name := trim(coalesce(p_name, ''));

  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'group_name_invalid';
  end if;

  if not exists (
    select 1 from auth.users u where u.id = p_user_id
  ) then
    raise exception 'group_user_not_found';
  end if;

  loop
    v_join_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (
      select 1 from public.groups g where g.join_code = v_join_code
    );
  end loop;

  insert into public.groups (
    name,
    owner_user_id,
    join_code,
    default_max_doubles,
    created_at,
    updated_at
  )
  values (
    v_name,
    p_user_id,
    v_join_code,
    7,
    now(),
    now()
  )
  returning id into v_group_id;

  insert into public.group_members (
    group_id,
    user_id,
    role,
    status,
    joined_at
  )
  values (
    v_group_id,
    p_user_id,
    'owner',
    'active',
    now()
  );

  return jsonb_build_object(
    'group_id', v_group_id,
    'name', v_name,
    'join_code', v_join_code,
    'role', 'owner',
    'default_max_doubles', 7
  );
end;
$$;

create or replace function public.kapiloto_ensure_group_round_settings(
  p_user_id uuid,
  p_group_id uuid,
  p_round_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_default_max_doubles integer;
  v_lock_at timestamptz;
  v_settings public.group_round_settings%rowtype;
begin
  if not exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = p_user_id
      and gm.status = 'active'
  ) then
    raise exception 'group_membership_required';
  end if;

  select g.default_max_doubles
    into v_default_max_doubles
  from public.groups g
  where g.id = p_group_id;

  if v_default_max_doubles is null then
    raise exception 'group_not_found';
  end if;

  select r.lock_at
    into v_lock_at
  from public.rounds r
  where r.id = p_round_id;

  if v_lock_at is null then
    raise exception 'round_not_found';
  end if;

  if now() >= v_lock_at then
    raise exception 'round_already_locked';
  end if;

  insert into public.group_round_settings (
    group_id,
    round_id,
    max_doubles,
    consensus_double_policy,
    visibility_policy,
    created_from_group_defaults_at,
    locked_at
  )
  values (
    p_group_id,
    p_round_id,
    v_default_max_doubles,
    'up_to_max',
    'after_own_submission',
    now(),
    null
  )
  on conflict (group_id, round_id) do nothing;

  select s.*
    into v_settings
  from public.group_round_settings s
  where s.group_id = p_group_id
    and s.round_id = p_round_id;

  return jsonb_build_object(
    'group_id', v_settings.group_id,
    'round_id', v_settings.round_id,
    'max_doubles', v_settings.max_doubles,
    'consensus_double_policy', v_settings.consensus_double_policy,
    'visibility_policy', v_settings.visibility_policy,
    'locked_at', v_settings.locked_at
  );
end;
$$;

revoke all on function public.kapiloto_create_group(uuid, text)
from public, anon, authenticated;
revoke all on function public.kapiloto_ensure_group_round_settings(uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function public.kapiloto_create_group(uuid, text)
to service_role;
grant execute on function public.kapiloto_ensure_group_round_settings(uuid, uuid, uuid)
to service_role;
