-- =====================================================================
-- 0007  Editar, cancelar y terminar calendarios de pago (sin reescribir el pasado)
-- - Programado (aún no empieza): se puede editar su configuración o cancelar.
-- - Vigente: solo se puede terminar (effective_to >= hoy). Lo pasado no se toca.
-- - Nunca se borra: cancelar = marcar cancelled_at, quién y motivo. Todo pasa por auditoría.
-- "Hoy" se calcula en hora de Torreón (America/Mexico_City), no en UTC.
-- =====================================================================
create or replace function app.today_mx() returns date language sql stable as $$
  select (now() at time zone 'America/Mexico_City')::date $$;

alter table public.pay_schedules
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancelled_by  uuid references public.app_users(id),
  add column if not exists cancel_reason text,
  add column if not exists updated_at    timestamptz,
  add column if not exists updated_by    uuid references public.app_users(id);

-- La regla de vigencia de 0005 usaba current_date (UTC) con un día de tolerancia; ahora usa hora local.
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
  if not app.is_backoffice() and new.effective_from < app.today_mx() then
    raise exception 'No se pueden crear calendarios con vigencia anterior a hoy (los periodos pasados no se modifican)';
  end if;
  return new;
end $$;

create or replace function app.guard_pay_schedule_update() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare hoy date := app.today_mx();
begin
  if tg_op = 'DELETE' then
    raise exception 'Los calendarios no se borran: cancélalo o termínalo';
  end if;
  if app.is_backoffice() then return new; end if;

  if old.cancelled_at is not null then
    raise exception 'Este calendario ya está cancelado';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.scope <> old.scope
     or new.department_id is distinct from old.department_id or new.group_id is distinct from old.group_id
     or new.employee_id is distinct from old.employee_id or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'No se puede cambiar a quién aplica un calendario; cancélalo y crea otro';
  end if;

  if new.cancelled_at is not null then                       -- cancelar
    if old.effective_from <= hoy then
      raise exception 'Un calendario que ya empezó no se cancela: termínalo (fecha de fin) para no alterar periodos pasados';
    end if;
    if coalesce(length(trim(new.cancel_reason)), 0) = 0 then
      raise exception 'El motivo de cancelación es obligatorio';
    end if;
    new.cancelled_at := now(); new.cancelled_by := auth.uid();
  elsif old.effective_from > hoy then                        -- programado: edición libre hacia el futuro
    if new.effective_from < hoy then
      raise exception 'La nueva vigencia no puede empezar antes de hoy';
    end if;
  else                                                       -- vigente o terminado: solo se puede terminar
    if (new.frequency, new.weekly_weekday, new.biweekly_day_1, new.biweekly_day_2, new.monthly_day,
        new.weekend_rule, new.cutoff, new.effective_from, new.reason)
       is distinct from
       (old.frequency, old.weekly_weekday, old.biweekly_day_1, old.biweekly_day_2, old.monthly_day,
        old.weekend_rule, old.cutoff, old.effective_from, old.reason) then
      raise exception 'Un calendario que ya empezó no se edita; termínalo y crea uno nuevo desde hoy';
    end if;
    if old.effective_to is not null and old.effective_to < hoy then
      raise exception 'Este calendario ya terminó';
    end if;
    if new.effective_to is null or new.effective_to < hoy then
      raise exception 'La fecha de fin debe ser hoy o posterior (los periodos pasados no se modifican)';
    end if;
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists trg_pay_schedules_immutable on public.pay_schedules;
drop trigger if exists trg_pay_schedules_guard_update on public.pay_schedules;
create trigger trg_pay_schedules_guard_update before update or delete on public.pay_schedules
  for each row execute function app.guard_pay_schedule_update();
drop trigger if exists aud_pay_schedules_update on public.pay_schedules;
create trigger aud_pay_schedules_update after update on public.pay_schedules
  for each row execute function app.audit();

-- Los cancelados nunca cuentan para el calendario efectivo.
create or replace function app.effective_schedule(p_employee uuid, p_date date)
returns public.pay_schedules language sql stable as $$
  select s.* from public.pay_schedules s
  join public.employees e on e.id = p_employee
  where s.company_id = e.company_id and s.cancelled_at is null
    and s.effective_from <= p_date and (s.effective_to is null or s.effective_to >= p_date)
    and ((s.scope = 'empleado'     and s.employee_id   = e.id)
      or (s.scope = 'grupo'        and s.group_id      = e.group_id)
      or (s.scope = 'departamento' and s.department_id = e.department_id)
      or  s.scope = 'empresa')
  order by case s.scope when 'empleado' then 1 when 'grupo' then 2 when 'departamento' then 3 else 4 end,
           s.effective_from desc, s.created_at desc
  limit 1;
$$;

drop policy if exists ps_update on public.pay_schedules;
create policy ps_update on public.pay_schedules for update
  using (app.has_perm('pay_schedules','configure', company_id, department_id, group_id, employee_id))
  with check (app.has_perm('pay_schedules','configure', company_id, department_id, group_id, employee_id));

grant update on public.pay_schedules to authenticated;
grant execute on all functions in schema app to authenticated;
