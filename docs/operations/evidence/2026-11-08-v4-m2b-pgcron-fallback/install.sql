-- Kapiloto V4 M2B/M2C pg_cron FALLBACK rehearsal objects (DISPOSABLE database only).
--
-- Installed by scratchpad/pgcron-fallback/run.ts after the disposable guard,
-- dropped again by its cleanup. Every actor and the driver run as one-shot
-- pg_cron jobs, so each is its own PostgreSQL backend (pg_cron libpq mode).
--
-- Coordination is lock-state only:
--   * each backend holds a session advisory "id:<actor>" lock, so the driver
--     maps actor names to backend pids by reading pg_locks;
--   * the driver holds an exclusive session advisory lock per gate and then
--     a READY lock; an actor waits for READY in pg_locks, then requests each
--     gate SHARE and blocks until the driver releases it;
--   * the driver's handshakes read the harness's LOCK_SNAPSHOT_SQL
--     (kapiloto_rehearsal.sqltext 'lock_snapshot') until the expected
--     holder/waiter is observed (3s deadline).
-- Results are written when each actor's transaction commits; the driver keeps
-- its evidence in a variable so a failure cannot roll it back.

create schema kapiloto_rehearsal;
revoke all on schema kapiloto_rehearsal from public;

create table kapiloto_rehearsal.sqltext (name text primary key, body text not null);

create table kapiloto_rehearsal.world (
  exp text primary key,
  payload jsonb not null,
  revocation jsonb not null,
  keys jsonb not null,
  params jsonb not null
);

create table kapiloto_rehearsal.script (
  exp text not null,
  actor text not null,
  seq int not null,
  op text not null,
  arg jsonb not null default '{}'::jsonb,
  primary key (exp, actor, seq)
);

create table kapiloto_rehearsal.result (
  id bigserial primary key,
  run_tag text not null,
  exp text not null,
  actor text not null,
  seq int not null,
  op text not null,
  arg jsonb,
  ok boolean,
  sqlstate text,
  message text,
  where_ text,
  value jsonb,
  pid int not null,
  app text,
  started_at timestamptz,
  finished_at timestamptz
);

create table kapiloto_rehearsal.evidence (
  id bigserial primary key,
  run_tag text not null,
  exp text not null,
  seq int not null,
  kind text not null,
  label text,
  ok boolean,
  data jsonb,
  at text,
  pid int
);

create function kapiloto_rehearsal.k(p_run text, p_exp text, p_name text) returns text
language sql immutable
as $$ select 'kapiloto_rehearsal:' || p_run || ':' || p_exp || ':' || p_name $$;

