-- =====================================================================
-- 0037  Pago por adelantado de planes. Repetible.
-- Se pagan N meses de un plan asignado con un descuento especial (ajustable) y el precio
-- queda congelado esos meses aunque el plan suba. Cada mes cubierto recibe su parte del total
-- (para el reporte de planes); el dinero entra completo el día en que se pagó (flujo de caja).
-- Si la alumna tiene beca, no lleva el descuento especial (sólo el precio congelado).
-- =====================================================================
alter table public.billing_rules add column if not exists prepay_bps int not null default 1500 check (prepay_bps between 0 and 10000);

create table if not exists public.plan_prepayments (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id),
  subscription_id   uuid not null references public.subscriptions(id),
  from_month        date not null check (extract(day from from_month) = 1),
  months            int  not null check (months between 1 and 24),
  price_cents       bigint not null check (price_cents >= 0),       -- precio mensual congelado
  discount_bps      int  not null default 0 check (discount_bps between 0 and 10000),
  total_cents       bigint not null check (total_cents >= 0),
  payment_method_id uuid references public.payment_methods(id),
  paid_on           date not null default app.today_mx(),
  note              text,
  author_name       text,
  created_by        uuid references public.app_users(id) default auth.uid(),
  created_at        timestamptz not null default now(),
  cancelled_at      timestamptz,
  cancelled_by      uuid references public.app_users(id)
);
create index if not exists ppay_sub on public.plan_prepayments (subscription_id, from_month);

-- Meses cubiertos y lo que le toca a cada uno (reparte el sobrante de centavos en los primeros meses)
create or replace view public.plan_prepaid_months with (security_invoker = true) as
  select p.id as prepayment_id, p.company_id, p.subscription_id, (p.from_month + make_interval(months => g.i))::date as month,
         p.price_cents, p.discount_bps,
         (p.total_cents / p.months) + case when g.i < (p.total_cents % p.months) then 1 else 0 end as amount_cents
  from public.plan_prepayments p cross join lateral generate_series(0, p.months - 1) as g(i)
  where p.cancelled_at is null;

create or replace function app.guard_prepayment() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare s public.subscriptions; last_m date; gross bigint;
begin
  if tg_op = 'DELETE' then raise exception 'Un pago por adelantado no se borra: se cancela'; end if;
  if tg_op = 'UPDATE' then
    if (new.subscription_id, new.from_month, new.months, new.price_cents, new.discount_bps, new.total_cents, new.paid_on, new.created_at)
       is distinct from (old.subscription_id, old.from_month, old.months, old.price_cents, old.discount_bps, old.total_cents, old.paid_on, old.created_at)
       or old.cancelled_at is not null then
      raise exception 'Un pago por adelantado no se edita: cancélalo y captúralo de nuevo';
    end if;
    new.cancelled_by := coalesce(auth.uid(), new.cancelled_by);
    return new;
  end if;
  select * into s from public.subscriptions where id = new.subscription_id;
  if s.cancelled_at is not null then raise exception 'Ese plan está cancelado'; end if;
  new.company_id := s.company_id;
  last_m := (new.from_month + make_interval(months => new.months - 1))::date;
  if new.from_month < s.start_month then raise exception 'El plan empieza en %; el adelanto no puede ser antes', to_char(s.start_month, 'MM/YYYY'); end if;
  if s.end_month is not null and last_m > s.end_month then raise exception 'El plan termina en %; extiéndelo o ajusta los meses', to_char(s.end_month, 'MM/YYYY'); end if;
  if exists (select 1 from public.plan_prepaid_months m where m.subscription_id = new.subscription_id and m.month between new.from_month and last_m) then
    raise exception 'Alguno de esos meses ya está pagado por adelantado';
  end if;
  -- con beca en alguno de esos meses no hay descuento especial
  if new.discount_bps > 0 and exists (select 1 from public.subscription_adjustments a where a.subscription_id = new.subscription_id and a.kind = 'beca'
       and a.cancelled_at is null and a.from_month <= last_m and (a.to_month is null or a.to_month >= new.from_month)) then
    raise exception 'Tiene beca en esos meses: no puede llevar otro descuento (pon 0 %%)';
  end if;
  gross := new.price_cents * new.months;
  if new.total_cents <> gross - round(gross * new.discount_bps / 10000.0) then raise exception 'El total no cuadra con el precio, los meses y el descuento'; end if;
  if not app.is_backoffice() then new.created_by := auth.uid(); end if;
  new.author_name := app.author_name(new.created_by);
  return new;
end $$;
drop trigger if exists trg_guard_ppay on public.plan_prepayments;
create trigger trg_guard_ppay before insert or update or delete on public.plan_prepayments for each row execute function app.guard_prepayment();
drop trigger if exists aud_plan_prepayments on public.plan_prepayments;
create trigger aud_plan_prepayments after insert or update on public.plan_prepayments for each row execute function app.audit();

alter table public.plan_prepayments enable row level security;
drop policy if exists ppay_sel on public.plan_prepayments; create policy ppay_sel on public.plan_prepayments for select using (app.can_billing(company_id));
drop policy if exists ppay_ins on public.plan_prepayments; create policy ppay_ins on public.plan_prepayments for insert with check (app.has_perm('billing','edit',app.sub_company(subscription_id)));
drop policy if exists ppay_upd on public.plan_prepayments; create policy ppay_upd on public.plan_prepayments for update using (app.has_perm('billing','edit',company_id)) with check (true);
grant select, insert, update on public.plan_prepayments to authenticated;
grant select on public.plan_prepaid_months to authenticated;
