-- =====================================================================
-- 0043  Caja y cobros. Repetible.  (Permiso 'cashbox': edit = abrir caja y cobrar,
--        view = ver cortes y ventas, configure = cancelar ventas de otros y reabrir)
--   cash_sessions   caja por vendedor: se abre con fondo, se cierra con conteo; si nadie la
--                   cierra, se cierra sola al terminar el día (al siguiente movimiento)
--   sales           recibo con folio por sucursal, de una alumna o de mostrador
--   sale_lines      qué se cobró: mensualidad (plan+mes), cambio de plan, anualidad, producto,
--                   saldo a favor, otro — con su desglose (beca, hermanos, pronto pago, recargo)
--   sale_payments   cómo se pagó (una o varias formas de pago, incluido "Saldo a favor")
--   Las ventas no se borran ni se editan: se cancelan con motivo.
-- =====================================================================
alter table public.billing_rules add column if not exists charge_from date;   -- desde qué mes se cobran mensualidades en este sistema
update public.billing_rules set charge_from = date_trunc('month', app.today_mx())::date where charge_from is null;
alter table public.billing_rules alter column charge_from set default date_trunc('month', now())::date;

insert into public.payment_methods (name, kind, sort) values ('Saldo a favor', 'otro', 99) on conflict (name) do nothing;

create table if not exists public.cash_sessions (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  opened_by       uuid not null references public.app_users(id) default auth.uid(),
  opened_name     text,
  opened_at       timestamptz not null default now(),
  opened_on       date not null default app.today_mx(),
  opening_cents   bigint not null default 0 check (opening_cents >= 0),
  closed_at       timestamptz,
  closed_by       uuid references public.app_users(id),
  counted_cents   bigint check (counted_cents is null or counted_cents >= 0),   -- efectivo contado al cerrar
  auto_closed     boolean not null default false,
  note            text
);
create unique index if not exists cs_one_open on public.cash_sessions (company_id, opened_by) where closed_at is null;

create table if not exists public.folio_counters (company_id uuid primary key references public.companies(id), last int not null default 0);

create table if not exists public.sales (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  folio           int not null,
  session_id      uuid references public.cash_sessions(id),
  student_id      uuid references public.students(id),          -- null = venta de mostrador
  customer_name   text,
  sold_at         timestamptz not null default now(),
  sold_on         date not null default app.today_mx(),
  total_cents     bigint not null check (total_cents >= 0),
  note            text,
  seller_name     text,
  created_by      uuid references public.app_users(id) default auth.uid(),
  cancelled_at    timestamptz,
  cancelled_by    uuid references public.app_users(id),
  cancel_reason   text,
  unique (company_id, folio)
);
create index if not exists sales_day on public.sales (company_id, sold_on);
create index if not exists sales_student on public.sales (student_id);

create table if not exists public.sale_lines (
  id              uuid primary key default gen_random_uuid(),
  sale_id         uuid not null references public.sales(id),
  kind            text not null check (kind in ('mensualidad', 'cambio_plan', 'anualidad', 'producto', 'saldo_favor', 'otro')),
  student_id      uuid references public.students(id),
  subscription_id uuid references public.subscriptions(id),
  month           date check (month is null or extract(day from month) = 1),
  product_id      uuid references public.products(id),
  year            int,
  qty             numeric(8,2) not null default 1 check (qty > 0),
  description     text not null,
  base_cents      bigint not null default 0,        -- precio normal (× cantidad)
  discount_cents  bigint not null default 0 check (discount_cents >= 0),
  surcharge_cents bigint not null default 0 check (surcharge_cents >= 0),
  amount_cents    bigint not null,                  -- lo que se cobró
  detail          jsonb not null default '{}'::jsonb,
  check (amount_cents = base_cents - discount_cents + surcharge_cents)
);
create index if not exists sl_sub_month on public.sale_lines (subscription_id, month);
create index if not exists sl_student on public.sale_lines (student_id);

