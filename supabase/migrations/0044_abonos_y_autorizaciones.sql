-- =====================================================================
-- 0044  Pagos incompletos (queda adeudo y se abona después), cancelación de ventas
--       con autorización, y productos que se editan y se eliminan con historial. Repetible.
-- =====================================================================

-- ---------- Abonos: cada pago guarda cuándo, en qué caja y quién lo cobró ----------
alter table public.sale_payments add column if not exists paid_at     timestamptz not null default now();
alter table public.sale_payments add column if not exists paid_on     date not null default app.today_mx();
alter table public.sale_payments add column if not exists session_id  uuid references public.cash_sessions(id);
alter table public.sale_payments add column if not exists created_by  uuid references public.app_users(id) default auth.uid();
alter table public.sale_payments add column if not exists author_name text;
alter table public.sale_payments add column if not exists is_installment boolean not null default false;   -- abono posterior a la venta
update public.sale_payments p set paid_at = s.sold_at, paid_on = s.sold_on, session_id = s.session_id, created_by = s.created_by, author_name = s.seller_name
  from public.sales s where s.id = p.sale_id and p.session_id is null and p.is_installment = false;
create index if not exists sp_paid_on on public.sale_payments (paid_on);

-- Lo que falta por pagar de cada recibo
create or replace view public.sale_balances with (security_invoker = true) as
  select s.id as sale_id, s.company_id, s.student_id, s.folio, s.sold_on, s.total_cents,
         coalesce((select sum(p.amount_cents) from public.sale_payments p where p.sale_id = s.id), 0) as paid_cents,
         s.total_cents - coalesce((select sum(p.amount_cents) from public.sale_payments p where p.sale_id = s.id), 0) as balance_cents
  from public.sales s where s.cancelled_at is null;
grant select on public.sale_balances to authenticated;

-- ---------- Cancelación con autorización ----------
alter table public.sales add column if not exists cancel_requested_at   timestamptz;
alter table public.sales add column if not exists cancel_requested_by   uuid references public.app_users(id);
alter table public.sales add column if not exists cancel_requested_name text;
alter table public.sales add column if not exists cancel_request_reason text;
alter table public.sales add column if not exists cancelled_name        text;