create function kapiloto_rehearsal.e(p_kind text, p_label text, p_ok boolean, p_data jsonb) returns jsonb
language sql volatile
as $$
  select jsonb_build_array(jsonb_build_object(
    'kind', p_kind, 'label', p_label, 'ok', p_ok, 'data', p_data, 'pid', pg_catalog.pg_backend_pid(),
    'at', pg_catalog.to_char(pg_catalog.clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
$$;

create function kapiloto_rehearsal.holds(s jsonb, p int, lbl text, md text, gr boolean) returns boolean
language sql immutable
as $$
  select exists (select 1 from jsonb_array_elements(s) r
                 where (r->>'pid')::int = p and r->>'label' = lbl and r->>'mode' = md and (r->>'granted')::boolean = gr)
$$;

create function kapiloto_rehearsal.blocked(s jsonb, p int, by_pid int) returns boolean
language sql immutable
as $$
  select exists (select 1 from jsonb_array_elements(s) r
                 where (r->>'pid')::int = p and not (r->>'granted')::boolean and r->'blocked_by' @> pg_catalog.to_jsonb(array[by_pid]))
$$;

-- The harness's LOCK_SNAPSHOT_SQL (verbatim, from sqltext) over the world's
-- identity / pair / fixture keys plus this experiment's gate keys.
create function kapiloto_rehearsal.snap(p_run text, p_exp text) returns jsonb
language plpgsql volatile set search_path = pg_catalog, public
as $$
declare
  v_keys jsonb;
  v_labels text[];
  v_lock_keys text[];
  v_body text;
  v_out jsonb;
begin
  select w.keys into strict v_keys from kapiloto_rehearsal.world w where w.exp = p_exp;
  select array_agg(x.key order by x.key), array_agg(x.value order by x.key) into v_labels, v_lock_keys
  from jsonb_each_text(v_keys) x;
  select v_labels || coalesce(array_agg('gate:' || g.gate order by g.gate), '{}'),
         v_lock_keys || coalesce(array_agg(kapiloto_rehearsal.k(p_run, p_exp, 'gate:' || g.gate) order by g.gate), '{}')
    into v_labels, v_lock_keys
  from (select distinct sc.arg->>'gate' as gate from kapiloto_rehearsal.script sc where sc.exp = p_exp and sc.op = 'gate') g;
  select t.body into strict v_body from kapiloto_rehearsal.sqltext t where t.name = 'lock_snapshot';
  execute 'select coalesce(jsonb_agg(to_jsonb(s)), ''[]''::jsonb) from (' || v_body || ') s' into v_out using v_labels, v_lock_keys;
  return v_out;
end;
$$;

-- Named observer reads (the harness's SQL text, from sqltext), typed parameters from the world.
create function kapiloto_rehearsal.observe(p_run text, p_exp text, p_name text) returns jsonb
language plpgsql volatile set search_path = pg_catalog, public
as $$
declare
  v_params jsonb;
  v_sql text;
  v_out jsonb;
  v_obs uuid;
  v_evt uuid;
begin
  select w.params into strict v_params from kapiloto_rehearsal.world w where w.exp = p_exp;
  select t.body into strict v_sql from kapiloto_rehearsal.sqltext t where t.name = 'observe:' || p_name;
  v_sql := 'select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from (' || v_sql || ') q';
  case p_name
    when 'team_trust', 'impact' then
      execute v_sql into v_out using (v_params->>'provider_home_team_id');
    when 'trusted_read' then
      execute v_sql into v_out using (v_params->>'fixture_id');
    when 'items' then
      execute v_sql into v_out using (v_params->>'run_id')::uuid;
    when 'footprint' then
      execute v_sql into v_out using (v_params->>'fixture_id')::uuid, (v_params->>'run_id')::uuid, (v_params->>'provider_home_team_id');
    when 'order' then
      select (r.value->>'observation_id')::uuid into v_obs from kapiloto_rehearsal.result r
       where r.run_tag = p_run and r.exp = p_exp and r.actor = 'A' and r.op = 'v2' and r.ok;
      select (r.value->>'event_id')::uuid into v_evt from kapiloto_rehearsal.result r
       where r.run_tag = p_run and r.exp = p_exp and r.actor = 'B' and r.op = 'revoke' and r.ok;
      execute v_sql into v_out using v_obs, v_evt;
  end case;
  return v_out;
end;
$$;

-- One-shot actor: runs its script rows in ONE transaction (the pg_cron job's),
-- recording every operation's outcome; results commit with the transaction.
create function kapiloto_rehearsal.actor(p_run text, p_exp text, p_actor text) returns text
language plpgsql volatile set search_path = pg_catalog, public
as $actor$
declare
  v_world kapiloto_rehearsal.world;
  v_ops jsonb;
  v_op jsonb;
  v_out jsonb := '[]'::jsonb;
  v_t timestamptz;
  v_val jsonb;
  v_state text;
  v_msg text;
  v_ctx text;
  v_ok boolean;
  v_deadline timestamptz;
  v_stop boolean := false;
begin
  if exists (select 1 from kapiloto_rehearsal.result r where r.run_tag = p_run and r.exp = p_exp and r.actor = p_actor) then
    return 'already ran';
  end if;
  perform pg_catalog.set_config('application_name', 'kapiloto-m2b-rehearsal:' || p_run || ':' || p_exp || '-' || p_actor, false);
  perform pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended(kapiloto_rehearsal.k(p_run, p_exp, 'id:' || p_actor), 0));
  select * into strict v_world from kapiloto_rehearsal.world w where w.exp = p_exp;
  select coalesce(jsonb_agg(to_jsonb(sc) order by sc.seq), '[]'::jsonb) into v_ops
  from kapiloto_rehearsal.script sc where sc.exp = p_exp and sc.actor = p_actor;

  v_deadline := pg_catalog.clock_timestamp() + interval '25 seconds';
  while not exists (
    select 1 from pg_catalog.pg_locks l
    where l.locktype = 'advisory' and l.objsubid = 1 and l.granted
      and ((l.classid::bigint << 32) | l.objid::bigint) = pg_catalog.hashtextextended(kapiloto_rehearsal.k(p_run, p_exp, 'ready'), 0)
  ) loop
    if pg_catalog.clock_timestamp() > v_deadline then
      v_out := v_out || jsonb_build_object('seq', 0, 'op', 'ready', 'ok', false, 'message', 'driver READY lock not observed within 25s',
        'pid', pg_catalog.pg_backend_pid(), 'started_at', v_deadline, 'finished_at', pg_catalog.clock_timestamp());
      v_stop := true;
      exit;
    end if;
    perform pg_catalog.pg_sleep(0.02);
  end loop;

  for v_op in select x from jsonb_array_elements(v_ops) x loop
    exit when v_stop;
    v_t := pg_catalog.clock_timestamp();
    v_val := null; v_ok := true; v_state := null; v_msg := null; v_ctx := null;
    begin
      case v_op->>'op'
        when 'gate' then
          perform pg_catalog.set_config('lock_timeout', '30s', true);
          perform pg_catalog.pg_advisory_xact_lock_shared(
            pg_catalog.hashtextextended(kapiloto_rehearsal.k(p_run, p_exp, 'gate:' || (v_op->'arg'->>'gate')), 0));
        when 'role' then
          set local role service_role;
        when 'reset_role' then
          reset role;
        when 'hold' then
          perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_world.keys->>(v_op->'arg'->>'key'), 0));
        when 'v2' then
          select public.match_ledger_ingest_provider_fixture_v2(v_world.payload) into v_val;
        when 'revoke' then
          select public.provider_identity_revoke_team(v_world.revocation) into v_val;
        when 'm2c' then
          perform pg_catalog.set_config('lock_timeout', '2s', true);
          execute (select t.body from kapiloto_rehearsal.sqltext t where t.name = 'm2c_revoke');
        else
          raise exception 'unknown actor op %', v_op->>'op';
      end case;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_ctx = pg_exception_context;
      v_ok := false;
    end;
    v_out := v_out || jsonb_build_object('seq', (v_op->>'seq')::int, 'op', v_op->>'op', 'arg', v_op->'arg', 'ok', v_ok,
      'sqlstate', v_state, 'message', v_msg, 'where', v_ctx, 'value', v_val, 'pid', pg_catalog.pg_backend_pid(),
      'started_at', v_t, 'finished_at', pg_catalog.clock_timestamp());
    if not v_ok and v_op->>'op' in ('gate', 'role', 'reset_role', 'hold') then
      v_stop := true;
    end if;
  end loop;

  begin
    reset role;
  exception when others then
    null;
  end;
  insert into kapiloto_rehearsal.result (run_tag, exp, actor, seq, op, arg, ok, sqlstate, message, where_, value, pid, app, started_at, finished_at)
  select p_run, p_exp, p_actor, (x->>'seq')::int, x->>'op', x->'arg', (x->>'ok')::boolean, x->>'sqlstate', x->>'message', x->>'where',
         x->'value', (x->>'pid')::int, pg_catalog.current_setting('application_name'), (x->>'started_at')::timestamptz, (x->>'finished_at')::timestamptz
  from jsonb_array_elements(v_out) x;
  insert into kapiloto_rehearsal.result (run_tag, exp, actor, seq, op, ok, pid, app, started_at, finished_at)
  values (p_run, p_exp, p_actor, 999, 'end', not v_stop, pg_catalog.pg_backend_pid(), pg_catalog.current_setting('application_name'),
          pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp());
  perform pg_catalog.pg_advisory_unlock_all();
  return 'ok';
end;
$actor$;

-- One-shot driver (observer O): holds the gates, discovers the actor
-- backends, then runs its script: release / handshake / await / verify /
-- privileges / observe. Evidence is kept in a variable and inserted at the end.
create function kapiloto_rehearsal.driver(p_run text, p_exp text) returns text
language plpgsql volatile set search_path = pg_catalog, public
as $driver$
declare
  v_ev jsonb := '[]'::jsonb;
  v_ops jsonb;
  v_op jsonb;
  v_actors text[];
  v_gates text[];
  v_pids jsonb := '{}'::jsonb;
  v_deadline timestamptz;
  v_t timestamptz;
  v_snap jsonb;
  v_ok boolean;
  v_polls int;
  v_rows jsonb;
  v_msg text;
  v_state text;
  v_failed text := null;
  v_label text;
  v_at text;
  g text;
begin
  if exists (select 1 from kapiloto_rehearsal.evidence e where e.run_tag = p_run and e.exp = p_exp) then
    return 'already ran';
  end if;
  perform pg_catalog.set_config('application_name', 'kapiloto-m2b-rehearsal:' || p_run || ':' || p_exp || '-O', false);
  select coalesce(jsonb_agg(to_jsonb(sc) order by sc.seq), '[]'::jsonb) into v_ops
  from kapiloto_rehearsal.script sc where sc.exp = p_exp and sc.actor = 'O';
  select array_agg(distinct sc.actor) into v_actors from kapiloto_rehearsal.script sc where sc.exp = p_exp and sc.actor <> 'O';
  select array_agg(distinct sc.arg->>'gate') into v_gates from kapiloto_rehearsal.script sc where sc.exp = p_exp and sc.op = 'gate';

  begin
    foreach g in array coalesce(v_gates, '{}'::text[]) loop
      perform pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended(kapiloto_rehearsal.k(p_run, p_exp, 'gate:' || g), 0));
    end loop;
    perform pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended(kapiloto_rehearsal.k(p_run, p_exp, 'ready'), 0));
    v_ev := v_ev || kapiloto_rehearsal.e('ready', 'driver holds every gate EXCLUSIVE, then READY', true, jsonb_build_object('gates', v_gates));

    v_deadline := pg_catalog.clock_timestamp() + interval '25 seconds';
    loop
      select coalesce(jsonb_object_agg(a.name, l.pid), '{}'::jsonb) into v_pids
      from unnest(v_actors) a(name)
      join pg_catalog.pg_locks l
        on l.locktype = 'advisory' and l.objsubid = 1 and l.granted
       and ((l.classid::bigint << 32) | l.objid::bigint) = pg_catalog.hashtextextended(kapiloto_rehearsal.k(p_run, p_exp, 'id:' || a.name), 0);
      exit when (select count(*) from jsonb_object_keys(v_pids)) = cardinality(v_actors);
      if pg_catalog.clock_timestamp() > v_deadline then
        raise exception 'actors_missing: only % of % actor backends observed', v_pids, v_actors;
      end if;
      perform pg_catalog.pg_sleep(0.02);
    end loop;
    v_pids := v_pids || jsonb_build_object('O', pg_catalog.pg_backend_pid());
    v_ev := v_ev || kapiloto_rehearsal.e('sessions', 'actor backends discovered through their identity locks', true, jsonb_build_object(
      'pids', v_pids,
      'activity', (select jsonb_agg(jsonb_build_object('pid', a.pid, 'application_name', a.application_name, 'backend_type', a.backend_type,
                     'backend_start', pg_catalog.to_char(a.backend_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by a.pid)
                   from pg_catalog.pg_stat_activity a where a.pid in (select (x.value)::int from jsonb_each_text(v_pids) x))));

    for v_op in select x from jsonb_array_elements(v_ops) x loop
      v_t := pg_catalog.clock_timestamp();
      v_label := coalesce(v_op->'arg'->>'label', v_op->>'op');
      case v_op->>'op'
        when 'release' then
          perform pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended(kapiloto_rehearsal.k(p_run, p_exp, 'gate:' || (v_op->'arg'->>'gate')), 0));
          v_ev := v_ev || kapiloto_rehearsal.e('release', 'release gate ' || (v_op->'arg'->>'gate'), true, null);
        when 'handshake' then
          v_polls := 0;
          loop
            v_polls := v_polls + 1;
            v_snap := kapiloto_rehearsal.snap(p_run, p_exp);
            execute 'select ' || (v_op->'arg'->>'pred') into v_ok using v_snap, v_pids;
            exit when v_ok;
            if pg_catalog.clock_timestamp() - v_t > interval '3 seconds' then
              v_ev := v_ev || kapiloto_rehearsal.e('handshake', 'TIMED OUT: ' || v_label, false, jsonb_build_object(
                'polls', v_polls, 'waited_ms', round(extract(epoch from pg_catalog.clock_timestamp() - v_t) * 1000), 'snapshot', v_snap));
              raise exception 'handshake_timeout: %', v_label;
            end if;
            perform pg_catalog.pg_sleep(0.02);
          end loop;
          v_ev := v_ev || kapiloto_rehearsal.e('handshake', v_label, true, jsonb_build_object(
            'polls', v_polls, 'waited_ms', round(extract(epoch from pg_catalog.clock_timestamp() - v_t) * 1000), 'snapshot', v_snap));
        when 'await' then
          loop
            select coalesce(jsonb_agg(to_jsonb(r) order by r.seq), '[]'::jsonb) into v_rows
            from kapiloto_rehearsal.result r where r.run_tag = p_run and r.exp = p_exp and r.actor = v_op->'arg'->>'actor';
            exit when jsonb_array_length(v_rows) > 0;
            if pg_catalog.clock_timestamp() - v_t > make_interval(secs => (v_op->'arg'->>'timeout_s')::double precision) then
              v_ev := v_ev || kapiloto_rehearsal.e('await', 'TIMED OUT: ' || (v_op->'arg'->>'actor'), false, null);
              raise exception 'await_timeout: %', v_op->'arg'->>'actor';
            end if;
            perform pg_catalog.pg_sleep(0.02);
          end loop;
          v_ev := v_ev || kapiloto_rehearsal.e('await', 'actor ' || (v_op->'arg'->>'actor') || ' committed', true, jsonb_build_object(
            'waited_ms', round(extract(epoch from pg_catalog.clock_timestamp() - v_t) * 1000)));
        when 'verify' then
          v_at := pg_catalog.to_char(pg_catalog.clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
          begin
            execute (select t.body from kapiloto_rehearsal.sqltext t where t.name = 'm2c_verify');
            v_ev := v_ev || kapiloto_rehearsal.e('verify', 'reviewed M2C verification, verbatim', true, jsonb_build_object('at', v_at, 'passed', true, 'message', 'no exception: M2C verification PASSED'));
          exception when others then
            get stacked diagnostics v_msg = message_text;
            v_ev := v_ev || kapiloto_rehearsal.e('verify', 'reviewed M2C verification, verbatim', true, jsonb_build_object('at', v_at, 'passed', false, 'message', v_msg));
          end;
        when 'privileges' then
          v_ev := v_ev || kapiloto_rehearsal.e('privileges', 'service_role EXECUTE on V2 / V1', true, jsonb_build_object(
            'v2', pg_catalog.has_function_privilege('service_role', (select t.body from kapiloto_rehearsal.sqltext t where t.name = 'sig:v2'), 'execute'),
            'v1', pg_catalog.has_function_privilege('service_role', (select t.body from kapiloto_rehearsal.sqltext t where t.name = 'sig:v1'), 'execute')));
        when 'observe' then
          v_ev := v_ev || kapiloto_rehearsal.e('observe', v_op->'arg'->>'name', true, kapiloto_rehearsal.observe(p_run, p_exp, v_op->'arg'->>'name'));
        else
          raise exception 'unknown driver op %', v_op->>'op';
      end case;
    end loop;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    v_failed := v_msg;
    v_ev := v_ev || kapiloto_rehearsal.e('error', v_msg, false, jsonb_build_object('sqlstate', v_state));
  end;

  perform pg_catalog.pg_advisory_unlock_all();
  insert into kapiloto_rehearsal.evidence (run_tag, exp, seq, kind, label, ok, data, at, pid)
  select p_run, p_exp, x.n::int, x.v->>'kind', x.v->>'label', (x.v->>'ok')::boolean, x.v->'data', x.v->>'at', (x.v->>'pid')::int
  from jsonb_array_elements(v_ev) with ordinality as x(v, n);
  insert into kapiloto_rehearsal.evidence (run_tag, exp, seq, kind, label, ok, at, pid)
  values (p_run, p_exp, 9999, 'done', coalesce(v_failed, 'ok'), v_failed is null,
          pg_catalog.to_char(pg_catalog.clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), pg_catalog.pg_backend_pid());
  return coalesce(v_failed, 'ok');
end;
$driver$;

revoke all on all functions in schema kapiloto_rehearsal from public;
revoke all on all tables in schema kapiloto_rehearsal from public;

-- Self-check: plpgsql EXECUTE runs a multi-statement string (the M2C body has two REVOKEs).
do $selfcheck$
begin
  execute 'select 1; select 2';
end;
$selfcheck$;
