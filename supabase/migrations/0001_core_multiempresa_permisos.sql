-- =====================================================================
-- 0001  Núcleo: multiempresa, usuarios, permisos, empleados, salarios, auditoría
-- Etapas 2, 3 y 4 (estructura). SIN EJECUTAR todavía: requiere proyecto Supabase.
-- Convenciones: uuid como identidad; dinero en centavos (bigint); RLS en todo;
-- nadie tiene DELETE (se desactiva, no se borra).
-- =====================================================================

create schema if not exists app;
create extension if not exists pgcrypto;

-- ---------- Tipos ----------
create type app.user_role      as enum ('director','admin','rrhh','empleado');
create type app.user_status    as enum ('pending','active','suspended');
create type app.employee_state as enum ('activo','suspendido','baja');
create type app.perm_module    as enum (
  'companies','employees','salary','payroll','payroll_hours','pay_schedules',
  'reports_financial','reports_shared','cash','complaints','announcements',
  'calendar','chat','users','settings');
create type app.perm_action    as enum
  ('view','create','edit','authorize','delete','export','share','configure');

-- ---------- Usuarios ----------
create table public.app_users (
  id         uuid primary key references auth.users(id) on delete restrict,
  email      text not null,
  full_name  text not null default '',
  role       app.user_role   not null default 'empleado',
  status     app.user_status not null default 'pending',
  created_at timestamptz not null default now()
);

-- Alta automática: toda solicitud de acceso entra como EMPLEADO / PENDIENTE.
create function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  insert into public.app_users (id, email, full_name, role, status)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''), 'empleado', 'pending');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- ---------- Empresas ----------
create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  trade_name  text not null,
  description text,
  address     text,
  contact     jsonb not null default '{}'::jsonb,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.company_fiscal_entities (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  legal_name   text not null,
  rfc          text,
  fiscal_data  jsonb not null default '{}'::jsonb,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table public.departments (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, name),
  unique (id, company_id)                       -- habilita FK compuesta
);

create table public.groups (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  department_id uuid not null,
  name          text not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (department_id, name),
  unique (id, company_id),
  foreign key (department_id, company_id) references public.departments(id, company_id)
);

-- ---------- Empleados (SIN datos salariales) ----------
create table public.employees (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  user_id          uuid unique references public.app_users(id),
  full_name        text not null,
  birth_date       date,
  curp             text,
  rfc              text,
  phone            text,
  email            text,
  address          text,
  hire_date        date,
  department_id    uuid not null,
  group_id         uuid,
  job_title        text,
  contract_type    text,
  state            app.employee_state not null default 'activo',
  pay_frequency_override text check (pay_frequency_override in ('semanal','quincenal','mensual')),
  created_at       timestamptz not null default now(),
  foreign key (department_id, company_id) references public.departments(id, company_id),
  foreign key (group_id, company_id)      references public.groups(id, company_id)
);
create index on public.employees (company_id, state);
create index on public.employees (company_id, lower(full_name));

create table public.employee_state_history (
  id           bigserial primary key,
  employee_id  uuid not null references public.employees(id),
  company_id   uuid not null references public.companies(id),
  from_state   app.employee_state,
  to_state     app.employee_state not null,
  effective_on date not null default current_date,
  reason       text,
  changed_by   uuid references public.app_users(id) default auth.uid(),
  changed_at   timestamptz not null default now()
);

-- ---------- Historial salarial (append-only) ----------
create table public.employee_compensation_history (
  id                  bigserial primary key,
  employee_id         uuid not null references public.employees(id),
  company_id          uuid not null references public.companies(id),
  hourly_rate_cents   bigint not null check (hourly_rate_cents >= 0),
  previous_rate_cents bigint,
  effective_from      date not null,
  created_by          uuid references public.app_users(id),
  created_at          timestamptz not null default now(),
  unique (employee_id, effective_from)
);

