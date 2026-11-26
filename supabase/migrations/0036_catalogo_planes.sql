-- =====================================================================
-- 0036  Cobranza, etapa 1: catálogo y asignación de planes.  Requiere 0035. Repetible.
--   billing_rules        pronto pago, hermanos, día límite y recargos, por sucursal
--   annual_fees          anualidad por sucursal y año
--   payment_methods      formas de pago (se pueden agregar)
--   plans / plan_prices  planes (servicios) con historial de precio por mes
--   products             ventas: indumentaria, accesorios, tiendita…
--   class_groups         + cupo y disciplina; se pueden crear a mano (no sólo de EVO)
--   families             para descuento de hermanos (vale entre sucursales) y planes familiares
--   subscriptions        plan asignado (individual a una alumna o familiar a una familia)
--   subscription_members quién va en qué grupo y qué días (cuenta para el cupo y el pase de lista)
--   subscription_adjustments  becas y descuentos recurrentes (% o cantidad, un mes o indefinidos)
--   adjustment_skips     meses en que una beca/descuento no aplica (pausa de un mes)
-- =====================================================================

-- ---------- Reglas de cobro ----------
create table if not exists public.billing_rules (
  company_id     uuid primary key references public.companies(id),
  early_bps      int not null default 500  check (early_bps between 0 and 10000),
  sibling_bps    int not null default 1500 check (sibling_bps between 0 and 10000),
  due_day        int not null default 5    check (due_day between 1 and 28),
  surcharge1_day int not null default 6    check (surcharge1_day between 1 and 31),
  surcharge1_bps int not null default 500  check (surcharge1_bps between 0 and 10000),
  surcharge2_day int not null default 11   check (surcharge2_day between 1 and 31),
  surcharge2_bps int not null default 1000 check (surcharge2_bps between 0 and 10000),
  updated_at     timestamptz not null default now(),
  check (surcharge2_day > surcharge1_day and surcharge1_day > due_day)
);
insert into public.billing_rules (company_id) select id from public.companies on conflict do nothing;

create table if not exists public.annual_fees (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  year         int  not null check (year between 2020 and 2100),
  amount_cents bigint not null check (amount_cents >= 0),
  created_at   timestamptz not null default now(),
  unique (company_id, year)
);

create table if not exists public.payment_methods (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (length(trim(name)) > 0),
  kind       text not null check (kind in ('efectivo', 'transferencia', 'tarjeta', 'otro')),
  sort       int not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.payment_methods (name, kind, sort) values ('Efectivo','efectivo',1), ('Transferencia','transferencia',2), ('Tarjeta','tarjeta',3)
  on conflict (name) do nothing;

-- ---------- Planes ----------
create table if not exists public.plans (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  discipline     text not null check (length(trim(discipline)) > 0),
  name           text not null check (length(trim(name)) > 0),
  hours_per_week numeric(4,1),
  kind           text not null default 'individual' check (kind in ('individual', 'familiar')),
  max_members    int check (max_members is null or max_members between 2 and 10),
  is_active      boolean not null default true,
  sort           int not null default 0,
  created_at     timestamptz not null default now(),
  unique (company_id, discipline, name),
  check (kind = 'familiar' or max_members is null)
);
create table if not exists public.plan_prices (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references public.plans(id),
  effective_month date not null check (extract(day from effective_month) = 1),
  price_cents     bigint not null check (price_cents >= 0),
  created_by      uuid references public.app_users(id) default auth.uid(),
  created_at      timestamptz not null default clock_timestamp()
);
create index if not exists pp_plan on public.plan_prices (plan_id, effective_month desc, created_at desc);
-- Precio de un plan en un mes: el de vigencia más reciente que no sea posterior (y la última captura de ese mes).
create or replace function app.plan_price(p_plan uuid, p_month date) returns bigint
language sql stable security definer set search_path = public, app as $$
  select price_cents from public.plan_prices where plan_id = p_plan and effective_month <= date_trunc('month', p_month)::date
  order by effective_month desc, created_at desc limit 1;
$$;
-- ---------- Productos (ventas) ----------
create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  category    text not null check (category in ('indumentaria', 'accesorio', 'tiendita', 'evento', 'servicio', 'otro')),
  name        text not null check (length(trim(name)) > 0),
  price_cents bigint not null check (price_cents >= 0),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (company_id, name)
);

