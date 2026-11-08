/**
 * The research-worker command as the D-064 target guard (PR #59, merged;
 * migration 20261108100000_kapiloto_scheduler_target_guard_v1.sql) rewrites
 * it: concurrency_guard_v1 with its URL read from the Vault secret
 * kapiloto_research_worker_target_url. Once D-064 is applied, D-065's rewrite
 * installs exactly this command.
 *
 * A pinned verbatim copy, kept on purpose now that PR #59 is merged: the D-065
 * tests require this text, the migration's second $cron$ body, the reconcile
 * template's routed command and the check's vault_target hash to agree, so an
 * edit to any one of them fails.
 */
export const D064_ROUTED_WORKER_COMMAND = `
    with scheduler_state as (
      select
        exists (
          select 1
          from public.kapiloto_research_runs r
          where r.status in ('queued', 'running')
        ) as has_active_run,
        exists (
          select 1
          from public.kapiloto_research_attempts a
          join public.kapiloto_research_runs r on r.id = a.run_id
          where a.status = 'queued'
            and a.available_at <= now()
            and r.status in ('queued', 'running')
        ) as has_available_queue,
        exists (
          select 1
          from public.kapiloto_research_attempts a
          join public.kapiloto_research_runs r on r.id = a.run_id
          where a.status = 'running'
            and a.lease_expires_at < now()
            and r.status in ('queued', 'running')
        ) as has_expired_running,
        exists (
          select 1
          from public.kapiloto_research_attempts a
          join public.kapiloto_research_runs r on r.id = a.run_id
          where a.status in ('queued', 'running')
            and r.status in ('queued', 'running')
        ) as has_nonterminal_attempt,
        (
          select count(*)::integer
          from public.kapiloto_research_attempts a
          join public.kapiloto_research_runs r on r.id = a.run_id
          where a.status = 'running'
            and a.lease_expires_at > now()
            and r.status in ('queued', 'running')
        ) as live_running
    ),
    capacity as (
      select case
        when not has_active_run then 0
        when has_available_queue or has_expired_running
          then greatest(0, 2 - live_running)
        when not has_nonterminal_attempt and live_running = 0
          then 1
        else 0
      end as slots
      from scheduler_state
    ),
    target as (
      select s.decrypted_secret as url
      from vault.decrypted_secrets s
      where s.name = 'kapiloto_research_worker_target_url'
        and s.decrypted_secret ~ '^https://[^[:space:]]+$'
      limit 1
    )
    select net.http_post(
      url := t.url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization',
        'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'kapiloto_research_worker_secret'
          limit 1
        )
      ),
      body := jsonb_build_object(
        'finalizeRuns',
        worker_slot.slot_no = 1
      ),
      timeout_milliseconds := 30000
    )
    from capacity c
    cross join target t
    cross join lateral generate_series(1, c.slots) as worker_slot(slot_no)
    where c.slots > 0;
  `;
