-- =====================================================================
-- 0008  Head Coach, personas en dos sucursales, revocar permisos, horarios y números de checador
-- =====================================================================

-- ---------- 1) Claves auxiliares ----------
-- (Una versión anterior de este archivo permitía un expediente por empresa; se descartó: ver 0009.)
do $$ begin
  alter table public.employees add constraint employees_id_company_key unique (id, company_id);   -- para FKs compuestas
exception when duplicate_object or duplicate_table then null; end $$;

drop function if exists app.my_employee_id();
create or replace function app.my_employee_id(c uuid) returns uuid
language sql stable security definer set search_path = public, app as $$
  select e.id from public.employees e join public.app_users u on u.id = e.user_id
  where e.user_id = auth.uid() and e.company_id = c and u.status = 'active';
$$;

-- ---------- 2) Permisos revocables y con origen ----------
alter table public.permission_grants
  add column if not exists revoked_at   timestamptz,
  add column if not exists revoked_by   uuid references public.app_users(id),
  add column if not exists source       text not null default 'manual' check (source in ('manual', 'head_coach')),
  add column if not exists via_employee uuid references public.employees(id);   -- expediente Head Coach que lo origina

-- Un permiso cuenta si no está revocado y, si viene de ser Head Coach, solo mientras lo siga siendo.
create or replace function app.grant_alive(g public.permission_grants) returns boolean
language sql stable security definer set search_path = public, app as $$
  select g.revoked_at is null and (g.via_employee is null or exists (
    select 1 from public.employees e where e.id = g.via_employee and e.is_head_coach and e.state = 'activo'));
$$;

create or replace function app.has_perm(
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
      and app.grant_alive(g)
      and not (u.role = 'rrhh' and p_module in ('salary','payroll','payroll_hours','reports_financial','cash'))
      and g.module = p_module and g.action = p_action
      and (g.company_id    is null or g.company_id    = p_company)
      and (g.department_id is null or g.department_id = p_dept)
      and (g.group_id      is null or g.group_id      = p_group)
      and (g.employee_id   is null or g.employee_id   = p_employee)
  );
$$;

create or replace function app.can_see_company(c uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.is_director()
      or exists (select 1 from public.permission_grants g
                 join public.app_users u on u.id = g.user_id
                 where g.user_id = auth.uid() and u.status = 'active' and app.grant_alive(g)
                   and (g.company_id is null or g.company_id = c))
      or exists (select 1 from public.employees e
                 join public.app_users u on u.id = e.user_id
                 where e.user_id = auth.uid() and e.company_id = c and u.status = 'active');
$$;

-- Los grants creados por app.set_head_coach_responsibility pasan por sus propias reglas.
create or replace function app.guard_grants() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare target_role app.user_role;
begin
  if app.is_backoffice() then return new; end if;
  if tg_op = 'UPDATE' then
    -- Solo se permite revocar; nada más de un permiso cambia.
    if (new.user_id, new.module, new.action, new.company_id, new.department_id, new.group_id, new.employee_id, new.source, new.via_employee)
       is distinct from
       (old.user_id, old.module, old.action, old.company_id, old.department_id, old.group_id, old.employee_id, old.source, old.via_employee)
       or old.revoked_at is not null or new.revoked_at is null then
      raise exception 'Un permiso no se modifica: solo se puede revocar';
    end if;
    new.revoked_at := now(); new.revoked_by := auth.uid();
    return new;
  end if;
  if new.user_id = auth.uid() then
    raise exception 'Nadie puede asignarse permisos a sí mismo';
  end if;
  select role into target_role from public.app_users where id = new.user_id;
  if target_role = 'rrhh' and new.module in ('salary','payroll','payroll_hours','reports_financial','cash') then
    raise exception 'Recursos Humanos no puede recibir permisos económicos (%)', new.module;
  end if;
  if coalesce(current_setting('app.via_head_coach_fn', true), '') <> 'on' then
    if new.source <> 'manual' or new.via_employee is not null then
      raise exception 'Los permisos de Head Coach solo se asignan desde su expediente';
    end if;
    if not app.is_director() and not app.has_perm(new.module, new.action, new.company_id, new.department_id, new.group_id, new.employee_id) then
      raise exception 'No puedes otorgar un permiso superior a los que tienes';
    end if;
  end if;
  new.granted_by := auth.uid(); new.revoked_at := null; new.revoked_by := null;
  return new;
end $$;

drop policy if exists pg_update on public.permission_grants;
create policy pg_update on public.permission_grants for update
  using (app.is_director() or app.has_perm('users','configure', company_id))
  with check (app.is_director() or app.has_perm('users','configure', company_id));

-- ---------- 3) Head Coach: base fija ----------
-- Un Head Coach activo ve y edita a las personas de SU departamento (Coach) en SU empresa.
-- Solo puede cambiar grupo, puesto, contacto y días laborables; nunca salario, estado,
-- departamento, la marca de Head Coach ni su propio expediente.
create or replace function app.is_head_coach_for(c uuid, d uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from public.employees e join public.app_users u on u.id = e.user_id
                 where e.user_id = auth.uid() and u.status = 'active'
                   and e.is_head_coach and e.state = 'activo'
                   and e.company_id = c and e.department_id = d);
