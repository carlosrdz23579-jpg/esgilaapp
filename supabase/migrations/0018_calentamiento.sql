-- =====================================================================
-- 0018  Calentamiento: por persona y día, si trabajó activamente en el calentamiento.
-- Por defecto se considera que sí. Marcar "no" hace que la primera media hora de ese día se pague
-- a la mitad (se descuentan 15 min de su tarifa). Lo marca quien tenga permiso 'warmup'
-- (la directora, y a quien ella o el director se lo den: Head Coach, coach o Staff).
-- Solo-agregar: el registro más reciente del día es el que cuenta.
-- =====================================================================
create table if not exists public.warmup_marks (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  employee_id uuid not null,
  date        date not null,
  active      boolean not null,
  note        text,
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (employee_id, company_id) references public.employees(id, company_id)
);
create index if not exists wm_emp_date on public.warmup_marks (employee_id, date, created_at desc);

create or replace function app.guard_warmup() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op <> 'INSERT' then raise exception 'El registro de calentamiento no se edita: marca de nuevo el día'; end if;
  if not app.is_backoffice() then
    new.created_by := auth.uid();
    if new.date > app.today_mx() then raise exception 'No se marca el calentamiento de días futuros'; end if;
    if exists (select 1 from public.employees e where e.id = new.employee_id and e.user_id = auth.uid()) then
      raise exception 'No puedes marcar tu propio calentamiento';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_warmup on public.warmup_marks;
create trigger trg_guard_warmup before insert or update or delete on public.warmup_marks for each row execute function app.guard_warmup();
drop trigger if exists aud_warmup on public.warmup_marks;
create trigger aud_warmup after insert on public.warmup_marks for each row execute function app.audit();

-- Último registro por persona y día (respeta RLS).
create or replace view public.warmup_latest with (security_invoker = true) as
  select distinct on (employee_id, date) employee_id, company_id, date, active, note, created_by, created_at
  from public.warmup_marks order by employee_id, date, created_at desc;

alter table public.warmup_marks enable row level security;
drop policy if exists wm_select on public.warmup_marks;
create policy wm_select on public.warmup_marks for select
  using (app.emp_perm('warmup', 'view', employee_id) or app.emp_perm('warmup', 'edit', employee_id)
         or app.emp_perm('payroll', 'view', employee_id) or employee_id = app.my_employee_id(company_id));
drop policy if exists wm_insert on public.warmup_marks;
create policy wm_insert on public.warmup_marks for insert with check (app.emp_perm('warmup', 'edit', employee_id));
grant select, insert on public.warmup_marks to authenticated;
grant select on public.warmup_latest to authenticated;

-- Quien marca el calentamiento necesita ver la lista de personas (solo datos de expediente, nunca salario).
drop policy if exists emp_select on public.employees;
create policy emp_select on public.employees for select
  using (user_id = auth.uid()
         or app.has_perm('employees','view', company_id, department_id, group_id, id)
         or app.is_head_coach_for(company_id, department_id)
         or app.has_perm('warmup','edit', company_id, department_id, group_id, id)
         or app.has_perm('warmup','view', company_id, department_id, group_id, id));

-- El administrador (seed) recibe los permisos nuevos de calentamiento.
insert into public.permission_grants (user_id, module, action, granted_by)
select u.id, 'warmup'::app.perm_module, a::app.perm_action, null
from public.app_users u cross join unnest(array['view', 'edit']) a
where u.role = 'admin' and u.status = 'active'
  and not exists (select 1 from public.permission_grants g where g.user_id = u.id and g.module = 'warmup' and g.action = a::app.perm_action and g.revoked_at is null);
grant execute on all functions in schema app to authenticated;