-- ---------- Permisos individuales ----------
create table public.permission_grants (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.app_users(id),
  module        app.perm_module not null,
  action        app.perm_action not null,
  company_id    uuid references public.companies(id),    -- NULL = todas
  department_id uuid references public.departments(id), -- NULL = sin restricción
  group_id      uuid references public.groups(id),
  employee_id   uuid references public.employees(id),
  granted_by    uuid references public.app_users(id),
  created_at    timestamptz not null default now()
);
create index on public.permission_grants (user_id, module, action);

-- ---------- Auditoría ----------
create table public.audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  company_id uuid,
  table_name text not null,
  row_id     text,
  action     text not null,
  old_row    jsonb,
  new_row    jsonb
);

create function app.audit() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.audit_log (user_id, company_id, table_name, row_id, action, old_row, new_row)
  values (auth.uid(), nullif(r->>'company_id','')::uuid, tg_table_name, r->>'id', tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

-- ---------- Funciones de autorización ----------
create function app.is_director() returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from public.app_users
                 where id = auth.uid() and role = 'director' and status = 'active');
$$;

-- Evalúa un permiso para un alcance concreto. NULL en el alcance solicitado
-- solo es satisfecho por permisos sin restricción en ese nivel.
create function app.has_perm(
  p_module app.perm_module, p_action app.perm_action,
  p_company uuid, p_dept uuid default null, p_group uuid default null, p_employee uuid default null
) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.is_director() or exists (
    select 1
    from public.permission_grants g
    join public.app_users u on u.id = g.user_id
    where g.user_id = auth.uid()
      and u.status = 'active'
      -- Candado doble: RR.HH. jamás evalúa como autorizado en módulos económicos
      and not (u.role = 'rrhh' and p_module in ('salary','payroll','payroll_hours','reports_financial','cash'))
      and g.module = p_module and g.action = p_action
      and (g.company_id    is null or g.company_id    = p_company)
      and (g.department_id is null or g.department_id = p_dept)
      and (g.group_id      is null or g.group_id      = p_group)
      and (g.employee_id   is null or g.employee_id   = p_employee)
  );
$$;

-- Atajo: permiso sobre un empleado concreto (resuelve su empresa/depto/grupo).
create function app.emp_perm(p_module app.perm_module, p_action app.perm_action, p_employee uuid)
returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (
    select 1 from public.employees e
    where e.id = p_employee
      and app.has_perm(p_module, p_action, e.company_id, e.department_id, e.group_id, e.id));
$$;

create function app.can_see_company(c uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.is_director()
      or exists (select 1 from public.permission_grants g
                 join public.app_users u on u.id = g.user_id
                 where g.user_id = auth.uid() and u.status = 'active'
                   and (g.company_id is null or g.company_id = c))
      or exists (select 1 from public.employees e
                 join public.app_users u on u.id = e.user_id
                 where e.user_id = auth.uid() and e.company_id = c and u.status = 'active');
$$;

create function app.my_employee_id() returns uuid
language sql stable security definer set search_path = public, app as $$
  select e.id from public.employees e
  join public.app_users u on u.id = e.user_id
  where e.user_id = auth.uid() and u.status = 'active';
$$;

-- ---------- Triggers de protección ----------
-- 1) Permisos: nadie se otorga permisos; RR.HH. sin módulos económicos;
--    un admin no puede dar más de lo que tiene.
create function app.guard_grants() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare target_role app.user_role;
begin
  if new.user_id = auth.uid() then
    raise exception 'Nadie puede asignarse permisos a sí mismo';
  end if;
  select role into target_role from public.app_users where id = new.user_id;
  if target_role = 'rrhh' and new.module in ('salary','payroll','payroll_hours','reports_financial','cash') then
    raise exception 'Recursos Humanos no puede recibir permisos económicos (%)', new.module;
  end if;
  if not app.is_director() then
    if not app.has_perm(new.module, new.action, new.company_id, new.department_id, new.group_id, new.employee_id) then
      raise exception 'No puedes otorgar un permiso superior a los que tienes';
    end if;
  end if;
  new.granted_by := auth.uid();
  return new;