$$;

drop policy if exists emp_select on public.employees;
create policy emp_select on public.employees for select
  using (user_id = auth.uid()
         or app.has_perm('employees','view', company_id, department_id, group_id, id)
         or app.is_head_coach_for(company_id, department_id));
drop policy if exists emp_update on public.employees;
create policy emp_update on public.employees for update
  using (app.has_perm('employees','edit', company_id, department_id, group_id, id)
         or (app.is_head_coach_for(company_id, department_id) and user_id is distinct from auth.uid()))
  with check (app.has_perm('employees','edit', company_id, department_id, group_id, id)
         or (app.is_head_coach_for(company_id, department_id) and user_id is distinct from auth.uid()));

create or replace function app.guard_head_coach_edit() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if app.is_backoffice() or app.has_perm('employees','edit', old.company_id, old.department_id, old.group_id, old.id) then
    return new;
  end if;
  -- Aquí solo llega quien edita como Head Coach.
  if (new.company_id, new.department_id, new.state, new.is_head_coach, new.user_id, new.full_name,
      new.curp, new.rfc, new.birth_date, new.hire_date, new.contract_type)
     is distinct from
     (old.company_id, old.department_id, old.state, old.is_head_coach, old.user_id, old.full_name,
      old.curp, old.rfc, old.birth_date, old.hire_date, old.contract_type) then
    raise exception 'Como Head Coach solo puedes cambiar grupo, puesto, contacto y días laborables';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_head_coach_edit on public.employees;
create trigger trg_guard_head_coach_edit before update on public.employees
  for each row execute function app.guard_head_coach_edit();

-- ---------- 4) Head Coach: responsabilidades extra ----------
-- Lista cerrada. Las económicas (horas) solo las asignan director o administrador.
create or replace function app.head_coach_catalog()
returns table (key text, module app.perm_module, action app.perm_action, economic boolean, label text)
language sql immutable as $$
  values ('horas_ver',      'payroll_hours'::app.perm_module, 'view'::app.perm_action,   true,  'Ver horas de su departamento'),
         ('horas_capturar', 'payroll_hours',                  'edit',                    true,  'Capturar y corregir horas'),
         ('empleados_alta', 'employees',                      'create',                  false, 'Dar de alta coaches'),
         ('anuncios',       'announcements',                  'create',                  false, 'Publicar anuncios'),
         ('quejas',         'complaints',                     'view',                    false, 'Atender quejas y sugerencias'),
         ('calendario',     'calendar',                       'edit',                    false, 'Editar el calendario')
$$;

create or replace function app.set_head_coach_responsibility(p_employee uuid, p_key text, p_on boolean)
returns void language plpgsql security definer set search_path = public, app as $$
declare e public.employees; me public.app_users; cat record;
begin
  select * into e from public.employees where id = p_employee;
  if not found then raise exception 'Expediente no encontrado'; end if;
  if not e.is_head_coach or e.state <> 'activo' then raise exception 'Esta persona no es Head Coach activo'; end if;
  if e.user_id is null then raise exception 'Este Head Coach no tiene una cuenta vinculada; vincúlala antes de darle responsabilidades'; end if;
  if e.user_id = auth.uid() then raise exception 'No puedes asignarte responsabilidades a ti mismo'; end if;
  select * into cat from app.head_coach_catalog() c where c.key = p_key;
  if not found then raise exception 'Responsabilidad desconocida: %', p_key; end if;
  select * into me from public.app_users where id = auth.uid() and status = 'active';
  if not found or me.role not in ('director', 'admin', 'rrhh') then
    raise exception 'Solo el director, el administrador o Recursos Humanos asignan responsabilidades';
  end if;
  if me.role <> 'director' then
    if not app.has_perm('employees', 'edit', e.company_id, e.department_id, e.group_id, e.id) then
      raise exception 'No tienes permiso sobre este expediente';
    end if;
    if cat.economic and (me.role = 'rrhh' or not app.has_perm(cat.module, cat.action, e.company_id, e.department_id)) then
      raise exception 'Esta responsabilidad es económica: solo la asigna el director o el administrador';
    end if;
  end if;

  if p_on then
    if exists (select 1 from public.permission_grants g where g.via_employee = e.id and g.module = cat.module
               and g.action = cat.action and g.revoked_at is null) then return; end if;
    perform set_config('app.via_head_coach_fn', 'on', true);
    insert into public.permission_grants (user_id, module, action, company_id, department_id, source, via_employee)
    values (e.user_id, cat.module, cat.action, e.company_id, e.department_id, 'head_coach', e.id);
    perform set_config('app.via_head_coach_fn', 'off', true);
  else
    perform set_config('app.via_head_coach_fn', 'on', true);
    update public.permission_grants set revoked_at = now()
    where via_employee = e.id and module = cat.module and action = cat.action and revoked_at is null;
    perform set_config('app.via_head_coach_fn', 'off', true);
  end if;
