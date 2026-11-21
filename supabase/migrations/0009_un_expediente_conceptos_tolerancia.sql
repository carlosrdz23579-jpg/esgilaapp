-- =====================================================================
-- 0009  Una persona = un expediente; checadas de otra sucursal van a su empresa;
--       tolerancia de retardo por empresa; conceptos de pago (hora, día, fijo).
-- =====================================================================

-- ---------- 1) Una cuenta, un expediente (revierte la parte de 0008) ----------
-- Quien trabaja en CAR y a veces va a Viñedos sigue siendo de CAR: toda su nómina sale en CAR.
do $$ begin
  if exists (select user_id from public.employees where user_id is not null group by user_id having count(*) > 1) then
    raise exception 'Hay cuentas ligadas a más de un expediente; desvincula los duplicados antes de aplicar 0009';
  end if;
end $$;
alter table public.employees drop constraint if exists employees_user_company_key;
do $$ begin
  alter table public.employees add constraint employees_user_id_key unique (user_id);
exception when duplicate_object or duplicate_table then null; end $$;

-- ---------- 2) Número de checador -> expediente de cualquier empresa ----------
-- company_id = empresa DUEÑA DEL CHECADOR (de qué aparato viene la checada).
-- employee_id puede ser de otra empresa: esas horas se pagan en la empresa del empleado.
alter table public.checker_ids drop constraint if exists checker_ids_employee_id_company_id_fkey;
do $$ begin
  alter table public.checker_ids add constraint checker_ids_employee_fk foreign key (employee_id) references public.employees(id);
exception when duplicate_object then null; end $$;

drop policy if exists chk_select on public.checker_ids;
create policy chk_select on public.checker_ids for select
  using (app.has_perm('payroll_hours','view', company_id));
drop policy if exists chk_insert on public.checker_ids;
create policy chk_insert on public.checker_ids for insert
  with check (app.has_perm('payroll_hours','configure', company_id)
              and (employee_id is null or app.emp_perm('payroll_hours','edit', employee_id)));
drop policy if exists chk_update on public.checker_ids;
create policy chk_update on public.checker_ids for update
  using (app.has_perm('payroll_hours','configure', company_id))
  with check (app.has_perm('payroll_hours','configure', company_id)
              and (employee_id is null or app.emp_perm('payroll_hours','edit', employee_id)));

-- ---------- 3) Tolerancia de retardo por empresa ----------
alter table public.companies
  add column if not exists late_tolerance_min smallint not null default 15 check (late_tolerance_min between 0 and 120);

-- ---------- 4) Conceptos de pago (reemplaza el uso directo de employee_compensation_history) ----------
-- Una persona puede tener varios conceptos a la vez, p. ej. el portero:
--   'Portero'  por_dia  $X  lunes a domingo
--   'Limpieza' por_dia  $Y  lunes a viernes
-- kind:
--   por_hora : amount_cents por hora trabajada dentro de su horario
--   por_dia  : amount_cents por cada día con asistencia, en los días de la semana indicados
--   fijo     : amount_cents por periodo de pago (semana o quincena), sin importar horas
-- Solo-agregar: un cambio es una fila nueva con su vigencia; terminar = nueva fila con active=false.
create table if not exists public.compensation_concepts (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  employee_id    uuid not null,
  concept_key    text not null check (concept_key ~ '^[a-z0-9_]{1,40}$'),   -- identifica el concepto a lo largo del tiempo
  label          text not null check (length(trim(label)) > 0),
  kind           text not null check (kind in ('por_hora', 'por_dia', 'fijo')),
  amount_cents   bigint not null check (amount_cents >= 0),
  weekdays       smallint[] not null default '{0,1,2,3,4,5,6}'
                 check (cardinality(weekdays) between 1 and 7 and weekdays <@ '{0,1,2,3,4,5,6}'::smallint[]),
  active         boolean not null default true,
  effective_from date not null,
  reason         text not null check (length(trim(reason)) > 0),
  created_by     uuid references public.app_users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  unique (employee_id, concept_key, effective_from),
  foreign key (employee_id, company_id) references public.employees(id, company_id)
);
create index if not exists cc_emp_idx on public.compensation_concepts (employee_id, concept_key, effective_from desc);

-- Lo que ya se capturó como pago por hora se vuelve el concepto 'hora'.
insert into public.compensation_concepts (company_id, employee_id, concept_key, label, kind, amount_cents, effective_from, reason, created_by, created_at)
select h.company_id, h.employee_id, 'hora', 'Pago por hora', 'por_hora', h.hourly_rate_cents, h.effective_from,
       'Migrado del historial de pago por hora', h.created_by, h.created_at
from public.employee_compensation_history h
on conflict (employee_id, concept_key, effective_from) do nothing;

drop trigger if exists trg_cc_immutable on public.compensation_concepts;
create trigger trg_cc_immutable before update or delete on public.compensation_concepts
  for each row execute function app.block_mutation();
drop trigger if exists aud_cc on public.compensation_concepts;
create trigger aud_cc after insert on public.compensation_concepts for each row execute function app.audit();

alter table public.compensation_concepts enable row level security;
drop policy if exists cc_select on public.compensation_concepts;
create policy cc_select on public.compensation_concepts for select
  using (app.emp_perm('salary','view', employee_id) or employee_id = app.my_employee_id(company_id));
drop policy if exists cc_insert on public.compensation_concepts;
create policy cc_insert on public.compensation_concepts for insert
  with check (app.emp_perm('salary','edit', employee_id));
grant select, insert on public.compensation_concepts to authenticated;

-- Conceptos vigentes de un empleado en una fecha (respeta RLS).
create or replace function app.concepts_at(p_employee uuid, p_date date)
returns setof public.compensation_concepts language sql stable as $$
  select distinct on (concept_key) * from public.compensation_concepts
  where employee_id = p_employee and effective_from <= p_date
  order by concept_key, effective_from desc, created_at desc
$$;

grant execute on all functions in schema app to authenticated;
