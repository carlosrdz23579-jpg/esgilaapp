-- =====================================================================
-- 0016  Forma de pago y conciliación de efectivo
-- - employees.pay_method: efectivo | transferencia.
-- - cash_reconciliations: por nómina autorizada, cuánto se retiró y cuánto se entregó.
--   Solo-agregar (si se corrige, se registra otra). Sobrante = retirado − entregado.
-- =====================================================================
alter table public.employees
  add column if not exists pay_method text not null default 'efectivo' check (pay_method in ('efectivo', 'transferencia'));

create table if not exists public.cash_reconciliations (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.payroll_runs(id),
  company_id      uuid not null references public.companies(id),
  planned_cents   bigint not null check (planned_cents >= 0),     -- lo que la calculadora dijo retirar
  withdrawn_cents bigint not null check (withdrawn_cents >= 0),
  delivered_cents bigint not null check (delivered_cents >= 0),
  note            text,
  created_by      uuid references public.app_users(id) default auth.uid(),
  created_at      timestamptz not null default now()
);

create or replace function app.guard_cash_rec() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op <> 'INSERT' then raise exception 'La conciliación no se edita ni se borra: registra otra'; end if;
  if not exists (select 1 from public.payroll_runs r where r.id = new.run_id and r.company_id = new.company_id and r.status = 'autorizada') then
    raise exception 'Solo se concilia una nómina autorizada de esta sucursal';
  end if;
  if new.withdrawn_cents <> new.delivered_cents and coalesce(length(trim(new.note)), 0) = 0 then
    raise exception 'Hay diferencia entre lo retirado y lo entregado: explica en la nota';
  end if;
  new.created_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_guard_cash_rec on public.cash_reconciliations;
create trigger trg_guard_cash_rec before insert or update or delete on public.cash_reconciliations for each row execute function app.guard_cash_rec();
drop trigger if exists aud_cash_rec on public.cash_reconciliations;
create trigger aud_cash_rec after insert on public.cash_reconciliations for each row execute function app.audit();

alter table public.cash_reconciliations enable row level security;
drop policy if exists cr_select on public.cash_reconciliations;
create policy cr_select on public.cash_reconciliations for select using (app.has_perm('cash', 'view', company_id));
drop policy if exists cr_insert on public.cash_reconciliations;
create policy cr_insert on public.cash_reconciliations for insert with check (app.has_perm('cash', 'edit', company_id));
grant select, insert on public.cash_reconciliations to authenticated;
grant execute on all functions in schema app to authenticated;
