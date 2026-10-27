-- Supabase-owned live sync scheduler for Winner 16.
-- The scheduler stays inside Supabase so live updates do not depend on Vercel
-- cron frequency or deployment-plan limits.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create schema if not exists private;

create table if not exists private.kapiloto_scheduler_secrets (
  name text primary key,
  secret_sha256 text not null,
  created_at timestamptz not null default now()
);

alter table private.kapiloto_scheduler_secrets enable row level security;
revoke all on table private.kapiloto_scheduler_secrets
from public, anon, authenticated;

create or replace function public.kapiloto_verify_scheduler_secret(
  p_name text,
  p_secret text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.kapiloto_scheduler_secrets s
    where s.name = p_name
      and s.secret_sha256 =
        encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')
  );
$$;

revoke all on function public.kapiloto_verify_scheduler_secret(text, text)
from public, anon, authenticated;
grant execute on function public.kapiloto_verify_scheduler_secret(text, text)
to service_role;

create or replace function public.toto_apply_round_state_v1(
  p_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_update jsonb;
  v_results jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if p_updates is null or jsonb_typeof(p_updates) <> 'array' then
    raise exception 'round_state_updates_array_required';
  end if;

  if jsonb_array_length(p_updates) > 16 then
    raise exception 'round_state_updates_too_many';
  end if;

  for v_update in
    select value
    from jsonb_array_elements(p_updates)
  loop
    v_results := v_results || jsonb_build_array(
      public.toto_apply_game_state_v1(v_update)
    );
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object(
    'updates_applied', v_count,
    'results', v_results
  );
end;
$$;

revoke all on function public.toto_apply_round_state_v1(jsonb)
from public, anon, authenticated;
grant execute on function public.toto_apply_round_state_v1(jsonb)
to service_role;

-- Generate the scheduler secret inside Postgres. The raw value is stored only
-- in Vault; the verifier table stores only its SHA-256 digest.
do $scheduler_secret$
declare
  v_secret text;
begin
  select decrypted_secret
    into v_secret
  from vault.decrypted_secrets
  where name = 'kapiloto_live_sync_cron_secret'
  limit 1;

  if v_secret is null then
    v_secret := encode(extensions.gen_random_bytes(32), 'hex');
    perform vault.create_secret(
      v_secret,
      'kapiloto_live_sync_cron_secret',
      'Kapiloto live-sync scheduler secret'
    );
  end if;

  insert into private.kapiloto_scheduler_secrets (name, secret_sha256)
  values (
    'live_sync',
    encode(extensions.digest(v_secret, 'sha256'), 'hex')
  )
  on conflict (name)
  do update set secret_sha256 = excluded.secret_sha256;
end;
$scheduler_secret$;

select cron.unschedule(jobid)
from cron.job
where jobname = 'kapiloto-live-sync-every-2-min';

select cron.schedule(
  'kapiloto-live-sync-every-2-min',
  '*/2 * * * *',
  $cron$
    select net.http_post(
      url := 'https://lodbntwfdnzzvgjlnowu.supabase.co/functions/v1/kapiloto-live-sync',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := jsonb_build_object(
        'secret',
        (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'kapiloto_live_sync_cron_secret'
          limit 1
        )
      ),
      timeout_milliseconds := 30000
    )
    where exists (
      select 1
      from public.rounds r
      join public.round_games g on g.round_id = r.id
      where r.source = 'telesport-winner16'
        and r.status <> 'settled'
      group by r.id
      having now() >= min(g.kickoff_at) - interval '30 minutes'
    );
  $cron$
);