-- ---------- Grupos: cupo y disciplina ----------
alter table public.class_groups add column if not exists capacity int check (capacity is null or capacity between 1 and 200);
alter table public.class_groups add column if not exists discipline text;
-- la vista se arma con c.*: hay que rehacerla para que incluya las columnas nuevas
drop view if exists public.class_groups_v;
create view public.class_groups_v with (security_invoker = true) as
  select c.*,
    ((split_part(end_time, ':', 1)::int * 60 + split_part(end_time, ':', 2)::int)
     - (split_part(start_time, ':', 1)::int * 60 + split_part(start_time, ':', 2)::int)) as detected_min,
    coalesce(duration_override_min,
      ((split_part(end_time, ':', 1)::int * 60 + split_part(end_time, ':', 2)::int)
       - (split_part(start_time, ':', 1)::int * 60 + split_part(start_time, ':', 2)::int))) as duration_min
  from public.class_groups c;
grant select on public.class_groups_v to authenticated;

-- ---------- Familias ----------
create table if not exists public.families (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now()
);
alter table public.students add column if not exists family_id uuid references public.families(id);

-- ---------- Planes asignados ----------
create table if not exists public.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  plan_id       uuid not null references public.plans(id),
  student_id    uuid references public.students(id),     -- plan individual
  family_id     uuid references public.families(id),     -- plan familiar
  start_month   date not null check (extract(day from start_month) = 1),
  end_month     date check (end_month is null or extract(day from end_month) = 1),
  replaces_id   uuid references public.subscriptions(id), -- cambio de plan
  note          text,
  created_by    uuid references public.app_users(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,                              -- capturado por error (no cuenta)
  check ((student_id is null) <> (family_id is null)),
  check (end_month is null or end_month >= start_month)
);
create index if not exists sub_student on public.subscriptions (student_id);
create index if not exists sub_family on public.subscriptions (family_id);

create table if not exists public.subscription_members (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id),
  student_id      uuid not null references public.students(id),
  class_id        uuid references public.class_groups(id),
  weekdays        smallint[] not null default '{}',
  created_at      timestamptz not null default now(),
  unique (subscription_id, student_id, class_id)
);
create index if not exists sm_class on public.subscription_members (class_id);

-- Activa en un mes
create or replace function app.sub_active(s public.subscriptions, p_month date) returns boolean
language sql immutable as $$
  select s.cancelled_at is null and s.start_month <= p_month and (s.end_month is null or s.end_month >= p_month);
$$;

-- Lugares ocupados de un grupo en un mes
create or replace function app.group_taken(p_class uuid, p_month date) returns int
language sql stable security definer set search_path = public, app as $$
  select count(distinct m.student_id)::int from public.subscription_members m join public.subscriptions s on s.id = m.subscription_id
  where m.class_id = p_class and app.sub_active(s, date_trunc('month', p_month)::date);
$$;

create or replace function app.guard_sub_member() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare s public.subscriptions; cap int; m date;
begin
  select * into s from public.subscriptions where id = new.subscription_id;
  if new.class_id is not null then
    select capacity into cap from public.class_groups where id = new.class_id;
    m := greatest(s.start_month, date_trunc('month', app.today_mx())::date);
    if cap is not null and app.group_taken(new.class_id, m) >= cap
       and not exists (select 1 from public.subscription_members x join public.subscriptions y on y.id = x.subscription_id
                       where x.class_id = new.class_id and x.student_id = new.student_id and app.sub_active(y, m) and x.id <> new.id) then
      raise exception 'El grupo ya está lleno (cupo %). Sube el cupo en Cobranza → Grupos o elige otro grupo.', cap;
    end if;
  end if;
  if s.student_id is not null and new.student_id <> s.student_id then raise exception 'Un plan individual sólo lleva a su alumna'; end if;
  if s.family_id is not null then
    if not exists (select 1 from public.students where id = new.student_id and family_id = s.family_id) then
      raise exception 'La alumna no es de esa familia';
    end if;
    if (select count(distinct student_id) from public.subscription_members where subscription_id = s.id and student_id <> new.student_id)
       >= coalesce((select max_members from public.plans where id = s.plan_id), 10) then
      raise exception 'El plan familiar ya tiene el máximo de integrantes';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_sm on public.subscription_members;
