create extension if not exists pgcrypto;
create table if not exists public.users (
 id uuid primary key default gen_random_uuid(),
 username varchar(24) unique not null,
 password_hash text not null,
 membership text not null default 'free' check (membership in ('free','unlimited')),
 is_admin boolean not null default false,
 created_at timestamptz not null default now(),
 activated_at timestamptz
);
create table if not exists public.usage (
 id uuid primary key default gen_random_uuid(),
 quota_key text not null,
 username varchar(24),
 filename text,
 created_at timestamptz not null default now()
);
create index if not exists usage_quota_date_idx on public.usage(quota_key,created_at);
alter table public.users enable row level security;
alter table public.usage enable row level security;
-- Server uses the Supabase service-role key. Never expose it in frontend code.
-- Bootstrap admin securely after registering: update public.users set is_admin=true where username='YOUR_USERNAME';
