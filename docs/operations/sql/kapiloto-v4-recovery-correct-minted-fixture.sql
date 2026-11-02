-- Kapiloto V4 recovery template: correct the identity of a fixture that V2
-- ingest MINTED under a wrong team/competition identity (runbook §E1).
-- Not a migration; never place it under supabase/migrations.
--
-- Parameters, set in the SAME execution immediately before this block:
--   select set_config('kapiloto_recovery.provider_fixture_id', '<sportmonks fixture id>', true),
--          set_config('kapiloto_recovery.fixture_id', '<minted canonical fixture uuid>', true),
--          set_config('kapiloto_recovery.expected_competition_id', '<its current competition uuid>', true),
--          set_config('kapiloto_recovery.expected_home_team_id', '<its current home team uuid>', true),
--          set_config('kapiloto_recovery.expected_away_team_id', '<its current away team uuid>', true),
--          set_config('kapiloto_recovery.competition_id', '<reviewed competition uuid>', true),
--          set_config('kapiloto_recovery.home_team_id', '<reviewed home team uuid>', true),
--          set_config('kapiloto_recovery.away_team_id', '<reviewed away team uuid>', true);
--
-- Why in place: the mint is the only canonical row for the real match, and
-- one mint per provider fixture id is final (A2-A), so the corrected chain
-- must land on this row. A second, parallel canonical fixture would leave the
-- wrong row behind as a phantom finished match and, for a competition
-- correction, would block the re-ingest forever (fixture_competition_conflict).
--
-- Changes only competition_id/home_team_id/away_team_id of one fixture row;
-- kickoff, status and the provider-side scores stay as minted. The provider
-- fixture mapping, the mint row and every ledger row stay untouched. Takes the
-- V2 ingest lock order (provider-fixture advisory lock, then the team-pair
-- advisory locks in sorted order, then the fixture row) and refuses unless:
-- the row still has the reviewed old identity (compare-and-set); it was minted
-- by this provider fixture id; nothing but this provider fixture's mapping,
-- its same-provider-fixture immutable ingest audit, and the V4 ledger
-- references it; every ledger chain on it is withdrawn; and no
-- other canonical fixture already represents the corrected match. Idempotent:
-- a row that already has the corrected identity is reported and left unchanged.

do $recovery_fixture$
declare
  v_pfid text := nullif(btrim(current_setting('kapiloto_recovery.provider_fixture_id', true)), '');
  v_fixture uuid := nullif(btrim(current_setting('kapiloto_recovery.fixture_id', true)), '')::uuid;
  v_old_competition uuid := nullif(btrim(current_setting('kapiloto_recovery.expected_competition_id', true)), '')::uuid;
  v_old_home uuid := nullif(btrim(current_setting('kapiloto_recovery.expected_home_team_id', true)), '')::uuid;
  v_old_away uuid := nullif(btrim(current_setting('kapiloto_recovery.expected_away_team_id', true)), '')::uuid;
  v_competition uuid := nullif(btrim(current_setting('kapiloto_recovery.competition_id', true)), '')::uuid;
  v_home uuid := nullif(btrim(current_setting('kapiloto_recovery.home_team_id', true)), '')::uuid;
  v_away uuid := nullif(btrim(current_setting('kapiloto_recovery.away_team_id', true)), '')::uuid;
  v_row public.fixtures%rowtype;
  v_mapped uuid;
  v_key text;
  v_n integer;
  r record;
