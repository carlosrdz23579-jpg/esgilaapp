-- =====================================================================
-- 0015  Préstamos
-- - lender 'empresa': sin interés (art. 111 LFT). lender 'director': préstamo personal del director,
--   puede llevar interés; queda marcado como tal.
-- - Flujo: pendiente -> activo | rechazado; activo -> liquidado (saldo 0) | cancelado.
--   Quien lo captura no lo autoriza (salvo el director).
-- - Pago por periodo = min(parcialidad, saldo). Se descuenta en la nómina; al AUTORIZAR la nómina
--   se registra el abono. Si el director reabre la nómina, el abono se revierte (fila negativa).
-- - Saltar un periodo: lo solicita quien edita nómina; SOLO el director lo autoriza.
-- - Abonos manuales (fuera de nómina) con motivo. Nada se borra.
-- =====================================================================
create table if not exists public.loans (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  employee_id      uuid not null,
  lender           text not null check (lender in ('empresa', 'director')),
  principal_cents  bigint not null check (principal_cents > 0),
  interest_cents   bigint not null default 0 check (interest_cents >= 0),
  installment_cents bigint not null check (installment_cents > 0),
  start_date       date not null,          -- se empieza a descontar en el periodo que incluye esta fecha
  reason           text not null check (length(trim(reason)) > 0),
  status           text not null default 'pendiente' check (status in ('pendiente', 'activo', 'rechazado', 'liquidado', 'cancelado')),
  created_by       uuid references public.app_users(id) default auth.uid(),
  created_at       timestamptz not null default now(),
  decided_by       uuid references public.app_users(id),
  decided_at       timestamptz,
  decision_note    text,
  check (lender = 'director' or interest_cents = 0),
  foreign key (employee_id, company_id) references public.employees(id, company_id)
);
create index if not exists loans_emp_idx on public.loans (employee_id, status);

