with desired(canonical_name, alias) as (
  values
    ('הפועל פתח תקווה', 'הפועל פתח תקוה'),
    ('בני יהודה', 'בני יהודה ת''א'),
    ('מכבי יפו', 'מכבי קביליו יפו'),
    ('ראיו ואייקאנו', 'ראיו')
)
insert into public.team_aliases (
  team_id,
  alias,
  source,
  language_code,
  is_preferred
)
select
  t.id,
  d.alias,
  '365scores',
  'he',
  false
from desired d
join public.teams t
  on t.canonical_name = d.canonical_name
on conflict (team_id, normalized_alias) do nothing;

do $$
declare
  missing_aliases text;
begin
  select string_agg(d.canonical_name || ' -> ' || d.alias, ', ')
  into missing_aliases
  from (
    values
      ('הפועל פתח תקווה', 'הפועל פתח תקוה'),
      ('בני יהודה', 'בני יהודה ת''א'),
      ('מכבי יפו', 'מכבי קביליו יפו'),
      ('ראיו ואייקאנו', 'ראיו')
  ) as d(canonical_name, alias)
  where not exists (
    select 1
    from public.teams t
    join public.team_aliases a
      on a.team_id = t.id
    where t.canonical_name = d.canonical_name
      and a.alias = d.alias
  );

  if missing_aliases is not null then
    raise exception 'Missing expected 365Scores aliases after migration: %', missing_aliases;
  end if;
end
$$;