end $$;

-- Responsabilidades vigentes de un Head Coach (para la pantalla).
create or replace function app.head_coach_responsibilities(p_employee uuid)
returns table (key text, label text, economic boolean, active boolean)
language sql stable security definer set search_path = public, app as $$
  select c.key, c.label, c.economic,
         exists (select 1 from public.permission_grants g where g.via_employee = p_employee
                 and g.module = c.module and g.action = c.action and g.revoked_at is null)
  from app.head_coach_catalog() c
  where exists (select 1 from public.employees e where e.id = p_employee
                and (app.has_perm('employees','view', e.company_id, e.department_id, e.group_id, e.id) or e.user_id = auth.uid()));
$$;

-- ---------- 5) Horario base por empleado (plantilla semanal, solo-agregar) ----------
-- blocks: [{"weekday":1,"start":"16:00","end":"20:00"}, …]  (0 domingo … 6 sábado)
create or replace function app.valid_blocks(b jsonb, with_weekday boolean) returns boolean
language sql immutable as $$
  select jsonb_typeof(b) = 'array' and not exists (
    select 1 from jsonb_array_elements(b) x
    where jsonb_typeof(x) <> 'object'
       or coalesce(x->>'start', '') !~ '^([01]\d|2[0-3]):[0-5]\d$'
       or coalesce(x->>'end',   '') !~ '^([01]\d|2[0-3]):[0-5]\d$'
       or (x->>'end') <= (x->>'start')
       or (with_weekday and coalesce(x->>'weekday', '') !~ '^[0-6]$'));
$$;

create table if not exists public.employee_work_schedules (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  employee_id    uuid not null,
  blocks         jsonb not null check (app.valid_blocks(blocks, true)),
  effective_from date not null,
  reason         text not null check (length(trim(reason)) > 0),
  created_by     uuid references public.app_users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  foreign key (employee_id, company_id) references public.employees(id, company_id)
);
create index if not exists ews_emp_idx on public.employee_work_schedules (employee_id, effective_from desc);

-- Excepciones de un día: clase extra, curso, competencia, o día sin actividad.
create table if not exists public.schedule_exceptions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  employee_id   uuid not null,
  date          date not null,
  kind          text not null check (kind in ('clase_extra', 'curso', 'competencia', 'sin_actividad', 'otro')),
  blocks        jsonb not null default '[]' check (app.valid_blocks(blocks, false)),
  replaces_base boolean not null default false,   -- true: ese día solo cuenta lo de la excepción
  reason        text not null check (length(trim(reason)) > 0),
  created_by    uuid references public.app_users(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  cancelled_by  uuid references public.app_users(id),
  foreign key (employee_id, company_id) references public.employees(id, company_id)
);
create index if not exists sx_emp_date_idx on public.schedule_exceptions (employee_id, date);

-- Número de cada persona en el checador de cada empresa (CAR y Viñedos numeran distinto).
create table if not exists public.checker_ids (
  company_id  uuid not null references public.companies(id),
  device_id   text not null,
  employee_id uuid,
  ignored     boolean not null default false,   -- personas que ya no están: no se ligan
  label       text,                              -- nombre como aparece en el checador
  updated_by  uuid references public.app_users(id) default auth.uid(),
  updated_at  timestamptz not null default now(),
  primary key (company_id, device_id),
  check (not (ignored and employee_id is not null)),
  foreign key (employee_id, company_id) references public.employees(id, company_id)
);
create index if not exists checker_ids_emp_idx on public.checker_ids (company_id, employee_id);   -- una persona puede tener más de un número

