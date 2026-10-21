insert into public.team_aliases (
  team_id, alias, source, language_code, is_preferred
)
values
  ('3d7484fa-4442-4cde-9576-6c7981b6dfeb','עירוני קרית שמונה','365scores','he',false),
  ('21c0daeb-9fdb-4152-9592-1ded8d71f2cb','מכבי פתח תקוה','365scores','he',false),
  ('b08fed73-5dec-48d4-a78d-492941015068','האל סיטי','365scores','he',false),
  ('873939e0-cf0b-4151-9526-d754629fc7f5','ניוקאסל יונייטד','365scores','he',false),
  ('72bfd482-213d-4b7f-8939-544eb4329682','לידס יונייטד','365scores','he',false)
on conflict (team_id, normalized_alias) do nothing;
