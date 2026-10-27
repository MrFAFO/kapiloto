-- Server-only group join request and approval transitions.

create or replace function public.kapiloto_request_group_join(
  p_user_id uuid,
  p_join_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group public.groups%rowtype;
  v_request public.join_requests%rowtype;
  v_code text;
begin
  v_code := upper(trim(coalesce(p_join_code, '')));

  if char_length(v_code) < 4 or char_length(v_code) > 32 then
    raise exception 'join_code_invalid';
  end if;

  if not exists (
    select 1 from auth.users u where u.id = p_user_id
  ) then
    raise exception 'join_user_not_found';
  end if;

  select g.*
    into v_group
  from public.groups g
  where upper(g.join_code) = v_code;

  if not found then
    raise exception 'join_code_not_found';
  end if;

  if exists (
    select 1
    from public.group_members gm
    where gm.group_id = v_group.id
      and gm.user_id = p_user_id
      and gm.status = 'active'
  ) then
    return jsonb_build_object(
      'group_id', v_group.id,
      'group_name', v_group.name,
      'status', 'already_member',
      'request_id', null
    );
  end if;

  select jr.*
    into v_request
  from public.join_requests jr
  where jr.group_id = v_group.id
    and jr.user_id = p_user_id
    and jr.status = 'pending'
  order by jr.requested_at desc
  limit 1;

  if not found then
    insert into public.join_requests (
      group_id,
      user_id,
      status,
      requested_at
    )
    values (
      v_group.id,
      p_user_id,
      'pending',
      now()
    )
    returning * into v_request;
  end if;

  return jsonb_build_object(
    'group_id', v_group.id,
    'group_name', v_group.name,
    'status', 'pending',
    'request_id', v_request.id
  );
end;
$$;

create or replace function public.kapiloto_decide_group_join(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.join_requests%rowtype;
  v_role text;
  v_now timestamptz := now();
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'join_decision_invalid';
  end if;

  select jr.*
    into v_request
  from public.join_requests jr
  where jr.id = p_request_id
  for update;

  if not found then
    raise exception 'join_request_not_found';
  end if;

  select gm.role
    into v_role
  from public.group_members gm
  where gm.group_id = v_request.group_id
    and gm.user_id = p_actor_user_id
    and gm.status = 'active'
    and gm.role in ('owner', 'admin');

  if v_role is null then
    raise exception 'join_admin_required';
  end if;

  if v_request.status <> 'pending' then
    return jsonb_build_object(
      'request_id', v_request.id,
      'group_id', v_request.group_id,
      'user_id', v_request.user_id,
      'status', v_request.status,
      'replayed', true
    );
  end if;

  update public.join_requests
  set status = p_decision,
      decided_at = v_now,
      decided_by = p_actor_user_id
  where id = v_request.id;

  if p_decision = 'approved' then
    insert into public.group_members (
      group_id,
      user_id,
      role,
      status,
      joined_at,
      left_at
    )
    values (
      v_request.group_id,
      v_request.user_id,
      'member',
      'active',
      v_now,
      null
    )
    on conflict (group_id, user_id)
    do update
      set role = case
            when public.group_members.role = 'owner' then 'owner'
            else 'member'
          end,
          status = 'active',
          joined_at = excluded.joined_at,
          left_at = null;
  end if;

  return jsonb_build_object(
    'request_id', v_request.id,
    'group_id', v_request.group_id,
    'user_id', v_request.user_id,
    'status', p_decision,
    'replayed', false
  );
end;
$$;

revoke all on function public.kapiloto_request_group_join(uuid, text)
from public, anon, authenticated;
revoke all on function public.kapiloto_decide_group_join(uuid, uuid, text)
from public, anon, authenticated;

grant execute on function public.kapiloto_request_group_join(uuid, text)
to service_role;
grant execute on function public.kapiloto_decide_group_join(uuid, uuid, text)
to service_role;