-- Protecciones e historial
drop trigger if exists trg_ews_immutable on public.employee_work_schedules;
create trigger trg_ews_immutable before update or delete on public.employee_work_schedules
  for each row execute function app.block_mutation();

create or replace function app.guard_schedule_exception() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Las excepciones no se borran: cancélalas'; end if;
  if app.is_backoffice() then return new; end if;
  if old.cancelled_at is not null then raise exception 'Esta excepción ya está cancelada'; end if;
  if (new.company_id, new.employee_id, new.date, new.kind, new.blocks, new.replaces_base, new.reason)
     is distinct from (old.company_id, old.employee_id, old.date, old.kind, old.blocks, old.replaces_base, old.reason)
     or new.cancelled_at is null then
    raise exception 'Una excepción no se edita: cancélala y registra otra';
  end if;
  new.cancelled_at := now(); new.cancelled_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_guard_schedule_exception on public.schedule_exceptions;
create trigger trg_guard_schedule_exception before update or delete on public.schedule_exceptions
  for each row execute function app.guard_schedule_exception();

drop trigger if exists aud_ews on public.employee_work_schedules;
create trigger aud_ews after insert on public.employee_work_schedules for each row execute function app.audit();
drop trigger if exists aud_sx on public.schedule_exceptions;
create trigger aud_sx after insert or update on public.schedule_exceptions for each row execute function app.audit();
drop trigger if exists aud_checker on public.checker_ids;
create trigger aud_checker after insert or update on public.checker_ids for each row execute function app.audit();

-- RLS: horarios y checador son materia de "horas" (payroll_hours). RR.HH. no los ve (candado de has_perm).
alter table public.employee_work_schedules enable row level security;
alter table public.schedule_exceptions     enable row level security;
alter table public.checker_ids             enable row level security;

drop policy if exists ews_select on public.employee_work_schedules;
create policy ews_select on public.employee_work_schedules for select
  using (app.emp_perm('payroll_hours','view', employee_id) or employee_id = app.my_employee_id(company_id));
drop policy if exists ews_insert on public.employee_work_schedules;
create policy ews_insert on public.employee_work_schedules for insert
  with check (app.emp_perm('payroll_hours','edit', employee_id));

drop policy if exists sx_select on public.schedule_exceptions;
create policy sx_select on public.schedule_exceptions for select
  using (app.emp_perm('payroll_hours','view', employee_id) or employee_id = app.my_employee_id(company_id));
drop policy if exists sx_insert on public.schedule_exceptions;
create policy sx_insert on public.schedule_exceptions for insert
  with check (app.emp_perm('payroll_hours','edit', employee_id));
drop policy if exists sx_update on public.schedule_exceptions;
create policy sx_update on public.schedule_exceptions for update
  using (app.emp_perm('payroll_hours','edit', employee_id)) with check (app.emp_perm('payroll_hours','edit', employee_id));

drop policy if exists chk_select on public.checker_ids;
create policy chk_select on public.checker_ids for select using (app.has_perm('payroll_hours','view', company_id));
drop policy if exists chk_insert on public.checker_ids;
create policy chk_insert on public.checker_ids for insert with check (app.has_perm('payroll_hours','configure', company_id));
drop policy if exists chk_update on public.checker_ids;
create policy chk_update on public.checker_ids for update
  using (app.has_perm('payroll_hours','configure', company_id)) with check (app.has_perm('payroll_hours','configure', company_id));

grant select, insert on public.employee_work_schedules to authenticated;
grant select, insert, update on public.schedule_exceptions, public.checker_ids to authenticated;
grant update on public.permission_grants to authenticated;
revoke delete on all tables in schema public from authenticated;
grant execute on all functions in schema app to authenticated;

-- Entradas públicas (la API solo expone el esquema public). Se ejecutan con los permisos de quien llama;
-- las reglas viven en las funciones de app.
create or replace function public.set_head_coach_responsibility(p_employee uuid, p_key text, p_on boolean)
returns void language sql as $$ select app.set_head_coach_responsibility(p_employee, p_key, p_on) $$;
create or replace function public.head_coach_responsibilities(p_employee uuid)
returns table (key text, label text, economic boolean, active boolean)
language sql stable as $$ select * from app.head_coach_responsibilities(p_employee) $$;
revoke execute on function public.set_head_coach_responsibility(uuid, text, boolean) from public, anon;
revoke execute on function public.head_coach_responsibilities(uuid) from public, anon;
grant execute on function public.set_head_coach_responsibility(uuid, text, boolean) to authenticated;
grant execute on function public.head_coach_responsibilities(uuid) to authenticated;