end $$;
create trigger trg_guard_grants before insert or update on public.permission_grants
  for each row execute function app.guard_grants();

-- 2) Solo el director cambia roles; nadie cambia el suyo.
create function app.guard_user_update() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if (new.role is distinct from old.role or new.status is distinct from old.status) then
    if not app.is_director() and not app.has_perm('users','edit', null) then
      raise exception 'Sin autorización para cambiar rol o estado';
    end if;
    if new.role is distinct from old.role and not app.is_director() then
      raise exception 'Solo el director puede cambiar perfiles';
    end if;
    if old.id = auth.uid() and not app.is_director() then
      raise exception 'No puedes cambiar tu propio perfil o estado';
    end if;
  end if;
  return new;
end $$;
create trigger trg_guard_user_update before update on public.app_users
  for each row execute function app.guard_user_update();

-- 3) Vincular usuario↔expediente solo con permiso de usuarios, nunca a uno mismo.
create function app.guard_employee_link() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.user_id is distinct from old.user_id then
    if not (app.is_director() or app.has_perm('users','edit', new.company_id)) then
      raise exception 'Sin permiso para vincular usuarios con expedientes';
    end if;
    if new.user_id = auth.uid() and not app.is_director() then
      raise exception 'No puedes vincularte a ti mismo con un expediente';
    end if;
  end if;
  return new;
end $$;
create trigger trg_guard_employee_link before update on public.employees
  for each row execute function app.guard_employee_link();

-- 4) Identificadores inalterables.
create function app.freeze_id() returns trigger language plpgsql as $$
begin
  if new.id is distinct from old.id then raise exception 'El identificador no puede modificarse'; end if;
  return new;
end $$;
create trigger trg_freeze_companies before update on public.companies for each row execute function app.freeze_id();
create trigger trg_freeze_employees before update on public.employees for each row execute function app.freeze_id();

-- 5) Historial salarial: append-only y con "importe anterior" automático.
create function app.comp_before_insert() returns trigger language plpgsql
security definer set search_path = public, app as $$
begin
  select hourly_rate_cents into new.previous_rate_cents
  from public.employee_compensation_history
  where employee_id = new.employee_id and effective_from < new.effective_from
  order by effective_from desc limit 1;
  new.created_by := auth.uid();
  return new;
end $$;
create trigger trg_comp_before_insert before insert on public.employee_compensation_history
  for each row execute function app.comp_before_insert();

create function app.block_mutation() returns trigger language plpgsql as $$
begin raise exception 'Tabla de solo-agregar: no se permite % en %', tg_op, tg_table_name; end $$;
create trigger trg_comp_immutable before update or delete on public.employee_compensation_history
  for each row execute function app.block_mutation();
create trigger trg_statehist_immutable before update or delete on public.employee_state_history
  for each row execute function app.block_mutation();
create trigger trg_audit_immutable before update or delete on public.audit_log
  for each row execute function app.block_mutation();

-- 6) Cambio de estado del empleado queda en historial.
create function app.log_employee_state() returns trigger language plpgsql
security definer set search_path = public, app as $$
begin
  if tg_op = 'INSERT' or new.state is distinct from old.state then
    insert into public.employee_state_history (employee_id, company_id, from_state, to_state)
    values (new.id, new.company_id, case when tg_op='UPDATE' then old.state end, new.state);
  end if;
  return new;
end $$;
create trigger trg_log_employee_state after insert or update on public.employees
  for each row execute function app.log_employee_state();

-- Auditoría en tablas sensibles
create trigger aud_companies    after insert or update on public.companies    for each row execute function app.audit();
create trigger aud_departments  after insert or update on public.departments  for each row execute function app.audit();
create trigger aud_groups       after insert or update on public.groups       for each row execute function app.audit();
create trigger aud_employees    after insert or update on public.employees    for each row execute function app.audit();
create trigger aud_grants       after insert or update on public.permission_grants for each row execute function app.audit();
create trigger aud_users        after update on public.app_users for each row execute function app.audit();
create trigger aud_comp         after insert on public.employee_compensation_history for each row execute function app.audit();

