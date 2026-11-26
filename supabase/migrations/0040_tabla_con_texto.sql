-- =====================================================================
-- 0040  Tabla de precios con renglones de texto (Equipo, Pre-Equipo, Equipo libre…),
-- además de los de horas. Un plan sin horas toma el precio del renglón de texto que
-- tenga en table_label. Repetible.
-- =====================================================================
alter table public.hour_prices alter column hours drop not null;
alter table public.hour_prices add column if not exists label text check (label is null or length(trim(label)) > 0);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'hour_prices_key_chk') then
    alter table public.hour_prices add constraint hour_prices_key_chk check ((hours is null) <> (label is null));
  end if;
end $$;
create index if not exists hp_label on public.hour_prices (company_id, lower(label), effective_month desc, created_at desc);

create or replace function app.hour_price(p_company uuid, p_hours numeric, p_month date) returns bigint
language sql stable security definer set search_path = public, app as $$
  select price_cents from public.hour_prices where company_id = p_company and label is null and hours = p_hours
    and effective_month <= date_trunc('month', p_month)::date order by effective_month desc, created_at desc limit 1;
$$;
create or replace function app.label_price(p_company uuid, p_label text, p_month date) returns bigint
language sql stable security definer set search_path = public, app as $$
  select price_cents from public.hour_prices where company_id = p_company and lower(label) = lower(trim(p_label))
    and effective_month <= date_trunc('month', p_month)::date order by effective_month desc, created_at desc limit 1;
$$;

alter table public.plans add column if not exists table_label text;

create or replace function app.plan_price(p_plan uuid, p_month date) returns bigint
language sql stable security definer set search_path = public, app as $$
  select case
    when p.use_table and p.table_label is not null then app.label_price(p.company_id, p.table_label, p_month)
    when p.use_table and p.hours_per_week is not null then app.hour_price(p.company_id, p.hours_per_week, p_month)
    else (select price_cents from public.plan_prices where plan_id = p.id and effective_month <= date_trunc('month', p_month)::date
          order by effective_month desc, created_at desc limit 1) end
  from public.plans p where p.id = p_plan;
$$;

drop view if exists public.hour_prices_current;
create view public.hour_prices_current with (security_invoker = true) as
  select distinct on (company_id, hours, lower(label)) company_id, hours, label, effective_month, price_cents
  from public.hour_prices where effective_month <= date_trunc('month', app.today_mx())::date
  order by company_id, hours, lower(label), effective_month desc, created_at desc;
grant select on public.hour_prices_current to authenticated;

drop view if exists public.plans_v;
create view public.plans_v with (security_invoker = true) as
  select p.*, app.plan_price(p.id, app.today_mx()) as price_cents,
    (select count(*) from public.subscriptions s where s.plan_id = p.id and s.cancelled_at is null
       and s.start_month <= date_trunc('month', app.today_mx()) and (s.end_month is null or s.end_month >= date_trunc('month', app.today_mx()))) as active_subs
  from public.plans p;
grant select on public.plans_v to authenticated;
