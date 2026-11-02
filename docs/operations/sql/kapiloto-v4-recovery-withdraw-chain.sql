-- Kapiloto V4 recovery template: withdraw one Sportmonks fixture chain
-- (runbook §D). Not a migration; never place it under supabase/migrations.
--
-- Parameters, set in the SAME execution immediately before this block (the
-- SQL editor runs one execution as one transaction):
--   select set_config('kapiloto_recovery.incident_ref', '<incident id>', true),
--          set_config('kapiloto_recovery.fixture_id', '<canonical fixture uuid of the bad chain>', true),
--          set_config('kapiloto_recovery.provider_fixture_id', '<sportmonks fixture id>', true),
--          set_config('kapiloto_recovery.observation_id', '<latest observation id from the impact report>', true),
--          set_config('kapiloto_recovery.trust', 'untrusted', true),
--          set_config('kapiloto_recovery.reason', '<specific withdrawal reason>', true);
-- trust = 'untrusted' (identity incident: the attestation was revoked first)
-- or 'trusted' (a provider-data withdrawal with no identity revoke).
--
-- Appends a Foundation 1A withdrawal version through
-- public.match_ledger_record_observation and deletes nothing. Under the 1A
-- provider-fixture and fixture/provider locks it asserts that the chain still
-- ends in exactly the observation the operator reviewed (compare-and-set) and
-- has the expected trust state. Idempotent: an already withdrawn chain is
-- reported and left unchanged.

do $recovery_withdraw$
declare
  v_incident text := nullif(btrim(current_setting('kapiloto_recovery.incident_ref', true)), '');
  v_fixture uuid := nullif(btrim(current_setting('kapiloto_recovery.fixture_id', true)), '')::uuid;
  v_pfid text := nullif(btrim(current_setting('kapiloto_recovery.provider_fixture_id', true)), '');
  v_expected uuid := nullif(btrim(current_setting('kapiloto_recovery.observation_id', true)), '')::uuid;
  v_trust text := nullif(btrim(current_setting('kapiloto_recovery.trust', true)), '');
  v_reason text := nullif(btrim(current_setting('kapiloto_recovery.reason', true)), '');
  v_latest public.match_ledger_observations%rowtype;
  v_issue text;
  v_result jsonb;
begin
  if v_incident is null or v_fixture is null or v_pfid is null or v_expected is null or v_reason is null
    or v_trust is null or v_trust not in ('untrusted', 'trusted') then
    raise exception 'set kapiloto_recovery.incident_ref, fixture_id, provider_fixture_id, observation_id, trust (untrusted or trusted) and reason';
  end if;

  perform private.lock_match_ledger_fixture('sportmonks', v_pfid, v_fixture);

  select o.* into v_latest
  from public.match_ledger_observations o
  where o.fixture_id = v_fixture and o.provider = 'sportmonks'
  order by o.observation_version desc
  limit 1;
  if not found then
    raise exception 'fixture % has no sportmonks chain', v_fixture;
  end if;
  if v_latest.provider_fixture_id <> v_pfid then
    raise exception 'the sportmonks chain of fixture % carries provider fixture %, not %', v_fixture, v_latest.provider_fixture_id, v_pfid;
  end if;
  if v_latest.observation_kind = 'withdrawal' then
    raise notice 'already withdrawn: fixture % sportmonks fixture % ends in withdrawal version %; nothing changed',
      v_fixture, v_pfid, v_latest.observation_version;
    return;
  end if;
  if v_latest.id <> v_expected then
    raise exception 'chain changed since review: latest version of fixture % is observation % (version %), expected %',
      v_fixture, v_latest.id, v_latest.observation_version, v_expected;
  end if;

  v_issue := private.match_ledger_observation_attestation_issue(v_latest.id);
  if v_trust = 'untrusted' and v_issue is null then
    raise exception 'observation % is still trusted: revoke the incorrect attestation first (runbook §C), or set trust = trusted for a provider-data withdrawal', v_latest.id;
  end if;
  if v_trust = 'trusted' and v_issue is not null then
    raise exception 'observation % is untrusted (%), not trusted as declared', v_latest.id, v_issue;
  end if;

  v_result := public.match_ledger_record_observation(jsonb_build_object(
    'contract_version', 'kapiloto-match-ledger-observation-v1',
    'observation_kind', 'withdrawal',
    'fixture_id', v_fixture,
    'provider', 'sportmonks',
    'provider_fixture_id', v_pfid,
    'capture_mode', 'manual_import',
    'ingest_version', 'kapiloto-v4-recovery-runbook-v1',
    'retrieved_at', private.kapiloto_information_clock(),
    'withdrawal_reason', left(v_incident || ': ' || v_reason, 300)
  ));
  if v_result->>'status' is distinct from 'recorded' then
    raise exception 'withdrawal of fixture % was not recorded: %', v_fixture, v_result;
  end if;
  raise notice 'withdrawn: fixture % sportmonks fixture % (previous trust issue %): %', v_fixture, v_pfid, v_issue, v_result;
end;
$recovery_withdraw$;
