-- Atomic idempotent import for one Winner 16 / Toto round snapshot.
-- Importers must supply an explicit lock time from their source; the database
-- never derives it from the first football kickoff.

create or replace function public.toto_import_round_snapshot(
  p_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round_id uuid;
  v_source text;
  v_external_round_number text;
  v_source_version text;
  v_status text;
  v_starts_at timestamptz;
  v_lock_at timestamptz;
  v_games jsonb;
  v_game jsonb;
  v_home jsonb;
  v_away jsonb;
  v_competition jsonb;
  v_home_id uuid;
  v_away_id uuid;
  v_competition_id uuid;
  v_fixture_id uuid;
  v_round_game_id uuid;
  v_existing_status text;
  v_game_count integer;
  v_distinct_numbers integer;
  v_imported integer := 0;
  v_created_teams integer := 0;
  v_created_competitions integer := 0;
  v_created_fixtures integer := 0;
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'round_snapshot_invalid';
  end if;

  v_source := nullif(trim(p_snapshot ->> 'source'), '');
  v_external_round_number := nullif(trim(p_snapshot ->> 'external_round_number'), '');
  v_source_version := nullif(trim(p_snapshot ->> 'source_version'), '');
  v_status := coalesce(nullif(trim(p_snapshot ->> 'status'), ''), 'upcoming');
  v_games := p_snapshot -> 'games';

  if v_source is null
     or v_external_round_number is null
     or v_source_version is null then
    raise exception 'round_snapshot_identity_required';
  end if;

  begin
    v_starts_at := (p_snapshot ->> 'starts_at')::timestamptz;
    v_lock_at := (p_snapshot ->> 'lock_at')::timestamptz;
  exception when others then
    raise exception 'round_snapshot_invalid_time';
  end;

  if v_starts_at is null or v_lock_at is null then
    raise exception 'round_snapshot_explicit_times_required';
  end if;

  if v_status not in (
    'upcoming', 'open', 'locked', 'live', 'finished', 'settled', 'under_review'
  ) then
    raise exception 'round_snapshot_invalid_status';
  end if;

  if jsonb_typeof(v_games) is distinct from 'array' then
    raise exception 'round_snapshot_games_required';
  end if;

  select count(*), count(distinct (item ->> 'game_number')::integer)
    into v_game_count, v_distinct_numbers
  from jsonb_array_elements(v_games) item;

  if v_game_count <> 16 or v_distinct_numbers <> 16 then
    raise exception 'round_snapshot_requires_16_unique_games';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_games) item
    where
      nullif(item ->> 'game_number', '') is null
      or (item ->> 'game_number')::integer not between 1 and 16
  ) then
    raise exception 'round_snapshot_game_numbers_invalid';
  end if;

  if (
    select min((item ->> 'game_number')::integer)
    from jsonb_array_elements(v_games) item
  ) <> 1
  or (
    select max((item ->> 'game_number')::integer)
    from jsonb_array_elements(v_games) item
  ) <> 16 then
    raise exception 'round_snapshot_game_numbers_invalid';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_source || ':' || v_external_round_number, 0)
  );

  select r.id, r.status
    into v_round_id, v_existing_status
  from public.rounds r
  where r.source = v_source
    and r.external_round_number = v_external_round_number
  for update;

  if v_round_id is not null and v_existing_status = 'settled' then
    raise exception 'round_snapshot_settled_immutable';
  end if;

  if v_round_id is null then
    insert into public.rounds (
      external_round_number,
      starts_at,
      lock_at,
      status,
      source,
      source_version,
      created_at,
      updated_at
    )
    values (
      v_external_round_number,
      v_starts_at,
      v_lock_at,
      v_status,
      v_source,
      v_source_version,
      now(),
      now()
    )
    returning id into v_round_id;
  else
    update public.rounds
    set starts_at = v_starts_at,
        lock_at = v_lock_at,
        status = v_status,
        source_version = v_source_version,
        updated_at = now()
    where id = v_round_id;
  end if;

  for v_game in
    select value
    from jsonb_array_elements(v_games)
    order by (value ->> 'game_number')::integer
  loop
    v_home := v_game -> 'home';
    v_away := v_game -> 'away';
    v_competition := v_game -> 'competition';

    if jsonb_typeof(v_home) is distinct from 'object'
       or jsonb_typeof(v_away) is distinct from 'object'
       or jsonb_typeof(v_competition) is distinct from 'object' then
      raise exception 'round_snapshot_game_identity_required';
    end if;

    if nullif(trim(v_home ->> 'canonical_name'), '') is null
       or nullif(trim(v_away ->> 'canonical_name'), '') is null
       or nullif(trim(v_competition ->> 'canonical_name'), '') is null then
      raise exception 'round_snapshot_game_identity_required';
    end if;

    if lower(trim(v_home ->> 'canonical_name')) =
       lower(trim(v_away ->> 'canonical_name')) then
      raise exception 'round_snapshot_same_team';
    end if;

    select t.id into v_home_id
    from public.teams t
    where lower(trim(t.canonical_name)) = lower(trim(v_home ->> 'canonical_name'))
      and coalesce(t.country_code, '') = coalesce(nullif(upper(trim(v_home ->> 'country_code')), ''), '')
    order by t.created_at asc
    limit 1;

    if v_home_id is null then
      insert into public.teams (canonical_name, country_code)
      values (
        trim(v_home ->> 'canonical_name'),
        nullif(upper(trim(v_home ->> 'country_code')), '')
      )
      returning id into v_home_id;
      v_created_teams := v_created_teams + 1;
    end if;

    select t.id into v_away_id
    from public.teams t
    where lower(trim(t.canonical_name)) = lower(trim(v_away ->> 'canonical_name'))
      and coalesce(t.country_code, '') = coalesce(nullif(upper(trim(v_away ->> 'country_code')), ''), '')
    order by t.created_at asc
    limit 1;

    if v_away_id is null then
      insert into public.teams (canonical_name, country_code)
      values (
        trim(v_away ->> 'canonical_name'),
        nullif(upper(trim(v_away ->> 'country_code')), '')
      )
      returning id into v_away_id;
      v_created_teams := v_created_teams + 1;
    end if;

    insert into public.team_aliases (
      team_id, alias, language_code, source, is_preferred
    )
    select
      v_home_id,
      trim(alias.value),
      nullif(trim(v_home ->> 'language_code'), ''),
      v_source,
      false
    from jsonb_array_elements_text(coalesce(v_home -> 'aliases', '[]'::jsonb)) alias(value)
    where trim(alias.value) <> ''
    on conflict (team_id, normalized_alias) do nothing;

    insert into public.team_aliases (
      team_id, alias, language_code, source, is_preferred
    )
    select
      v_away_id,
      trim(alias.value),
      nullif(trim(v_away ->> 'language_code'), ''),
      v_source,
      false
    from jsonb_array_elements_text(coalesce(v_away -> 'aliases', '[]'::jsonb)) alias(value)
    where trim(alias.value) <> ''
    on conflict (team_id, normalized_alias) do nothing;

    select c.id into v_competition_id
    from public.competitions c
    where lower(trim(c.canonical_name)) =
          lower(trim(v_competition ->> 'canonical_name'))
      and coalesce(c.country_code, '') =
          coalesce(nullif(upper(trim(v_competition ->> 'country_code')), ''), '')
    order by c.created_at asc
    limit 1;

    if v_competition_id is null then
      insert into public.competitions (
        canonical_name, country_code, competition_type
      )
      values (
        trim(v_competition ->> 'canonical_name'),
        nullif(upper(trim(v_competition ->> 'country_code')), ''),
        nullif(trim(v_competition ->> 'competition_type'), '')
      )
      returning id into v_competition_id;
      v_created_competitions := v_created_competitions + 1;
    end if;

    begin
      perform (v_game ->> 'kickoff_at')::timestamptz;
    exception when others then
      raise exception 'round_snapshot_invalid_kickoff';
    end;

    select f.id into v_fixture_id
    from public.fixtures f
    where f.home_team_id = v_home_id
      and f.away_team_id = v_away_id
      and f.kickoff_at = (v_game ->> 'kickoff_at')::timestamptz
      and f.competition_id is not distinct from v_competition_id
    order by f.created_at asc
    limit 1;

    if v_fixture_id is null then
      insert into public.fixtures (
        competition_id,
        home_team_id,
        away_team_id,
        season_key,
        stage_name,
        round_name,
        leg_number,
        neutral_venue,
        kickoff_at,
        status,
        created_at,
        updated_at
      )
      values (
        v_competition_id,
        v_home_id,
        v_away_id,
        nullif(trim(v_game ->> 'season_key'), ''),
        nullif(trim(v_game ->> 'stage_name'), ''),
        nullif(trim(v_game ->> 'round_name'), ''),
        nullif(v_game ->> 'leg_number', '')::smallint,
        coalesce((v_game ->> 'neutral_venue')::boolean, false),
        (v_game ->> 'kickoff_at')::timestamptz,
        coalesce(nullif(trim(v_game ->> 'fixture_status'), ''), 'upcoming'),
        now(),
        now()
      )
      returning id into v_fixture_id;
      v_created_fixtures := v_created_fixtures + 1;
    else
      update public.fixtures
      set competition_id = v_competition_id,
          season_key = nullif(trim(v_game ->> 'season_key'), ''),
          stage_name = nullif(trim(v_game ->> 'stage_name'), ''),
          round_name = nullif(trim(v_game ->> 'round_name'), ''),
          leg_number = nullif(v_game ->> 'leg_number', '')::smallint,
          neutral_venue = coalesce((v_game ->> 'neutral_venue')::boolean, false),
          status = coalesce(nullif(trim(v_game ->> 'fixture_status'), ''), status),
          updated_at = now()
      where id = v_fixture_id;
    end if;

    select g.id into v_round_game_id
    from public.round_games g
    where g.round_id = v_round_id
      and g.game_number = (v_game ->> 'game_number')::smallint
    for update;

    if v_round_game_id is null then
      insert into public.round_games (
        round_id,
        fixture_id,
        game_number,
        home_team_id,
        away_team_id,
        competition_id,
        competition_name_snapshot,
        competition_stage_snapshot,
        leg_number,
        aggregate_home_score,
        aggregate_away_score,
        neutral_venue,
        kickoff_at,
        status,
        settlement_status,
        settlement_rule,
        created_at
      )
      values (
        v_round_id,
        v_fixture_id,
        (v_game ->> 'game_number')::smallint,
        v_home_id,
        v_away_id,
        v_competition_id,
        trim(v_competition ->> 'canonical_name'),
        nullif(trim(v_game ->> 'stage_name'), ''),
        nullif(v_game ->> 'leg_number', '')::smallint,
        nullif(v_game ->> 'aggregate_home_score', '')::smallint,
        nullif(v_game ->> 'aggregate_away_score', '')::smallint,
        coalesce((v_game ->> 'neutral_venue')::boolean, false),
        (v_game ->> 'kickoff_at')::timestamptz,
        coalesce(nullif(trim(v_game ->> 'fixture_status'), ''), 'upcoming'),
        'pending',
        coalesce(
          nullif(trim(v_game ->> 'settlement_rule'), ''),
          'result_after_90_minutes_including_stoppage_time'
        ),
        now()
      );
    else
      update public.round_games
      set fixture_id = v_fixture_id,
          home_team_id = v_home_id,
          away_team_id = v_away_id,
          competition_id = v_competition_id,
          competition_name_snapshot = trim(v_competition ->> 'canonical_name'),
          competition_stage_snapshot = nullif(trim(v_game ->> 'stage_name'), ''),
          leg_number = nullif(v_game ->> 'leg_number', '')::smallint,
          aggregate_home_score = nullif(v_game ->> 'aggregate_home_score', '')::smallint,
          aggregate_away_score = nullif(v_game ->> 'aggregate_away_score', '')::smallint,
          neutral_venue = coalesce((v_game ->> 'neutral_venue')::boolean, false),
          kickoff_at = (v_game ->> 'kickoff_at')::timestamptz,
          status = coalesce(nullif(trim(v_game ->> 'fixture_status'), ''), status),
          settlement_rule = coalesce(
            nullif(trim(v_game ->> 'settlement_rule'), ''),
            settlement_rule,
            'result_after_90_minutes_including_stoppage_time'
          )
      where id = v_round_game_id;
    end if;

    v_imported := v_imported + 1;
  end loop;

  return jsonb_build_object(
    'round_id', v_round_id,
    'external_round_number', v_external_round_number,
    'source', v_source,
    'source_version', v_source_version,
    'games_imported', v_imported,
    'created_teams', v_created_teams,
    'created_competitions', v_created_competitions,
    'created_fixtures', v_created_fixtures
  );
end;
$$;

revoke all on function public.toto_import_round_snapshot(jsonb)
from public, anon, authenticated;

grant execute on function public.toto_import_round_snapshot(jsonb)
to service_role;