create table if not exists public.sale_payments (
  id                uuid primary key default gen_random_uuid(),
  sale_id           uuid not null references public.sales(id),
  payment_method_id uuid not null references public.payment_methods(id),
  amount_cents      bigint not null check (amount_cents > 0),
  reference         text
);

-- ---------- Funciones ----------
-- Cierra solas las cajas de días anteriores que nadie cerró.
create or replace function app.close_stale_sessions(p_company uuid) returns void
language sql security definer set search_path = public, app as $$
  update public.cash_sessions set closed_at = ((opened_on + 1)::timestamp at time zone 'America/Mexico_City') - interval '1 second', auto_closed = true
  where company_id = p_company and closed_at is null and opened_on < app.today_mx();
$$;

-- Saldo a favor de una alumna: lo que dejó de más menos lo que ya usó.
create or replace function app.student_credit(p_student uuid) returns bigint
language sql stable security definer set search_path = public, app as $$
  select coalesce((select sum(l.amount_cents) from public.sale_lines l join public.sales s on s.id = l.sale_id
                    where l.kind = 'saldo_favor' and l.student_id = p_student and s.cancelled_at is null), 0)
       - coalesce((select sum(p.amount_cents) from public.sale_payments p join public.sales s on s.id = p.sale_id
                    join public.payment_methods m on m.id = p.payment_method_id
                    where m.name = 'Saldo a favor' and s.student_id = p_student and s.cancelled_at is null), 0);
$$;
create or replace function public.student_credit(p_student uuid) returns bigint
language sql stable security definer set search_path = public, app as $$ select app.student_credit(p_student) $$;
grant execute on function public.student_credit(uuid) to authenticated;

create or replace function public.plan_price_at(p_plan uuid, p_month date) returns bigint
language sql stable security definer set search_path = public, app as $$ select app.plan_price(p_plan, p_month) $$;
grant execute on function public.plan_price_at(uuid, date) to authenticated;