create trigger trg_guard_sm before insert or update on public.subscription_members for each row execute function app.guard_sub_member();

-- Sólo se cierra (end_month), se cancela o se cambia la nota; lo demás no se edita.
create or replace function app.guard_subscription() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Los planes no se borran: se terminan o se cancelan'; end if;
  if tg_op = 'INSERT' then
    if (select company_id from public.plans where id = new.plan_id) <> new.company_id then raise exception 'El plan es de otra sucursal'; end if;
    if (select kind from public.plans where id = new.plan_id) = 'familiar' and new.family_id is null then raise exception 'Un plan familiar se asigna a una familia'; end if;
    if (select kind from public.plans where id = new.plan_id) = 'individual' and new.student_id is null then raise exception 'Un plan individual se asigna a una alumna'; end if;
    if not app.is_backoffice() then new.created_by := auth.uid(); end if;
    return new;
  end if;
  if (new.company_id, new.plan_id, new.student_id, new.family_id, new.start_month, new.replaces_id, new.created_by, new.created_at)
     is distinct from (old.company_id, old.plan_id, old.student_id, old.family_id, old.start_month, old.replaces_id, old.created_by, old.created_at) then
    raise exception 'Un plan asignado no se edita: termínalo y asigna otro';
  end if;
  if old.cancelled_at is not null then raise exception 'Ese plan ya estaba cancelado'; end if;
  return new;
end $$;
drop trigger if exists trg_guard_sub on public.subscriptions;
create trigger trg_guard_sub before insert or update or delete on public.subscriptions for each row execute function app.guard_subscription();

create or replace view public.plans_v with (security_invoker = true) as
  select p.*, app.plan_price(p.id, app.today_mx()) as price_cents,
    (select count(*) from public.subscriptions s where s.plan_id = p.id and s.cancelled_at is null
       and s.start_month <= date_trunc('month', app.today_mx()) and (s.end_month is null or s.end_month >= date_trunc('month', app.today_mx()))) as active_subs
  from public.plans p;


