-- =====================================================================
-- 0011  Ingresos extra (bonos, premios, recompensas) para cualquier tipo de sueldo
-- Mismo control que los descuentos: pendiente -> autorizado | rechazado -> cancelado;
-- quien lo captura no lo autoriza (salvo el director); nada se borra; todo auditado.
-- =====================================================================
create table if not exists public.extra_earnings (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  employee_id   uuid not null,
  label         text not null check (length(trim(label)) > 0),
  amount_cents  bigint not null check (amount_cents > 0),
  kind          text not null check (kind in ('unico', 'recurrente')),
  start_date    date not null,
  end_date      date,
  reason        text not null check (length(trim(reason)) > 0),
  status        text not null default 'pendiente' check (status in ('pendiente', 'autorizado', 'rechazado', 'cancelado')),
  created_by    uuid references public.app_users(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  decided_by    uuid references public.app_users(id),
  decided_at    timestamptz,
  decision_note text,
  check (kind = 'recurrente' or end_date is null),
  check (end_date is null or end_date >= start_date),
  foreign key (employee_id, company_id) references public.employees(id, company_id)
);
create index if not exists xe_emp_idx on public.extra_earnings (employee_id, start_date);

-- Misma regla que app.guard_deduction (mismas columnas); mensajes según la tabla.
create or replace function app.guard_adjustment() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare what text := case tg_table_name when 'extra_earnings' then 'ingreso extra' else 'descuento' end;
begin
  if tg_op = 'DELETE' then raise exception 'Un % no se borra: cancélalo o recházalo', what; end if;
  if tg_op = 'INSERT' then
    if not app.is_backoffice() then
      new.status := 'pendiente'; new.created_by := auth.uid();
      new.decided_by := null; new.decided_at := null; new.decision_note := null;
    end if;
    return new;
  end if;
  if app.is_backoffice() then return new; end if;
  if (new.company_id, new.employee_id, new.label, new.amount_cents, new.kind, new.start_date, new.end_date, new.reason, new.created_by, new.created_at)
     is distinct from
     (old.company_id, old.employee_id, old.label, old.amount_cents, old.kind, old.start_date, old.end_date, old.reason, old.created_by, old.created_at) then
    raise exception 'Un % no se edita: cancélalo y captura otro', what;
  end if;
  if not ((old.status = 'pendiente' and new.status in ('autorizado', 'rechazado'))
       or (old.status = 'autorizado' and new.status = 'cancelado')) then
    raise exception 'Cambio de estado no permitido (% -> %)', old.status, new.status;
  end if;
  if new.status in ('autorizado', 'rechazado') then
    if not app.emp_perm('payroll','authorize', old.employee_id) then
      raise exception 'Necesitas permiso de autorizar nómina para decidir un %', what;
    end if;
    if old.created_by = auth.uid() and not app.is_director() then
      raise exception 'No puedes autorizar un % que tú capturaste', what;
    end if;
  end if;
  new.decided_by := auth.uid(); new.decided_at := now();
  return new;
end $$;

drop trigger if exists trg_guard_extra on public.extra_earnings;
create trigger trg_guard_extra before insert or update or delete on public.extra_earnings
  for each row execute function app.guard_adjustment();
drop trigger if exists aud_extra on public.extra_earnings;
create trigger aud_extra after insert or update on public.extra_earnings for each row execute function app.audit();

alter table public.extra_earnings enable row level security;
drop policy if exists xe_select on public.extra_earnings;
create policy xe_select on public.extra_earnings for select
  using (app.emp_perm('payroll','view', employee_id) or employee_id = app.my_employee_id(company_id));
drop policy if exists xe_insert on public.extra_earnings;
create policy xe_insert on public.extra_earnings for insert with check (app.emp_perm('payroll','edit', employee_id));
drop policy if exists xe_update on public.extra_earnings;
create policy xe_update on public.extra_earnings for update
  using (app.emp_perm('payroll','edit', employee_id) or app.emp_perm('payroll','authorize', employee_id))
  with check (app.emp_perm('payroll','edit', employee_id) or app.emp_perm('payroll','authorize', employee_id));
grant select, insert, update on public.extra_earnings to authenticated;
grant execute on all functions in schema app to authenticated;