-- Registrar una venta completa (recibo + renglones + pagos) en un solo paso.
-- p_lines: [{kind, student_id, subscription_id, month, product_id, year, qty, description, base_cents, discount_cents, surcharge_cents, amount_cents, detail}]
-- p_payments: [{payment_method_id, amount_cents, reference}]
create or replace function public.register_sale(p_company uuid, p_student uuid, p_customer text, p_lines jsonb, p_payments jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, app as $$
declare sess uuid; sale uuid; fol int; l jsonb; total bigint := 0; paid bigint := 0; credit bigint; used bigint := 0;
begin
  if not app.has_perm('cashbox','edit',p_company) then raise exception 'Sin permiso para cobrar'; end if;
  perform app.close_stale_sessions(p_company);
  select id into sess from public.cash_sessions where company_id = p_company and opened_by = auth.uid() and closed_at is null;
  if sess is null then raise exception 'Abre tu caja antes de cobrar'; end if;
  if jsonb_array_length(coalesce(p_lines, '[]')) = 0 then raise exception 'La venta no tiene nada'; end if;
  select coalesce(sum((x->>'amount_cents')::bigint), 0) into total from jsonb_array_elements(p_lines) x;
  select coalesce(sum((x->>'amount_cents')::bigint), 0) into paid from jsonb_array_elements(coalesce(p_payments, '[]')) x;
  if paid <> total then raise exception 'Lo pagado (%) no cuadra con el total (%)', paid / 100.0, total / 100.0; end if;
  -- mensualidades: no cobrar dos veces el mismo mes del mismo plan
  for l in select * from jsonb_array_elements(p_lines) loop
    if l->>'kind' = 'mensualidad' then
      if exists (select 1 from public.sale_lines x join public.sales s on s.id = x.sale_id
                 where x.kind = 'mensualidad' and x.subscription_id = (l->>'subscription_id')::uuid and x.month = (l->>'month')::date and s.cancelled_at is null)
         or exists (select 1 from public.plan_prepaid_months m where m.subscription_id = (l->>'subscription_id')::uuid and m.month = (l->>'month')::date) then
        raise exception 'La mensualidad de % ya está pagada', to_char((l->>'month')::date, 'MM/YYYY');
      end if;
    end if;
    if l->>'kind' = 'saldo_favor' and p_student is null then raise exception 'El saldo a favor necesita una alumna'; end if;
  end loop;
  -- saldo a favor usado como forma de pago
  select coalesce(sum((x->>'amount_cents')::bigint), 0) into used from jsonb_array_elements(coalesce(p_payments, '[]')) x
    join public.payment_methods m on m.id = (x->>'payment_method_id')::uuid where m.name = 'Saldo a favor';
  if used > 0 then
    credit := app.student_credit(p_student);
    if p_student is null or used > credit then raise exception 'No tiene suficiente saldo a favor (tiene %)', coalesce(credit, 0) / 100.0; end if;
  end if;
  insert into public.folio_counters (company_id, last) values (p_company, 1)
    on conflict (company_id) do update set last = folio_counters.last + 1 returning last into fol;
  insert into public.sales (company_id, folio, session_id, student_id, customer_name, total_cents, note, seller_name)
    values (p_company, fol, sess, p_student, nullif(trim(p_customer), ''), total, nullif(trim(p_note), ''), app.author_name(auth.uid())) returning id into sale;
  insert into public.sale_lines (sale_id, kind, student_id, subscription_id, month, product_id, year, qty, description, base_cents, discount_cents, surcharge_cents, amount_cents, detail)
    select sale, x->>'kind', nullif(x->>'student_id','')::uuid, nullif(x->>'subscription_id','')::uuid, nullif(x->>'month','')::date, nullif(x->>'product_id','')::uuid,
           nullif(x->>'year','')::int, coalesce(nullif(x->>'qty','')::numeric, 1), x->>'description', coalesce((x->>'base_cents')::bigint, (x->>'amount_cents')::bigint - coalesce((x->>'surcharge_cents')::bigint, 0) + coalesce((x->>'discount_cents')::bigint, 0)),
           coalesce((x->>'discount_cents')::bigint, 0), coalesce((x->>'surcharge_cents')::bigint, 0), (x->>'amount_cents')::bigint, coalesce(x->'detail', '{}'::jsonb)
    from jsonb_array_elements(p_lines) x;
  insert into public.sale_payments (sale_id, payment_method_id, amount_cents, reference)
    select sale, (x->>'payment_method_id')::uuid, (x->>'amount_cents')::bigint, nullif(x->>'reference', '') from jsonb_array_elements(coalesce(p_payments, '[]')) x
    where (x->>'amount_cents')::bigint > 0;
  return sale;
end $$;
revoke all on function public.register_sale(uuid, uuid, text, jsonb, jsonb, text) from public;
grant execute on function public.register_sale(uuid, uuid, text, jsonb, jsonb, text) to authenticated;

create or replace function public.cancel_sale(p_sale uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $$
declare s public.sales;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or s.cancelled_at is not null then raise exception 'Esa venta no existe o ya estaba cancelada'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Escribe el motivo de la cancelación'; end if;
  if not (app.has_perm('cashbox','configure',s.company_id) or (s.created_by = auth.uid() and s.sold_on = app.today_mx())) then
    raise exception 'Sólo quien la cobró (el mismo día) o quien tenga permiso de configurar caja puede cancelarla';
  end if;
  if (select coalesce(sum(amount_cents), 0) from public.sale_lines where sale_id = p_sale and kind = 'saldo_favor') > 0
     and app.student_credit(s.student_id) < (select sum(amount_cents) from public.sale_lines where sale_id = p_sale and kind = 'saldo_favor') then
    raise exception 'No se puede cancelar: ya se usó el saldo a favor que generó esta venta';
  end if;
  update public.sales set cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = trim(p_reason) where id = p_sale;
end $$;
grant execute on function public.cancel_sale(uuid, text) to authenticated;

create or replace function public.open_cash(p_company uuid, p_opening bigint) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare id uuid;
begin
  if not app.has_perm('cashbox','edit',p_company) then raise exception 'Sin permiso para abrir caja'; end if;
  perform app.close_stale_sessions(p_company);
  if exists (select 1 from public.cash_sessions where company_id = p_company and opened_by = auth.uid() and closed_at is null) then raise exception 'Ya tienes una caja abierta'; end if;
  insert into public.cash_sessions (company_id, opened_by, opened_name, opening_cents) values (p_company, auth.uid(), app.author_name(auth.uid()), greatest(coalesce(p_opening, 0), 0)) returning cash_sessions.id into id;
  return id;
end $$;
grant execute on function public.open_cash(uuid, bigint) to authenticated;

create or replace function public.close_cash(p_session uuid, p_counted bigint, p_note text) returns void
language plpgsql security definer set search_path = public, app as $$
declare s public.cash_sessions;
begin
  select * into s from public.cash_sessions where id = p_session;
  if s.id is null or s.closed_at is not null then raise exception 'Esa caja ya está cerrada'; end if;
  if s.opened_by <> auth.uid() and not app.has_perm('cashbox','configure',s.company_id) then raise exception 'Sólo quien abrió la caja la cierra'; end if;
  update public.cash_sessions set closed_at = now(), closed_by = auth.uid(), counted_cents = p_counted, note = nullif(trim(p_note), '') where id = p_session;
end $$;
grant execute on function public.close_cash(uuid, bigint, text) to authenticated;

-- ---------- Protección: no se edita ni se borra directo ----------
-- (además de que nadie tiene permiso directo de escribir: todo pasa por las funciones de arriba)
create or replace function app.no_direct_write() returns trigger
language plpgsql set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Las ventas y cajas no se borran'; end if;
  if tg_table_name in ('sale_lines', 'sale_payments') then raise exception 'Las ventas no se editan: se cancelan'; end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['sales','sale_lines','sale_payments','cash_sessions'] loop
    execute format('drop trigger if exists trg_nodw_%1$s on public.%1$s', t);
    execute format('create trigger trg_nodw_%1$s before update or delete on public.%1$s for each row execute function app.no_direct_write()', t);
    execute format('drop trigger if exists aud_%1$s on public.%1$s', t);
    execute format('create trigger aud_%1$s after insert or update on public.%1$s for each row execute function app.audit()', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

create or replace function app.can_cash(c uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.has_perm('cashbox','view',c) or app.has_perm('cashbox','edit',c) or app.has_perm('cashbox','configure',c) or app.can_billing(c);
$$;
create or replace function app.sale_company(p uuid) returns uuid language sql stable security definer set search_path = public, app as $$ select company_id from public.sales where id = p $$;
drop policy if exists cs_sel on public.cash_sessions; create policy cs_sel on public.cash_sessions for select using (app.can_cash(company_id));
drop policy if exists sa_sel2 on public.sales; create policy sa_sel2 on public.sales for select using (app.can_cash(company_id));
drop policy if exists sl_sel on public.sale_lines; create policy sl_sel on public.sale_lines for select using (app.can_cash(app.sale_company(sale_id)));
drop policy if exists sp_sel on public.sale_payments; create policy sp_sel on public.sale_payments for select using (app.can_cash(app.sale_company(sale_id)));
grant select on public.cash_sessions, public.sales, public.sale_lines, public.sale_payments to authenticated;
-- las escrituras van sólo por las funciones (register_sale, cancel_sale, open_cash, close_cash)

-- Meses de mensualidad ya pagados (por venta o por adelanto) de cada plan asignado
create or replace view public.paid_months with (security_invoker = true) as
  select l.subscription_id, l.month, l.amount_cents, 'venta'::text as via, s.sold_on as paid_on
  from public.sale_lines l join public.sales s on s.id = l.sale_id
  where l.kind = 'mensualidad' and s.cancelled_at is null
  union all
  select subscription_id, month, amount_cents, 'adelanto', null from public.plan_prepaid_months;
grant select on public.paid_months to authenticated;
