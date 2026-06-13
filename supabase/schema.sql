-- Simplí Solutions Pipeline Portal — Supabase schema
-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New query)

create extension if not exists pgcrypto;

create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  plan text not null default 'Growth',
  created_at timestamptz not null default now()
);

create table deals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  opportunity text not null,
  company text not null,
  stage text not null check (stage in ('Awaiting PO','Verbal Confirmed','Negotiation','Survey','Quote')),
  value numeric not null default 0,
  win_prob numeric not null default 0,
  weighted numeric generated always as (value * win_prob / 100.0) stored,
  owner text,
  stage_changed_at timestamptz not null default now(),
  source text,
  next_action date,
  close_month date,
  notes text,
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  deal_id uuid references deals(id) on delete set null,
  title text not null,
  owner text,
  due_date date,
  priority text not null default 'Normal' check (priority in ('Critical','High','Normal')),
  status text not null default 'open' check (status in ('open','done')),
  created_at timestamptz not null default now()
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  author text not null,
  type text not null default 'Note' check (type in ('Call','Email','Note','Alert')),
  body text not null,
  created_at timestamptz not null default now()
);

create index on deals (client_id);
create index on deals (client_id, stage);
create index on tasks (client_id);
create index on comments (client_id, deal_id);

-- Row Level Security: every row is scoped to the caller's client_id,
-- which arrives as a custom claim on the Auth0 ID token (see Auth0 Action
-- in the project README / setup plan).
alter table clients enable row level security;
alter table deals enable row level security;
alter table tasks enable row level security;
alter table comments enable row level security;

create policy "own client row" on clients
  for select using (id = (auth.jwt()->>'client_id')::uuid);

create policy "tenant read deals" on deals for select
  using (client_id = (auth.jwt()->>'client_id')::uuid);
create policy "tenant insert deals" on deals for insert
  with check (client_id = (auth.jwt()->>'client_id')::uuid);
create policy "tenant update deals" on deals for update
  using (client_id = (auth.jwt()->>'client_id')::uuid)
  with check (client_id = (auth.jwt()->>'client_id')::uuid);

create policy "tenant read tasks" on tasks for select
  using (client_id = (auth.jwt()->>'client_id')::uuid);
create policy "tenant insert tasks" on tasks for insert
  with check (client_id = (auth.jwt()->>'client_id')::uuid);
create policy "tenant update tasks" on tasks for update
  using (client_id = (auth.jwt()->>'client_id')::uuid)
  with check (client_id = (auth.jwt()->>'client_id')::uuid);

create policy "tenant read comments" on comments for select
  using (client_id = (auth.jwt()->>'client_id')::uuid);
create policy "tenant insert comments" on comments for insert
  with check (client_id = (auth.jwt()->>'client_id')::uuid);

-- After running this, insert your first client and note its id, e.g.:
-- insert into clients (name, email, plan) values ('Vision Radio Fire Ltd','you@example.com','Growth') returning id;
