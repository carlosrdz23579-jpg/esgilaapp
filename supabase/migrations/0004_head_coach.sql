-- 0004  Marca de Head Coach (aplicada a mano en Supabase)
alter table public.employees add column if not exists is_head_coach boolean not null default false;
create index if not exists employees_head_coach_idx on public.employees (company_id) where is_head_coach;