begin
  if v_pfid is null or v_fixture is null or v_old_competition is null or v_old_home is null or v_old_away is null
    or v_competition is null or v_home is null or v_away is null then
    raise exception 'set kapiloto_recovery.provider_fixture_id, fixture_id, expected_competition_id, expected_home_team_id, expected_away_team_id, competition_id, home_team_id and away_team_id';
  end if;
  if v_home = v_away then
    raise exception 'the corrected home and away teams must differ';
  end if;
  perform private.kapiloto_require_read_committed('recovery fixture correction');

  perform pg_advisory_xact_lock(hashtextextended('kapiloto_match_ledger_provider_fixture:sportmonks:' || v_pfid, 0));
  for v_key in
    select d.k
    from (
      select distinct k
      from unnest(array[
        'kapiloto_canonical_fixture_pair:' || least(v_old_home, v_old_away)::text || ':' || greatest(v_old_home, v_old_away)::text,
        'kapiloto_canonical_fixture_pair:' || least(v_home, v_away)::text || ':' || greatest(v_home, v_away)::text
      ]) k
    ) d
    order by d.k collate "C"
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
  end loop;

  select f.* into v_row from public.fixtures f where f.id = v_fixture for update;
  if not found then
    raise exception 'fixture % not found', v_fixture;
  end if;
  if v_row.competition_id is not distinct from v_competition and v_row.home_team_id = v_home and v_row.away_team_id = v_away then
    raise notice 'fixture % already carries the corrected identity; nothing changed', v_fixture;
    return;
  end if;
  if v_row.competition_id is distinct from v_old_competition or v_row.home_team_id <> v_old_home or v_row.away_team_id <> v_old_away then
    raise exception 'fixture % changed since review: competition %, home %, away %', v_fixture, v_row.competition_id, v_row.home_team_id, v_row.away_team_id;
  end if;

  if not exists (
    select 1 from public.match_ledger_fixture_mints mi
    where mi.fixture_id = v_fixture and mi.provider = 'sportmonks' and mi.provider_fixture_id = v_pfid
  ) then
    raise exception 'fixture % was not minted by sportmonks fixture %; only a V4-minted fixture is corrected in place', v_fixture, v_pfid;
  end if;
  if exists (
    select 1 from public.provider_fixture_mappings m
    where m.fixture_id = v_fixture and not (m.provider = 'sportmonks' and m.provider_fixture_id = v_pfid)
  ) then
    raise exception 'fixture % carries another provider fixture mapping, so it is not private to the V4 ledger', v_fixture;
  end if;
  if exists (
    select 1
    from public.provider_ingest_items i
    where i.fixture_id = v_fixture
      and (
        i.provider <> 'sportmonks'
        or i.provider_fixture_id <> v_pfid
        or (
          i.observation_id is not null
          and not exists (
            select 1
            from public.match_ledger_observations o
            where o.id = i.observation_id
              and o.fixture_id = v_fixture
              and o.provider = 'sportmonks'
              and o.provider_fixture_id = v_pfid
          )
        )
      )
  ) then
    raise exception 'fixture % has an ingest audit reference outside sportmonks fixture %; it is not private to this recovery chain',
      v_fixture, v_pfid;
  end if;
  select m.fixture_id into v_mapped
  from public.provider_fixture_mappings m
  where m.provider = 'sportmonks' and m.provider_fixture_id = v_pfid
  for update;
  if v_mapped is not null and v_mapped <> v_fixture then
    raise exception 'sportmonks fixture % is mapped to fixture %, not %', v_pfid, v_mapped, v_fixture;
  end if;

  if exists (
    select 1
    from (
      select distinct on (o.provider) o.observation_kind
      from public.match_ledger_observations o
      where o.fixture_id = v_fixture
      order by o.provider, o.observation_version desc
    ) l
    where l.observation_kind <> 'withdrawal'
  ) then
    raise exception 'fixture % still has a live ledger chain; withdraw every chain on it first (runbook §D)', v_fixture;
  end if;

  if exists (
    select 1 from pg_catalog.pg_constraint c
    where c.contype = 'f' and c.confrelid = 'public.fixtures'::regclass and cardinality(c.conkey) <> 1
  ) then
    raise exception 'a multi-column foreign key references public.fixtures; this template must be reviewed again';
  end if;
  for r in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.fixtures'::regclass
      and c.conrelid not in (
        'public.match_ledger_observations'::regclass,
        'public.match_ledger_team_records'::regclass,
        'public.match_ledger_fixture_mints'::regclass,
        'public.provider_fixture_mappings'::regclass)
    order by 1, 2
  loop
    execute format('select count(*)::int from %s where %I = $1', r.tbl, r.col) into v_n using v_fixture;
    if v_n > 0 then
      raise exception 'fixture % is referenced by %.% (% rows), so it is not private to the V4 ledger', v_fixture, r.tbl, r.col, v_n;
    end if;
  end loop;

  select count(*)::int into v_n
  from private.provider_ingest_fixture_candidates_v2('sportmonks', v_pfid, v_home, v_away, v_competition, v_row.kickoff_at) c
  where c.fixture_id <> v_fixture and c.guard is not null;
  if v_n > 0 then
    raise exception '% other canonical fixture(s) already represent the corrected match; do not create a duplicate (runbook §E3)', v_n;
  end if;

  update public.fixtures
  set competition_id = v_competition, home_team_id = v_home, away_team_id = v_away, updated_at = now()
  where id = v_fixture;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'expected to correct exactly one fixture row, corrected %', v_n;
  end if;
  raise notice 'fixture % corrected in place: competition % -> %, home % -> %, away % -> %',
    v_fixture, v_old_competition, v_competition, v_old_home, v_home, v_old_away, v_away;
end;
$recovery_fixture$;
