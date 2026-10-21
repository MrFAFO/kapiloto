create or replace function public.kapiloto_resolve_username(
  p_normalized_username text
)
returns table (
  identifier_type text,
  preferred_auth_identifier text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.identifier_type,
    a.preferred_auth_identifier
  from private.auth_username_aliases a
  where a.normalized_username = lower(trim(p_normalized_username))
  limit 1;
$$;

revoke all on function public.kapiloto_resolve_username(text)
  from public, anon, authenticated;
grant execute on function public.kapiloto_resolve_username(text)
  to service_role;

create or replace function public.kapiloto_register_identity(
  p_user_id uuid,
  p_username text,
  p_preferred_auth_identifier text,
  p_identifier_type text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text := trim(p_username);
  v_normalized_username text := lower(trim(p_username));
begin
  if char_length(v_username) < 3 or char_length(v_username) > 40 then
    raise exception 'invalid username';
  end if;

  if p_identifier_type not in ('email', 'phone') then
    raise exception 'invalid identifier type';
  end if;

  insert into public.profiles (id, username)
  values (p_user_id, v_username);

  insert into private.auth_username_aliases (
    normalized_username,
    user_id,
    preferred_auth_identifier,
    identifier_type
  )
  values (
    v_normalized_username,
    p_user_id,
    p_preferred_auth_identifier,
    p_identifier_type
  );
end;
$$;

revoke all on function public.kapiloto_register_identity(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.kapiloto_register_identity(uuid, text, text, text)
  to service_role;