-- ---------- Becas y descuentos recurrentes ----------
create table if not exists public.subscription_adjustments (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id),
  kind            text not null check (kind in ('beca', 'descuento')),
  label           text not null check (length(trim(label)) > 0),
  mode            text not null check (mode in ('pct', 'monto')),
  value           bigint not null check (value > 0),          -- pct en bps (5000 = 50 %), monto en centavos
  from_month      date not null check (extract(day from from_month) = 1),
  to_month        date check (to_month is null or (extract(day from to_month) = 1 and to_month >= from_month)),   -- null = indefinido
  created_by      uuid references public.app_users(id) default auth.uid(),
  created_at      timestamptz not null default now(),
  cancelled_at    timestamptz,
  check (mode <> 'pct' or value <= 10000)
);
create table if not exists public.adjustment_skips (
  adjustment_id uuid not null references public.subscription_adjustments(id),
  month         date not null check (extract(day from month) = 1),
  created_by    uuid references public.app_users(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  primary key (adjustment_id, month)
);

-- ---------- Auditoría ----------
do $$ declare t text; begin
  foreach t in array array['billing_rules','annual_fees','payment_methods','plans','plan_prices','products','families','subscriptions',
                           'subscription_members','subscription_adjustments','adjustment_skips'] loop
    execute format('drop trigger if exists aud_%1$s on public.%1$s', t);
    execute format('create trigger aud_%1$s after insert or update on public.%1$s for each row execute function app.audit()', t);
  end loop;
end $$;

-- ---------- RLS ----------
create or replace function app.can_billing(c uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.has_perm('billing','view',c) or app.has_perm('billing','edit',c) or app.has_perm('billing','configure',c);
$$;
create or replace function app.sub_company(p_sub uuid) returns uuid
language sql stable security definer set search_path = public, app as $$ select company_id from public.subscriptions where id = p_sub $$;
create or replace function app.adj_company(p_adj uuid) returns uuid
language sql stable security definer set search_path = public, app as $$
  select s.company_id from public.subscription_adjustments a join public.subscriptions s on s.id = a.subscription_id where a.id = p_adj $$;

do $$ declare t text; begin
  foreach t in array array['billing_rules','annual_fees','payment_methods','plans','plan_prices','products','families','subscriptions',
                           'subscription_members','subscription_adjustments','adjustment_skips'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- catálogo: lo ve quien tiene cobranza; lo cambia quien tiene configurar
drop policy if exists br_sel on public.billing_rules; create policy br_sel on public.billing_rules for select using (app.can_billing(company_id));
drop policy if exists br_upd on public.billing_rules; create policy br_upd on public.billing_rules for update using (app.has_perm('billing','configure',company_id)) with check (app.has_perm('billing','configure',company_id));
drop policy if exists br_ins on public.billing_rules; create policy br_ins on public.billing_rules for insert with check (app.has_perm('billing','configure',company_id));

drop policy if exists af_sel on public.annual_fees; create policy af_sel on public.annual_fees for select using (app.can_billing(company_id));
drop policy if exists af_ins on public.annual_fees; create policy af_ins on public.annual_fees for insert with check (app.has_perm('billing','configure',company_id));
drop policy if exists af_upd on public.annual_fees; create policy af_upd on public.annual_fees for update using (app.has_perm('billing','configure',company_id)) with check (app.has_perm('billing','configure',company_id));

drop policy if exists pm_sel on public.payment_methods; create policy pm_sel on public.payment_methods for select using (auth.uid() is not null);
drop policy if exists pm_ins on public.payment_methods; create policy pm_ins on public.payment_methods for insert with check (app.is_director() or exists (select 1 from public.companies c where app.has_perm('billing','configure',c.id)));
drop policy if exists pm_upd on public.payment_methods; create policy pm_upd on public.payment_methods for update using (app.is_director() or exists (select 1 from public.companies c where app.has_perm('billing','configure',c.id))) with check (true);

drop policy if exists pl_sel on public.plans; create policy pl_sel on public.plans for select using (app.can_billing(company_id) or app.can_see_students(company_id));
drop policy if exists pl_ins on public.plans; create policy pl_ins on public.plans for insert with check (app.has_perm('billing','configure',company_id));
drop policy if exists pl_upd on public.plans; create policy pl_upd on public.plans for update using (app.has_perm('billing','configure',company_id)) with check (app.has_perm('billing','configure',company_id));
drop policy if exists ppr_sel on public.plan_prices; create policy ppr_sel on public.plan_prices for select using (app.can_billing((select company_id from public.plans where id = plan_id)));
drop policy if exists ppr_ins on public.plan_prices; create policy ppr_ins on public.plan_prices for insert with check (app.has_perm('billing','configure',(select company_id from public.plans where id = plan_id)));

drop policy if exists pr_sel on public.products; create policy pr_sel on public.products for select using (app.can_billing(company_id) or app.has_perm('cashbox','edit',company_id));
drop policy if exists pr_ins on public.products; create policy pr_ins on public.products for insert with check (app.has_perm('billing','configure',company_id));
drop policy if exists pr_upd on public.products; create policy pr_upd on public.products for update using (app.has_perm('billing','configure',company_id)) with check (app.has_perm('billing','configure',company_id));

drop policy if exists fam_sel on public.families; create policy fam_sel on public.families for select using (exists (select 1 from public.companies c where app.can_billing(c.id) or app.can_see_students(c.id)));
drop policy if exists fam_ins on public.families; create policy fam_ins on public.families for insert with check (exists (select 1 from public.companies c where app.has_perm('billing','edit',c.id)));
drop policy if exists fam_upd on public.families; create policy fam_upd on public.families for update using (exists (select 1 from public.companies c where app.has_perm('billing','edit',c.id))) with check (true);

drop policy if exists sub_sel on public.subscriptions; create policy sub_sel on public.subscriptions for select using (app.can_billing(company_id) or app.can_see_students(company_id));
drop policy if exists sub_ins on public.subscriptions; create policy sub_ins on public.subscriptions for insert with check (app.has_perm('billing','edit',company_id));
drop policy if exists sub_upd on public.subscriptions; create policy sub_upd on public.subscriptions for update using (app.has_perm('billing','edit',company_id)) with check (app.has_perm('billing','edit',company_id));
drop policy if exists sm_sel on public.subscription_members; create policy sm_sel on public.subscription_members for select using (app.can_billing(app.sub_company(subscription_id)) or app.can_see_students(app.sub_company(subscription_id)));
drop policy if exists sm_ins on public.subscription_members; create policy sm_ins on public.subscription_members for insert with check (app.has_perm('billing','edit',app.sub_company(subscription_id)));
drop policy if exists sa_sel on public.subscription_adjustments; create policy sa_sel on public.subscription_adjustments for select using (app.can_billing(app.sub_company(subscription_id)));
drop policy if exists sa_ins on public.subscription_adjustments; create policy sa_ins on public.subscription_adjustments for insert with check (app.has_perm('billing','edit',app.sub_company(subscription_id)));
drop policy if exists sa_upd on public.subscription_adjustments; create policy sa_upd on public.subscription_adjustments for update using (app.has_perm('billing','edit',app.sub_company(subscription_id))) with check (true);
drop policy if exists sk_sel on public.adjustment_skips; create policy sk_sel on public.adjustment_skips for select using (app.can_billing(app.adj_company(adjustment_id)));
drop policy if exists sk_ins on public.adjustment_skips; create policy sk_ins on public.adjustment_skips for insert with check (app.has_perm('billing','edit',app.adj_company(adjustment_id)));

-- Sólo terminar o cancelar becas: no se edita el monto ni las fechas de inicio
create or replace function app.guard_sub_adjustment() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Las becas no se borran: se terminan o se cancelan'; end if;
  if tg_op = 'UPDATE' and (new.subscription_id, new.kind, new.label, new.mode, new.value, new.from_month, new.created_by, new.created_at)
     is distinct from (old.subscription_id, old.kind, old.label, old.mode, old.value, old.from_month, old.created_by, old.created_at) then
    raise exception 'Una beca no se edita: termínala y crea otra';
  end if;
  if tg_op = 'INSERT' and not app.is_backoffice() then new.created_by := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists trg_guard_sa on public.subscription_adjustments;
create trigger trg_guard_sa before insert or update or delete on public.subscription_adjustments for each row execute function app.guard_sub_adjustment();

-- Quien cobra ve a las alumnas y puede ligarlas a una familia y crear grupos
drop policy if exists st_select on public.students;
create policy st_select on public.students for select using (app.can_see_students(company_id) or app.can_billing(company_id));
drop policy if exists st_update on public.students;
create policy st_update on public.students for update using (app.has_perm('students','configure',company_id) or app.has_perm('billing','edit',company_id))
  with check (app.has_perm('students','configure',company_id) or app.has_perm('billing','edit',company_id));
drop policy if exists st_insert on public.students;
create policy st_insert on public.students for insert with check (app.has_perm('students','configure',company_id) or app.has_perm('billing','edit',company_id));
drop policy if exists cg_select on public.class_groups;
create policy cg_select on public.class_groups for select using (app.can_see_students(company_id) or app.can_billing(company_id));
drop policy if exists cg_insert on public.class_groups;
create policy cg_insert on public.class_groups for insert with check (app.has_perm('students','configure',company_id) or app.has_perm('billing','configure',company_id));
drop policy if exists cg_update on public.class_groups;
create policy cg_update on public.class_groups for update using (app.has_perm('students','configure',company_id) or app.has_perm('billing','configure',company_id))
  with check (app.has_perm('students','configure',company_id) or app.has_perm('billing','configure',company_id));

grant select, insert, update on public.billing_rules, public.annual_fees, public.payment_methods, public.plans, public.products, public.families,
  public.subscriptions, public.subscription_adjustments to authenticated;
grant select, insert on public.plan_prices, public.subscription_members, public.adjustment_skips to authenticated;
grant insert on public.students, public.class_groups to authenticated;
grant select on public.plans_v to authenticated;
grant execute on function app.group_taken(uuid, date) to authenticated;
create or replace function public.group_taken(p_class uuid, p_month date) returns int
language sql stable security definer set search_path = public, app as $$ select app.group_taken(p_class, p_month) $$;
grant execute on function public.group_taken(uuid, date) to authenticated;