-- ---------- Registrar venta: ahora acepta pagar menos (queda adeudo de la alumna) ----------
create or replace function public.register_sale(p_company uuid, p_student uuid, p_customer text, p_lines jsonb, p_payments jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, app as $$
declare sess uuid; sale uuid; fol int; l jsonb; total bigint := 0; paid bigint := 0; credit bigint; used bigint := 0; me text := app.author_name(auth.uid());
begin
  if not app.has_perm('cashbox','edit',p_company) then raise exception 'Sin permiso para cobrar'; end if;
  perform app.close_stale_sessions(p_company);
  select id into sess from public.cash_sessions where company_id = p_company and opened_by = auth.uid() and closed_at is null;
  if sess is null then raise exception 'Abre tu caja antes de cobrar'; end if;
  if jsonb_array_length(coalesce(p_lines, '[]')) = 0 then raise exception 'La venta no tiene nada'; end if;
  select coalesce(sum((x->>'amount_cents')::bigint), 0) into total from jsonb_array_elements(p_lines) x;
  select coalesce(sum((x->>'amount_cents')::bigint), 0) into paid from jsonb_array_elements(coalesce(p_payments, '[]')) x;
  if paid > total then raise exception 'Lo pagado (%) es más que el total (%)', paid / 100.0, total / 100.0; end if;
  if paid < total and p_student is null then raise exception 'Una venta de mostrador se paga completa; para dejar adeudo elige a la alumna'; end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    if l->>'kind' = 'mensualidad' then
      if exists (select 1 from public.sale_lines x join public.sales s on s.id = x.sale_id
                 where x.kind = 'mensualidad' and x.subscription_id = (l->>'subscription_id')::uuid and x.month = (l->>'month')::date and s.cancelled_at is null)
         or exists (select 1 from public.plan_prepaid_months m where m.subscription_id = (l->>'subscription_id')::uuid and m.month = (l->>'month')::date) then
        raise exception 'La mensualidad de % ya está cobrada', to_char((l->>'month')::date, 'MM/YYYY');
      end if;
    end if;
    if l->>'kind' = 'saldo_favor' and p_student is null then raise exception 'El saldo a favor necesita una alumna'; end if;
  end loop;
  select coalesce(sum((x->>'amount_cents')::bigint), 0) into used from jsonb_array_elements(coalesce(p_payments, '[]')) x
    join public.payment_methods m on m.id = (x->>'payment_method_id')::uuid where m.name = 'Saldo a favor';
  if used > 0 then
    credit := app.student_credit(p_student);
    if p_student is null or used > credit then raise exception 'No tiene suficiente saldo a favor (tiene %)', coalesce(credit, 0) / 100.0; end if;
  end if;
  insert into public.folio_counters (company_id, last) values (p_company, 1)
    on conflict (company_id) do update set last = folio_counters.last + 1 returning last into fol;
  insert into public.sales (company_id, folio, session_id, student_id, customer_name, total_cents, note, seller_name)
    values (p_company, fol, sess, p_student, nullif(trim(p_customer), ''), total, nullif(trim(p_note), ''), me) returning id into sale;
  insert into public.sale_lines (sale_id, kind, student_id, subscription_id, month, product_id, year, qty, description, base_cents, discount_cents, surcharge_cents, amount_cents, detail)
    select sale, x->>'kind', nullif(x->>'student_id','')::uuid, nullif(x->>'subscription_id','')::uuid, nullif(x->>'month','')::date, nullif(x->>'product_id','')::uuid,
           nullif(x->>'year','')::int, coalesce(nullif(x->>'qty','')::numeric, 1), x->>'description',
           coalesce((x->>'base_cents')::bigint, (x->>'amount_cents')::bigint - coalesce((x->>'surcharge_cents')::bigint, 0) + coalesce((x->>'discount_cents')::bigint, 0)),
           coalesce((x->>'discount_cents')::bigint, 0), coalesce((x->>'surcharge_cents')::bigint, 0), (x->>'amount_cents')::bigint, coalesce(x->'detail', '{}'::jsonb)
    from jsonb_array_elements(p_lines) x;
  insert into public.sale_payments (sale_id, payment_method_id, amount_cents, reference, session_id, author_name)
    select sale, (x->>'payment_method_id')::uuid, (x->>'amount_cents')::bigint, nullif(x->>'reference', ''), sess, me
    from jsonb_array_elements(coalesce(p_payments, '[]')) x where (x->>'amount_cents')::bigint > 0;
  return sale;
end $$;

-- Abonar a un recibo con saldo pendiente
create or replace function public.add_payment(p_sale uuid, p_method uuid, p_amount bigint, p_reference text default null)
returns void language plpgsql security definer set search_path = public, app as $$
declare s public.sales; sess uuid; bal bigint;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or s.cancelled_at is not null then raise exception 'Ese recibo no existe o está cancelado'; end if;
  if not app.has_perm('cashbox','edit',s.company_id) then raise exception 'Sin permiso para cobrar'; end if;
  perform app.close_stale_sessions(s.company_id);
  select id into sess from public.cash_sessions where company_id = s.company_id and opened_by = auth.uid() and closed_at is null;
  if sess is null then raise exception 'Abre tu caja antes de cobrar'; end if;
  select balance_cents into bal from public.sale_balances where sale_id = p_sale;
  if p_amount is null or p_amount <= 0 then raise exception 'Pon cuánto abona'; end if;
  if p_amount > bal then raise exception 'El abono (%) es más de lo que debe (%)', p_amount / 100.0, bal / 100.0; end if;
  if (select name from public.payment_methods where id = p_method) = 'Saldo a favor' and app.student_credit(s.student_id) < p_amount then
    raise exception 'No tiene suficiente saldo a favor';
  end if;
  insert into public.sale_payments (sale_id, payment_method_id, amount_cents, reference, session_id, author_name, is_installment)
    values (p_sale, p_method, p_amount, nullif(trim(p_reference), ''), sess, app.author_name(auth.uid()), true);
end $$;
grant execute on function public.add_payment(uuid, uuid, bigint, text) to authenticated;

-- Pedir que se cancele (quien cobró o cualquiera que cobra) → lo autoriza quien tenga Caja → Configurar
create or replace function public.request_cancel_sale(p_sale uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $$
declare s public.sales;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or s.cancelled_at is not null then raise exception 'Ese recibo no existe o ya está cancelado'; end if;
  if not app.has_perm('cashbox','edit',s.company_id) then raise exception 'Sin permiso'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Escribe el motivo'; end if;
  update public.sales set cancel_requested_at = now(), cancel_requested_by = auth.uid(), cancel_requested_name = app.author_name(auth.uid()),
    cancel_request_reason = trim(p_reason) where id = p_sale;
end $$;
grant execute on function public.request_cancel_sale(uuid, text) to authenticated;

-- Cancelar (autorizar): sólo con Caja → Configurar
create or replace function public.cancel_sale(p_sale uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $$
declare s public.sales; fav bigint;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or s.cancelled_at is not null then raise exception 'Esa venta no existe o ya estaba cancelada'; end if;
  if not app.has_perm('cashbox','configure',s.company_id) then raise exception 'Cancelar una venta necesita autorización (permiso Caja → Configurar)'; end if;
  if length(trim(coalesce(p_reason, s.cancel_request_reason, ''))) < 3 then raise exception 'Escribe el motivo de la cancelación'; end if;
  select coalesce(sum(amount_cents), 0) into fav from public.sale_lines where sale_id = p_sale and kind = 'saldo_favor';
  if fav > 0 and app.student_credit(s.student_id) < fav then raise exception 'No se puede cancelar: ya se usó el saldo a favor que generó esta venta'; end if;
  update public.sales set cancelled_at = now(), cancelled_by = auth.uid(), cancelled_name = app.author_name(auth.uid()),
    cancel_reason = coalesce(nullif(trim(p_reason), ''), cancel_request_reason) where id = p_sale;
end $$;

create or replace function public.reject_cancel_sale(p_sale uuid) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  if not app.has_perm('cashbox','configure',(select company_id from public.sales where id = p_sale)) then raise exception 'Sin permiso'; end if;
  update public.sales set cancel_requested_at = null, cancel_requested_by = null, cancel_requested_name = null, cancel_request_reason = null where id = p_sale and cancelled_at is null;
end $$;
grant execute on function public.reject_cancel_sale(uuid) to authenticated;

-- El saldo a favor no cuenta pagos de recibos cancelados (ya lo hacía) ni abonos con saldo a favor de recibos cancelados
create or replace function app.student_credit(p_student uuid) returns bigint
language sql stable security definer set search_path = public, app as $$
  select coalesce((select sum(l.amount_cents) from public.sale_lines l join public.sales s on s.id = l.sale_id
                    where l.kind = 'saldo_favor' and l.student_id = p_student and s.cancelled_at is null), 0)
       - coalesce((select sum(p.amount_cents) from public.sale_payments p join public.sales s on s.id = p.sale_id
                    join public.payment_methods m on m.id = p.payment_method_id
                    where m.name = 'Saldo a favor' and s.student_id = p_student and s.cancelled_at is null), 0);
$$;

-- ---------- Productos: editar y eliminar (queda en el historial) ----------
alter table public.products add column if not exists deleted_at timestamptz;
alter table public.products add column if not exists deleted_by uuid references public.app_users(id);
alter table public.products add column if not exists cost_cents bigint check (cost_cents is null or cost_cents >= 0);
create or replace function app.guard_product() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Los productos no se borran: se eliminan y quedan en el historial'; end if;
  if tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is not null then raise exception 'Ese producto está eliminado; restáuralo para cambiarlo'; end if;
  if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null then new.deleted_by := auth.uid(); new.is_active := false; end if;
  return new;
end $$;
drop trigger if exists trg_guard_product on public.products;
create trigger trg_guard_product before update or delete on public.products for each row execute function app.guard_product();
-- el nombre único sólo entre los no eliminados
alter table public.products drop constraint if exists products_company_id_name_key;
create unique index if not exists products_name_live on public.products (company_id, lower(name)) where deleted_at is null;

-- Historial de un producto (de la auditoría)
create or replace function public.product_history(p_product uuid)
returns table (at timestamptz, who text, action text, old_row jsonb, new_row jsonb)
language sql stable security definer set search_path = public, app as $$
  select a.at, app.author_name(a.user_id), a.action, a.old_row, a.new_row from public.audit_log a
  where a.table_name = 'products' and a.row_id = p_product::text and app.can_billing((select company_id from public.products where id = p_product))
  order by a.at desc;
$$;
grant execute on function public.product_history(uuid) to authenticated;
