-- Imita lo mínimo de Supabase (roles, esquema auth, auth.uid()) para probar migraciones en un Postgres local.
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text,
  raw_user_meta_data jsonb default '{}', email_confirmed_at timestamptz, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated;
