-- =====================================================================
-- 0028  (1) Calendarios de pago con fecha pasada: se permiten mientras no haya una nómina
--           autorizada de la sucursal que cubra esas fechas (así se arman las semanales atrasadas).
--       (2) Eventos del calendario general (itinerario: competencias, juntas, festivos, cursos…).
-- =====================================================================
create or replace function app.guard_pay_schedule() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.department_id is not null and not exists
     (select 1 from public.departments where id = new.department_id and company_id = new.company_id) then
    raise exception 'El departamento no pertenece a la empresa';
  end if;
  if new.group_id is not null and not exists
     (select 1 from public.groups where id = new.group_id and company_id = new.company_id) then
    raise exception 'El grupo no pertenece a la empresa';
  end if;
  if new.employee_id is not null and not exists
     (select 1 from public.employees where id = new.employee_id and company_id = new.company_id) then
    raise exception 'El empleado no pertenece a la empresa';
  end if;
  if not app.is_backoffice() and new.effective_from < app.today_mx() and exists (
       select 1 from public.payroll_runs r where r.company_id = new.company_id and r.status = 'autorizada' and r.period_end >= new.effective_from) then
    raise exception 'Ya hay nóminas autorizadas desde esa fecha: el calendario solo puede empezar después de la última autorizada';
  end if;
  return new;
end $$;

create table if not exists public.calendar_events (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  date         date not null,
  end_date     date,
  start_time   text check (start_time is null or start_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  end_time     text check (end_time is null or end_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  kind         text not null default 'evento' check (kind in ('evento', 'competencia', 'junta', 'festivo', 'curso', 'clase_especial', 'otro')),
  title        text not null check (length(trim(title)) > 0),
  notes        text,
  created_by   uuid references public.app_users(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references public.app_users(id),
  check (end_date is null or end_date >= date)
);
create index if not exists ce_company_date on public.calendar_events (company_id, date);

create or replace function app.guard_event() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'No se borra: se cancela'; end if;
  if tg_op = 'INSERT' then if not app.is_backoffice() then new.created_by := auth.uid(); new.cancelled_at := null; end if; return new; end if;
  if app.is_backoffice() then return new; end if;
  if old.cancelled_at is not null then raise exception 'Ya está cancelado'; end if;
  if new.cancelled_at is not null then new.cancelled_at := now(); new.cancelled_by := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists trg_guard_event on public.calendar_events;
create trigger trg_guard_event before insert or update or delete on public.calendar_events for each row execute function app.guard_event();
drop trigger if exists aud_event on public.calendar_events;
create trigger aud_event after insert or update on public.calendar_events for each row execute function app.audit();

alter table public.calendar_events enable row level security;
drop policy if exists ce_select on public.calendar_events;
create policy ce_select on public.calendar_events for select using (app.can_see_company(company_id));
drop policy if exists ce_insert on public.calendar_events;
create policy ce_insert on public.calendar_events for insert with check (app.has_perm('calendar', 'edit', company_id));
drop policy if exists ce_update on public.calendar_events;
create policy ce_update on public.calendar_events for update using (app.has_perm('calendar', 'edit', company_id)) with check (app.has_perm('calendar', 'edit', company_id));
grant select, insert, update on public.calendar_events to authenticated;
grant execute on all functions in schema app to authenticated;