create table if not exists public.loan_payments (
  id          uuid primary key default gen_random_uuid(),
  loan_id     uuid not null references public.loans(id),
  amount_cents bigint not null check (amount_cents <> 0),   -- negativo = reversa por reapertura de nómina
  source      text not null check (source in ('nomina', 'manual', 'reversa')),
  run_id      uuid references public.payroll_runs(id),
  note        text,
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists lp_loan_idx on public.loan_payments (loan_id);

create table if not exists public.loan_skips (
  id            uuid primary key default gen_random_uuid(),
  loan_id       uuid not null references public.loans(id),
  skip_date     date not null,                 -- se salta el periodo que incluye esta fecha
  reason        text not null check (length(trim(reason)) > 0),
  status        text not null default 'pendiente' check (status in ('pendiente', 'autorizado', 'rechazado')),
  created_by    uuid references public.app_users(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  decided_by    uuid references public.app_users(id),
  decided_at    timestamptz
);

create or replace function app.loan_paid(p_loan uuid) returns bigint
language sql stable security definer set search_path = public, app as $$
  select coalesce(sum(amount_cents), 0)::bigint from public.loan_payments where loan_id = p_loan;
$$;

-- ---------- Guardas ----------
create or replace function app.guard_loan() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Un préstamo no se borra: se cancela'; end if;
  if tg_op = 'INSERT' then
    if not app.is_backoffice() then
      new.status := 'pendiente'; new.created_by := auth.uid(); new.decided_by := null; new.decided_at := null; new.decision_note := null;
    end if;
    return new;
  end if;
  if app.is_backoffice() or coalesce(current_setting('app.loan_fn', true), '') = 'on' then return new; end if;
  if (new.company_id, new.employee_id, new.lender, new.principal_cents, new.interest_cents, new.installment_cents, new.start_date, new.reason, new.created_by, new.created_at)
     is distinct from
     (old.company_id, old.employee_id, old.lender, old.principal_cents, old.interest_cents, old.installment_cents, old.start_date, old.reason, old.created_by, old.created_at) then
    raise exception 'Un préstamo no se edita: cancélalo y registra otro';
  end if;
  if not ((old.status = 'pendiente' and new.status in ('activo', 'rechazado')) or (old.status = 'activo' and new.status = 'cancelado')) then
    raise exception 'Cambio de estado no permitido (% -> %)', old.status, new.status;
  end if;
  if new.status in ('activo', 'rechazado') then
    if not app.emp_perm('payroll', 'authorize', old.employee_id) then raise exception 'Necesitas permiso de autorizar nómina'; end if;
    if old.created_by = auth.uid() and not app.is_director() then raise exception 'No puedes autorizar un préstamo que tú capturaste'; end if;
    if old.lender = 'director' and not app.is_director() then raise exception 'Un préstamo personal del director solo lo autoriza el director'; end if;
  end if;
  new.decided_by := auth.uid(); new.decided_at := now();
  return new;
end $$;
drop trigger if exists trg_guard_loan on public.loans;
create trigger trg_guard_loan before insert or update or delete on public.loans for each row execute function app.guard_loan();

create or replace function app.guard_loan_payment() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare l public.loans; total bigint;
begin
  if tg_op <> 'INSERT' then raise exception 'Los abonos no se editan ni se borran'; end if;
  select * into l from public.loans where id = new.loan_id;
  if coalesce(current_setting('app.loan_fn', true), '') <> 'on' and not app.is_backoffice() then
    if new.source <> 'manual' then raise exception 'Los abonos de nómina los registra la autorización de la nómina'; end if;
    if new.amount_cents <= 0 or coalesce(length(trim(new.note)), 0) = 0 then raise exception 'Abono manual: importe positivo y motivo'; end if;
    if l.status <> 'activo' then raise exception 'Solo se abona a un préstamo activo'; end if;
  end if;
  total := l.principal_cents + l.interest_cents;
  if new.amount_cents > 0 and app.loan_paid(l.id) + new.amount_cents > total then
    raise exception 'El abono excede el saldo del préstamo';
  end if;
  new.created_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_guard_loan_payment on public.loan_payments;
create trigger trg_guard_loan_payment before insert or update or delete on public.loan_payments for each row execute function app.guard_loan_payment();

-- Al llegar a saldo 0 el préstamo queda liquidado (y vuelve a activo si se revierte un abono).
create or replace function app.loan_after_payment() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare l public.loans;
begin
  select * into l from public.loans where id = new.loan_id;
  perform set_config('app.loan_fn', 'on', true);
  if app.loan_paid(l.id) >= l.principal_cents + l.interest_cents and l.status = 'activo' then
    update public.loans set status = 'liquidado' where id = l.id;
  elsif app.loan_paid(l.id) < l.principal_cents + l.interest_cents and l.status = 'liquidado' then
    update public.loans set status = 'activo' where id = l.id;
  end if;
  perform set_config('app.loan_fn', 'off', true);
  return new;
end $$;
drop trigger if exists trg_loan_after_payment on public.loan_payments;
create trigger trg_loan_after_payment after insert on public.loan_payments for each row execute function app.loan_after_payment();

create or replace function app.guard_loan_skip() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'No se borra: se rechaza'; end if;
  if tg_op = 'INSERT' then
    if not app.is_backoffice() then new.status := 'pendiente'; new.created_by := auth.uid(); new.decided_by := null; new.decided_at := null; end if;
    return new;
  end if;
  if app.is_backoffice() then return new; end if;
  if (new.loan_id, new.skip_date, new.reason, new.created_by, new.created_at) is distinct from (old.loan_id, old.skip_date, old.reason, old.created_by, old.created_at)
     or old.status <> 'pendiente' or new.status not in ('autorizado', 'rechazado') then
    raise exception 'Solo se autoriza o rechaza una solicitud pendiente';
  end if;
  if not app.is_director() then raise exception 'Saltar un pago solo lo autoriza el director'; end if;
  new.decided_by := auth.uid(); new.decided_at := now();
  return new;
end $$;
drop trigger if exists trg_guard_loan_skip on public.loan_skips;
create trigger trg_guard_loan_skip before insert or update or delete on public.loan_skips for each row execute function app.guard_loan_skip();

drop trigger if exists aud_loans on public.loans;
create trigger aud_loans after insert or update on public.loans for each row execute function app.audit();
drop trigger if exists aud_loan_payments on public.loan_payments;
create trigger aud_loan_payments after insert on public.loan_payments for each row execute function app.audit();
drop trigger if exists aud_loan_skips on public.loan_skips;
create trigger aud_loan_skips after insert or update on public.loan_skips for each row execute function app.audit();

-- ---------- Autorizar / reabrir nómina registra o revierte los abonos ----------
-- detail.loanLines = [{ "loan_id": "...", "amount": "12345" }]
create or replace function app.apply_payroll_loans(p_run uuid, p_version int, p_reverse boolean)
returns void language plpgsql security definer set search_path = public, app as $$
declare x record;
begin
  perform set_config('app.loan_fn', 'on', true);
  for x in
    select (ll->>'loan_id')::uuid as loan_id, (ll->>'amount')::bigint as amount
    from public.payroll_lines l, jsonb_array_elements(coalesce(l.detail->'loanLines', '[]')) ll
    where l.run_id = p_run and l.version = p_version and (ll->>'amount')::bigint > 0
  loop
    insert into public.loan_payments (loan_id, amount_cents, source, run_id, note)
    values (x.loan_id, case when p_reverse then -x.amount else x.amount end,
            case when p_reverse then 'reversa' else 'nomina' end, p_run,
            case when p_reverse then 'Reapertura de nómina' else 'Descuento en nómina' end);
  end loop;
  perform set_config('app.loan_fn', 'off', true);
end $$;

create or replace function app.payroll_loans_hook() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.status = 'autorizada' and old.status <> 'autorizada' then
    perform app.apply_payroll_loans(new.id, new.authorized_version, false);
  elsif old.status = 'autorizada' and new.status <> 'autorizada' then
    perform app.apply_payroll_loans(old.id, old.authorized_version, true);
  end if;
  return new;
end $$;
drop trigger if exists trg_payroll_loans on public.payroll_runs;
create trigger trg_payroll_loans after update on public.payroll_runs for each row execute function app.payroll_loans_hook();

-- ---------- RLS ----------
alter table public.loans         enable row level security;
alter table public.loan_payments enable row level security;
alter table public.loan_skips    enable row level security;

drop policy if exists loans_select on public.loans;
create policy loans_select on public.loans for select
  using (app.emp_perm('payroll', 'view', employee_id) or employee_id = app.my_employee_id(company_id));
drop policy if exists loans_insert on public.loans;
create policy loans_insert on public.loans for insert with check (app.emp_perm('payroll', 'edit', employee_id));
drop policy if exists loans_update on public.loans;
create policy loans_update on public.loans for update
  using (app.emp_perm('payroll', 'edit', employee_id) or app.emp_perm('payroll', 'authorize', employee_id))
  with check (app.emp_perm('payroll', 'edit', employee_id) or app.emp_perm('payroll', 'authorize', employee_id));

create or replace function app.loan_visible(p_loan uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from public.loans l where l.id = p_loan
    and (app.emp_perm('payroll', 'view', l.employee_id) or l.employee_id = app.my_employee_id(l.company_id)));
$$;
create or replace function app.loan_editable(p_loan uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from public.loans l where l.id = p_loan and app.emp_perm('payroll', 'edit', l.employee_id));
$$;

drop policy if exists lp_select on public.loan_payments;
create policy lp_select on public.loan_payments for select using (app.loan_visible(loan_id));
drop policy if exists lp_insert on public.loan_payments;
create policy lp_insert on public.loan_payments for insert with check (app.loan_editable(loan_id));

drop policy if exists ls_select on public.loan_skips;
create policy ls_select on public.loan_skips for select using (app.loan_visible(loan_id));
drop policy if exists ls_insert on public.loan_skips;
create policy ls_insert on public.loan_skips for insert with check (app.loan_editable(loan_id));
drop policy if exists ls_update on public.loan_skips;
create policy ls_update on public.loan_skips for update using (app.is_director()) with check (app.is_director());

grant select, insert, update on public.loans, public.loan_skips to authenticated;
grant select, insert on public.loan_payments to authenticated;
grant execute on all functions in schema app to authenticated;