-- Tarifa vigente a una fecha (security invoker: respeta RLS salarial).
create function app.rate_at(p_employee uuid, p_date date) returns bigint
language sql stable as $$
  select hourly_rate_cents from public.employee_compensation_history
  where employee_id = p_employee and effective_from <= p_date
  order by effective_from desc limit 1;
$$;

-- =====================================================================
-- RLS (sin políticas de DELETE: nadie borra)
-- =====================================================================
alter table public.app_users                     enable row level security;
alter table public.companies                     enable row level security;
alter table public.company_fiscal_entities       enable row level security;
alter table public.departments                   enable row level security;
alter table public.groups                        enable row level security;
alter table public.employees                     enable row level security;
alter table public.employee_state_history        enable row level security;
alter table public.employee_compensation_history enable row level security;
alter table public.permission_grants             enable row level security;
alter table public.audit_log                     enable row level security;

-- app_users
create policy users_select on public.app_users for select
  using (id = auth.uid() or app.has_perm('users','view', null));
create policy users_update on public.app_users for update
  using (app.is_director() or app.has_perm('users','edit', null))
  with check (app.is_director() or app.has_perm('users','edit', null));

-- companies
create policy co_select on public.companies for select using (app.can_see_company(id));
create policy co_insert on public.companies for insert with check (app.has_perm('companies','create', null));
create policy co_update on public.companies for update
  using (app.has_perm('companies','edit', id)) with check (app.has_perm('companies','edit', id));

create policy fe_select on public.company_fiscal_entities for select using (app.has_perm('companies','view', company_id));
create policy fe_insert on public.company_fiscal_entities for insert with check (app.has_perm('companies','edit', company_id));
create policy fe_update on public.company_fiscal_entities for update
  using (app.has_perm('companies','edit', company_id)) with check (app.has_perm('companies','edit', company_id));

-- departments / groups
create policy dep_select on public.departments for select using (app.can_see_company(company_id));
create policy dep_insert on public.departments for insert with check (app.has_perm('companies','configure', company_id));
create policy dep_update on public.departments for update
  using (app.has_perm('companies','configure', company_id)) with check (app.has_perm('companies','configure', company_id));
create policy grp_select on public.groups for select using (app.can_see_company(company_id));
create policy grp_insert on public.groups for insert with check (app.has_perm('companies','configure', company_id, department_id));
create policy grp_update on public.groups for update
  using (app.has_perm('companies','configure', company_id, department_id))
  with check (app.has_perm('companies','configure', company_id, department_id));

-- employees (sin salario)
create policy emp_select on public.employees for select
  using (user_id = auth.uid() or app.has_perm('employees','view', company_id, department_id, group_id, id));
create policy emp_insert on public.employees for insert
  with check (app.has_perm('employees','create', company_id, department_id, group_id, null));
create policy emp_update on public.employees for update
  using (app.has_perm('employees','edit', company_id, department_id, group_id, id))
  with check (app.has_perm('employees','edit', company_id, department_id, group_id, id));

create policy esh_select on public.employee_state_history for select
  using (app.emp_perm('employees','view', employee_id));

-- salario: SOLO con permiso 'salary' (RR.HH. nunca lo obtiene)
create policy comp_select on public.employee_compensation_history for select
  using (app.emp_perm('salary','view', employee_id));
create policy comp_insert on public.employee_compensation_history for insert
  with check (app.emp_perm('salary','edit', employee_id));

-- permisos
create policy pg_select on public.permission_grants for select
  using (user_id = auth.uid() or app.is_director() or app.has_perm('users','view', company_id));
create policy pg_insert on public.permission_grants for insert
  with check (app.is_director() or app.has_perm('users','configure', company_id));
create policy pg_update on public.permission_grants for update
  using (app.is_director()) with check (app.is_director());

-- auditoría: solo director (contiene datos salariales en JSON)
create policy audit_select on public.audit_log for select using (app.is_director());
