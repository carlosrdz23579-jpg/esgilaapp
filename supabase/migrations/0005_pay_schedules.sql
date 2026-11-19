-- =====================================================================
-- 0005  Etapa 5: frecuencias y calendarios de pago
-- Prioridad: empleado > grupo > departamento > empresa. Tabla de solo-agregar:
-- un cambio es una fila nueva con su vigencia; nunca se reescribe el pasado.
-- (La columna employees.pay_frequency_override de 0001 queda sin uso.)
-- =====================================================================
create type app.pay_frequency  as enum ('semanal','quincenal','mensual');
create type app.weekend_rule   as enum ('antes','despues','ninguno');
create type app.schedule_scope as enum ('empresa','departamento','grupo','empleado');

create table public.pay_schedules (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  scope          app.schedule_scope not null,
  department_id  uuid references public.departments(id),
  group_id       uuid references public.groups(id),
  employee_id    uuid references public.employees(id),
  frequency      app.pay_frequency not null,
  weekly_weekday smallint check (weekly_weekday between 0 and 6),      -- 0 domingo … 6 sábado
  biweekly_day_1 smallint check (biweekly_day_1 between 1 and 31),
  biweekly_day_2 smallint check (biweekly_day_2 between 1 and 31),     -- 31 = último día del mes
  monthly_day    smallint check (monthly_day between 1 and 31),        -- 31 = último día del mes
  weekend_rule   app.weekend_rule not null default 'antes',
  effective_from date not null,
  effective_to   date,                                                  -- NULL = permanente
  reason         text not null check (length(trim(reason)) > 0),
  created_by     uuid references public.app_users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  check ((scope = 'empresa'      and department_id is null and group_id is null and employee_id is null)
      or (scope = 'departamento' and department_id is not null and group_id is null and employee_id is null)
      or (scope = 'grupo'        and group_id is not null and employee_id is null)
      or (scope = 'empleado'     and employee_id is not null)),
  check ((frequency = 'semanal'   and weekly_weekday is not null)
      or (frequency = 'quincenal' and biweekly_day_1 is not null and biweekly_day_2 is not null and biweekly_day_1 < biweekly_day_2)
      or (frequency = 'mensual'   and monthly_day is not null))
);
create index on public.pay_schedules (company_id, scope, effective_from desc);

-- El destino del calendario debe pertenecer a la misma empresa; sin cambios retroactivos.
create function app.guard_pay_schedule() returns trigger
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
  if not app.is_backoffice() and new.effective_from < current_date - 1 then
    raise exception 'No se pueden crear calendarios con vigencia anterior a hoy (los periodos pasados no se modifican)';
  end if;
  return new;
end $$;
create trigger trg_guard_pay_schedule before insert on public.pay_schedules
  for each row execute function app.guard_pay_schedule();
create trigger trg_pay_schedules_immutable before update or delete on public.pay_schedules
  for each row execute function app.block_mutation();
create trigger aud_pay_schedules after insert on public.pay_schedules
  for each row execute function app.audit();

-- Calendario efectivo de un empleado en una fecha (respeta RLS: security invoker).
create function app.effective_schedule(p_employee uuid, p_date date)
returns public.pay_schedules language sql stable as $$
  select s.* from public.pay_schedules s
  join public.employees e on e.id = p_employee
  where s.company_id = e.company_id
    and s.effective_from <= p_date and (s.effective_to is null or s.effective_to >= p_date)
    and ((s.scope = 'empleado'     and s.employee_id   = e.id)
      or (s.scope = 'grupo'        and s.group_id      = e.group_id)
      or (s.scope = 'departamento' and s.department_id = e.department_id)
      or  s.scope = 'empresa')
  order by case s.scope when 'empleado' then 1 when 'grupo' then 2 when 'departamento' then 3 else 4 end,
           s.effective_from desc, s.created_at desc
  limit 1;
$$;

alter table public.pay_schedules enable row level security;
create policy ps_select on public.pay_schedules for select using (app.can_see_company(company_id));
create policy ps_insert on public.pay_schedules for insert
  with check (app.has_perm('pay_schedules','configure', company_id, department_id, group_id, employee_id));

-- Permisos de la API (mismo patrón que 0003)
grant select, insert on public.pay_schedules to authenticated;
grant execute on all functions in schema app to authenticated;
