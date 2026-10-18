create table private.auth_rate_limits (
  bucket text not null,
  key_hash text not null,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (bucket, key_hash)
);

alter table private.auth_rate_limits enable row level security;
revoke all on table private.auth_rate_limits from public, anon, authenticated;

create or replace function public.kapiloto_consume_auth_rate_limit(
  p_bucket text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.auth_rate_limits%rowtype;
  v_now timestamptz := now();
begin
  if p_bucket is null or p_bucket = ''
     or p_key_hash is null or p_key_hash = ''
     or p_limit < 1
     or p_window_seconds < 1 then
    raise exception 'invalid rate limit input';
  end if;

  insert into private.auth_rate_limits (
    bucket,
    key_hash,
    window_started_at,
    request_count,
    updated_at
  )
  values (
    p_bucket,
    p_key_hash,
    v_now,
    0,
    v_now
  )
  on conflict (bucket, key_hash) do nothing;

  select *
    into v_row
  from private.auth_rate_limits
  where bucket = p_bucket
    and key_hash = p_key_hash
  for update;

  if v_row.window_started_at + make_interval(secs => p_window_seconds) <= v_now then
    update private.auth_rate_limits
    set window_started_at = v_now,
        request_count = 1,
        updated_at = v_now
    where bucket = p_bucket
      and key_hash = p_key_hash;
    return true;
  end if;

  if v_row.request_count >= p_limit then
    return false;
  end if;

  update private.auth_rate_limits
  set request_count = request_count + 1,
      updated_at = v_now
  where bucket = p_bucket
    and key_hash = p_key_hash;

  return true;
end;
$$;

revoke all on function public.kapiloto_consume_auth_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.kapiloto_consume_auth_rate_limit(text, text, integer, integer)
  to service_role;
