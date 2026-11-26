-- =====================================================================
-- 0039  Tabla de precios por horas, por sucursal. Repetible.
-- El precio de un plan depende de las horas por semana (igual en todas las disciplinas):
--   hour_prices  sucursal · horas · desde qué mes · precio  (historial: la vigencia más reciente gana)
--   plans.use_table  true = toma el precio de la tabla por sus horas; false = precio propio (Equipo, etc.)
-- Se precarga la tabla de agosto 2026 (la del letrero de Viñedos) en las sucursales que no tengan,
-- y la anualidad 2026 de $1,560.
-- =====================================================================
create table if not exists public.hour_prices (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  hours           numeric(4,1) not null check (hours > 0),
  effective_month date not null check (extract(day from effective_month) = 1),
  price_cents     bigint check (price_cents is null or price_cents >= 0),   -- null = se quita esa opción desde ese mes
  created_by      uuid references public.app_users(id) default auth.uid(),
  created_at      timestamptz not null default clock_timestamp()
);
create index if not exists hp_company on public.hour_prices (company_id, hours, effective_month desc, created_at desc);

create or replace function app.hour_price(p_company uuid, p_hours numeric, p_month date) returns bigint
language sql stable security definer set search_path = public, app as $$
  select price_cents from public.hour_prices where company_id = p_company and hours = p_hours and effective_month <= date_trunc('month', p_month)::date
  order by effective_month desc, created_at desc limit 1;
$$;

alter table public.plans add column if not exists use_table boolean not null default true;

create or replace function app.plan_price(p_plan uuid, p_month date) returns bigint
language sql stable security definer set search_path = public, app as $$
  select case when p.use_table and p.hours_per_week is not null then app.hour_price(p.company_id, p.hours_per_week, p_month)
         else (select price_cents from public.plan_prices where plan_id = p.id and effective_month <= date_trunc('month', p_month)::date
               order by effective_month desc, created_at desc limit 1) end
  from public.plans p where p.id = p_plan;
$$;
-- la vista de planes se arma con p.*: se rehace para incluir use_table
drop view if exists public.plans_v;
create view public.plans_v with (security_invoker = true) as
  select p.*, app.plan_price(p.id, app.today_mx()) as price_cents,
    (select count(*) from public.subscriptions s where s.plan_id = p.id and s.cancelled_at is null
       and s.start_month <= date_trunc('month', app.today_mx()) and (s.end_month is null or s.end_month >= date_trunc('month', app.today_mx()))) as active_subs
  from public.plans p;
grant select on public.plans_v to authenticated;

-- los planes que ya tenían precio propio capturado lo conservan
update public.plans p set use_table = false where use_table and exists (select 1 from public.plan_prices x where x.plan_id = p.id);

-- vista de la tabla vigente
create or replace view public.hour_prices_current with (security_invoker = true) as
  select distinct on (company_id, hours) company_id, hours, effective_month, price_cents
  from public.hour_prices where effective_month <= date_trunc('month', app.today_mx())::date
  order by company_id, hours, effective_month desc, created_at desc;

drop trigger if exists aud_hour_prices on public.hour_prices;
create trigger aud_hour_prices after insert on public.hour_prices for each row execute function app.audit();
alter table public.hour_prices enable row level security;
drop policy if exists hp_sel on public.hour_prices; create policy hp_sel on public.hour_prices for select using (app.can_billing(company_id) or app.can_see_students(company_id));
drop policy if exists hp_ins on public.hour_prices; create policy hp_ins on public.hour_prices for insert with check (app.has_perm('billing','configure',company_id));
grant select, insert on public.hour_prices to authenticated;
grant select on public.hour_prices_current to authenticated;

-- Precarga (agosto 2026)
insert into public.hour_prices (company_id, hours, effective_month, price_cents)
select c.id, x.h, '2026-08-01', x.p * 100
from public.companies c
cross join (values (1,1180),(1.5,1265),(2,1585),(2.5,1655),(3,2015),(3.5,2095),(4,2170),(4.5,2245),(5,2320),(6,2375),(7,2420),(8,2520),(9,2640),(10,2835),(11,3000),(12,3230)) as x(h, p)
where not exists (select 1 from public.hour_prices hp where hp.company_id = c.id);
insert into public.annual_fees (company_id, year, amount_cents) select id, 2026, 156000 from public.companies on conflict (company_id, year) do nothing;
