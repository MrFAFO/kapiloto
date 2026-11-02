-- Kapiloto V4 M2C verification (read-only; runbook §A).
--
-- Run AFTER the M2C revoke has committed, as its own execution. It reads
-- catalogs only and raises an exception listing every violation, so the
-- operator sees PASS only when ingest is paused for every application path:
--   1. each ingest RPC is owned only by a reviewed Supabase operator role
--      (postgres or supabase_admin);
--   2. no other role can execute either RPC, including through role
--      membership, explicit grants, PUBLIC, or the default ACL;
--   4. no SECURITY DEFINER function and no pg_cron job calls them (both run
--      as their owner and would bypass the revoke);
--   4. no other backend is still executing an ingest call. The V2 ingest's
--      shared provider-identity advisory lock is the authoritative drain
--      signal; pg_stat_activity is an additional diagnostic. A call that
--      passed its EXECUTE check before the revoke committed runs to the end
--      and may commit; re-run this check until it passes.
-- Not a migration; never place it under supabase/migrations.

do $m2c_verify$
declare
  v_ingest constant regprocedure[] := array[
    'public.match_ledger_ingest_provider_fixture_v2(jsonb)'::regprocedure,
    'public.match_ledger_ingest_provider_fixture(jsonb)'::regprocedure
  ];
  v_problems text[] := array[]::text[];
  r record;
  v_cron_jobs integer;
begin
  for r in
    select p.oid::regprocedure as fn,
           case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end as grantee
    from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = any(v_ingest::oid[])
      and a.privilege_type = 'EXECUTE'
      and a.grantee <> p.proowner
      and (a.grantee = 0 or pg_catalog.pg_get_userbyid(a.grantee) not in ('postgres', 'supabase_admin'))
    order by 1, 2
  loop
    v_problems := v_problems || format('%s: EXECUTE granted to %s', r.fn, r.grantee);
  end loop;

  for r in
    select f.fn, ro.rolname
    from unnest(v_ingest) as f(fn)
    cross join pg_catalog.pg_roles ro
    where ro.rolname not in ('postgres', 'supabase_admin')
      and pg_catalog.has_function_privilege(ro.oid, f.fn, 'execute')
    order by 1, 2
  loop
    v_problems := v_problems || format('%s: executable by non-operator role %s', r.fn, r.rolname);
  end loop;

  for r in
    select p.oid::regprocedure as fn, pg_catalog.pg_get_userbyid(p.proowner) as owner
    from pg_catalog.pg_proc p
    where p.oid = any(v_ingest::oid[])
      and pg_catalog.pg_get_userbyid(p.proowner) not in ('postgres', 'supabase_admin')
  loop
    v_problems := v_problems || format('%s: owned by non-operator role %s', r.fn, r.owner);
  end loop;

  for r in
    select p.oid::regprocedure as fn
    from pg_catalog.pg_proc p
    where p.prosecdef
      and p.prosrc ilike '%match_ledger_ingest_provider_fixture%'
    order by 1
  loop
    v_problems := v_problems || format('SECURITY DEFINER function %s references a provider ingest RPC', r.fn);
  end loop;

  if exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = pg_catalog.to_regclass('cron.job') and a.attname = 'command' and not a.attisdropped
  ) then
    execute $q$select count(*)::int from cron.job where command ilike '%match_ledger_ingest_provider_fixture%'$q$
      into v_cron_jobs;
    if v_cron_jobs > 0 then
      v_problems := v_problems || format('%s pg_cron job(s) call a provider ingest RPC', v_cron_jobs);
    end if;
  end if;

  for r in
    select l.pid, l.mode
    from pg_catalog.pg_locks l
    where l.locktype = 'advisory'
      and l.granted
      and l.objsubid = 1
      and ((l.classid::bigint << 32) | l.objid::bigint)
          = pg_catalog.hashtextextended('kapiloto_v4_provider_identity:sportmonks', 0)
      and l.mode = 'ShareLock'
    order by l.pid
  loop
    v_problems := v_problems || format(
      'backend %s still holds the Sportmonks provider-identity ShareLock; a V2 ingest call is still in flight',
      r.pid
    );
  end loop;

  for r in
    select a.pid, a.state, a.xact_start
    from pg_catalog.pg_stat_activity a
    where a.pid <> pg_catalog.pg_backend_pid()
      and a.state is distinct from 'idle'
      and a.query ilike '%match_ledger_ingest_provider_fixture%'
    order by a.pid
  loop
    v_problems := v_problems || format('backend %s (%s since %s) is still executing an ingest call; re-run until drained',
      r.pid, r.state, r.xact_start);
  end loop;

  if cardinality(v_problems) > 0 then
    raise exception 'M2C verification FAILED: %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'M2C verification PASSED: ingest RPC ownership is operator-only, no non-operator role can execute, and no V2 ingest call is in flight';
end;
$m2c_verify$;
