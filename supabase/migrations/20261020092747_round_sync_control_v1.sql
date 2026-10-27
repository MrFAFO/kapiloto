create table if not exists public.round_sync_control (
  id smallint primary key default 1 check (id = 1),
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text,
  last_detail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.round_sync_control enable row level security;

insert into public.round_sync_control (id)
values (1)
on conflict (id) do nothing;
