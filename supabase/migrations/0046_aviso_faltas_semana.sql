-- =====================================================================
-- 0046  Registro de a quién ya se le mandó mensaje por faltas de la semana. Repetible.
-- =====================================================================
create table if not exists public.absence_contacts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  student_id  uuid not null,
  week_start  date not null,                -- lunes de la semana
  channel     text not null default 'whatsapp',
  note        text,
  author_name text,
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  foreign key (student_id, company_id) references public.students(id, company_id)
);
create index if not exists ac_week on public.absence_contacts (company_id, week_start);
create or replace function app.guard_absence_contact() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if not app.is_backoffice() then new.created_by := auth.uid(); end if;
  new.author_name := app.author_name(new.created_by); return new;
end $$;
drop trigger if exists trg_ac on public.absence_contacts;
create trigger trg_ac before insert on public.absence_contacts for each row execute function app.guard_absence_contact();
alter table public.absence_contacts enable row level security;
drop policy if exists ac_sel on public.absence_contacts; create policy ac_sel on public.absence_contacts for select using (app.can_see_students(company_id));
drop policy if exists ac_ins on public.absence_contacts; create policy ac_ins on public.absence_contacts for insert with check (app.can_see_students(company_id));
grant select, insert on public.absence_contacts to authenticated;
