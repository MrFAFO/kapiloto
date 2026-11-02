-- Kapiloto V4 M2C pre-reviewed emergency pause body.
--
-- IMPORTANT:
-- - This file is NOT a Supabase migration and must stay outside supabase/migrations.
-- - Do not apply it during normal deployment.
-- - If M2C is needed, execute this statement immediately as an operator, then
--   create a new timestamped migration containing this exact body and commit it
--   after the production revoke has succeeded.
-- - M2C changes no identity or Match Ledger data.

revoke execute on function public.match_ledger_ingest_provider_fixture_v2(jsonb)
  from service_role;
