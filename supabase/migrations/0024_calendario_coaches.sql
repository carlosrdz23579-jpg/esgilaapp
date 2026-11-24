-- =====================================================================
-- 0024  Calendario de coaches: quién dirige el calentamiento, planeación general (trimestral),
--       planeaciones mensuales y apuntes de cada maestro, y asistencia de maestros
--       (hora de llegada y uniforme, además del checador).
-- Permisos (ya existentes):
--   warmup/configure   asignar quién dirige el calentamiento cada día
--   planning/configure subir la planeación general de la sucursal (Itzel)
--   planning/view      ver todas las planeaciones y apuntes (revisar)
--   uniform/edit       registrar llegada y uniforme de maestros
-- Archivos: bucket privado 'planeaciones', ruta  <empresa>/<general | id del empleado>/<archivo>.
-- Nada se borra: un apunte "borrado" por su autor se oculta para él y queda para dirección.
-- =====================================================================

-- ---------- Quién dirige el calentamiento (el registro más reciente del día cuenta) ----------
create table if not exists public.warmup_leaders (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  date        date not null,
  employee_id uuid references public.employees(id),          -- null = sin asignar
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists wl_company_date on public.warmup_leaders (company_id, date, created_at desc);
create or replace view public.warmup_leader_latest with (security_invoker = true) as
  select distinct on (company_id, date) company_id, date, employee_id, created_by, created_at
  from public.warmup_leaders order by company_id, date, created_at desc;

create or replace function app.guard_warmup_leader() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op <> 'INSERT' then raise exception 'No se edita: asigna de nuevo el día'; end if;
  if new.employee_id is not null and not exists (select 1 from public.employees e where e.id = new.employee_id and e.company_id = new.company_id) then
    raise exception 'La persona no pertenece a esta sucursal';
  end if;
  if not app.is_backoffice() then new.created_by := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists trg_guard_wl on public.warmup_leaders;
create trigger trg_guard_wl before insert or update or delete on public.warmup_leaders for each row execute function app.guard_warmup_leader();
drop trigger if exists aud_wl on public.warmup_leaders;
create trigger aud_wl after insert on public.warmup_leaders for each row execute function app.audit();

-- ---------- Planeaciones y apuntes ----------
create table if not exists public.planning_files (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  kind         text not null check (kind in ('general', 'mensual', 'apunte')),
  employee_id  uuid references public.employees(id),          -- null solo en 'general'
  period_start date not null,                                  -- general: inicio del trimestre; mensual: día 1 del mes; apunte: fecha
  period_end   date,                                           -- general: fin del trimestre
  part         smallint check (part in (1, 2)),                -- mensual: 1 = semanas 1–2, 2 = semanas 3–4
  title        text,
  note         text,                                           -- apunte escrito (puede no llevar archivo)
  storage_path text,
  file_name    text,
  mime         text,
  size_bytes   bigint,
  created_by   uuid references public.app_users(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  hidden_at    timestamptz,                                    -- el autor lo "borró": ya no lo ve; dirección sí
  hidden_by    uuid references public.app_users(id),
  reviewed_at  timestamptz,
  reviewed_by  uuid references public.app_users(id),
  check ((kind = 'general') = (employee_id is null)),
  check (kind <> 'general' or period_end is not null),
  check (kind <> 'mensual' or part is not null),
  check (storage_path is not null or length(trim(coalesce(note, ''))) > 0)
);
create index if not exists pf_company on public.planning_files (company_id, kind, period_start);
create index if not exists pf_emp on public.planning_files (employee_id, kind, period_start);

-- Fecha límite de la planeación mensual: el 25 del mes anterior. Tardía si se subió después (hora de México).
create or replace function app.planning_deadline(p_month date) returns date language sql immutable as $$
  select (date_trunc('month', p_month) - interval '1 month' + interval '24 days')::date $$;
create or replace view public.planning_status with (security_invoker = true) as
  select f.*, case when f.kind = 'mensual' then (f.created_at at time zone 'America/Mexico_City')::date > app.planning_deadline(f.period_start) end as late,
         case when f.kind = 'mensual' then app.planning_deadline(f.period_start) end as deadline
  from public.planning_files f;

create or replace function app.guard_planning() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare n int;
begin
  if tg_op = 'DELETE' then raise exception 'No se borra: se oculta'; end if;
  if tg_op = 'INSERT' then
    if app.is_backoffice() then return new; end if;
    new.created_by := auth.uid(); new.hidden_at := null; new.hidden_by := null; new.reviewed_at := null; new.reviewed_by := null;
    if new.employee_id is not null and not exists (select 1 from public.employees e where e.id = new.employee_id and e.company_id = new.company_id) then
      raise exception 'La persona no pertenece a esta sucursal';
    end if;
    if new.kind = 'general' and not app.has_perm('planning', 'configure', new.company_id) then
      raise exception 'Solo quien tiene el permiso sube la planeación general';
    end if;
    if new.kind <> 'general' and new.employee_id is distinct from app.my_employee_id(new.company_id)
       and not app.has_perm('planning', 'edit', new.company_id) then
      raise exception 'Solo puedes subir tus propias planeaciones y apuntes';
    end if;
    if new.kind = 'mensual' then
      new.period_start := date_trunc('month', new.period_start)::date;
      select count(*) into n from public.planning_files
       where kind = 'mensual' and employee_id = new.employee_id and period_start = new.period_start and part = new.part;
      if n >= 2 then raise exception 'Ya subiste 2 veces esta parte de la planeación de ese mes'; end if;
    end if;
    return new;
  end if;
  if app.is_backoffice() then return new; end if;
  if (new.company_id, new.kind, new.employee_id, new.period_start, new.period_end, new.part, new.title, new.note, new.storage_path, new.created_by, new.created_at)
     is distinct from (old.company_id, old.kind, old.employee_id, old.period_start, old.period_end, old.part, old.title, old.note, old.storage_path, old.created_by, old.created_at) then
    raise exception 'Un archivo subido no se edita: sube otro';
  end if;
  if new.hidden_at is distinct from old.hidden_at then
    if old.hidden_at is not null or new.hidden_at is null then raise exception 'No se puede reaparecer un archivo oculto'; end if;
    if not (old.created_by = auth.uid() or app.has_perm('planning', 'configure', old.company_id)) then raise exception 'Solo quien lo subió lo puede quitar'; end if;
    new.hidden_at := now(); new.hidden_by := auth.uid();
  end if;
  if new.reviewed_at is distinct from old.reviewed_at then
    if not app.has_perm('planning', 'view', old.company_id) then raise exception 'Necesitas permiso de revisar planeaciones'; end if;
    new.reviewed_at := case when new.reviewed_at is null then null else now() end;
    new.reviewed_by := case when new.reviewed_at is null then null else auth.uid() end;
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_planning on public.planning_files;
create trigger trg_guard_planning before insert or update or delete on public.planning_files for each row execute function app.guard_planning();
drop trigger if exists aud_planning on public.planning_files;
create trigger aud_planning after insert or update on public.planning_files for each row execute function app.audit();

-- ---------- Asistencia de maestros (además del checador) ----------
create table if not exists public.staff_attendance (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  employee_id uuid not null,
  date        date not null,
  arrival     text check (arrival is null or arrival ~ '^([01]\d|2[0-3]):[0-5]\d$'),   -- null = no vino
  uniform     boolean,
  note        text,
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (employee_id, company_id) references public.employees(id, company_id)
);
create index if not exists sa_emp_date on public.staff_attendance (employee_id, date, created_at desc);
create or replace view public.staff_attendance_latest with (security_invoker = true) as
  select distinct on (employee_id, date) * from public.staff_attendance order by employee_id, date, created_at desc;

create or replace function app.guard_staff_att() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op <> 'INSERT' then raise exception 'No se edita: registra de nuevo el día'; end if;
  if not app.is_backoffice() then
    new.created_by := auth.uid();
    if new.date > app.today_mx() then raise exception 'No se registran días futuros'; end if;
    if exists (select 1 from public.employees e where e.id = new.employee_id and e.user_id = auth.uid()) then
      raise exception 'No puedes registrar tu propia asistencia';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_sa on public.staff_attendance;
create trigger trg_guard_sa before insert or update or delete on public.staff_attendance for each row execute function app.guard_staff_att();
drop trigger if exists aud_sa on public.staff_attendance;
create trigger aud_sa after insert on public.staff_attendance for each row execute function app.audit();

-- ---------- RLS ----------
alter table public.warmup_leaders   enable row level security;
alter table public.planning_files   enable row level security;
alter table public.staff_attendance enable row level security;

drop policy if exists wl_select on public.warmup_leaders;
create policy wl_select on public.warmup_leaders for select using (app.can_see_company(company_id));
drop policy if exists wl_insert on public.warmup_leaders;
create policy wl_insert on public.warmup_leaders for insert with check (app.has_perm('warmup', 'configure', company_id));

drop policy if exists pf_select on public.planning_files;
create policy pf_select on public.planning_files for select using (
  app.has_perm('planning', 'view', company_id)
  or (kind = 'general' and app.can_see_company(company_id))
  or (employee_id = app.my_employee_id(company_id) and hidden_at is null));
drop policy if exists pf_insert on public.planning_files;
create policy pf_insert on public.planning_files for insert with check (true);   -- reglas en el trigger
drop policy if exists pf_update on public.planning_files;
create policy pf_update on public.planning_files for update
  using (created_by = auth.uid() or app.has_perm('planning', 'view', company_id) or app.has_perm('planning', 'configure', company_id))
  with check (true);

drop policy if exists sa_select on public.staff_attendance;
create policy sa_select on public.staff_attendance for select using (
  app.has_perm('uniform', 'view', company_id) or app.has_perm('uniform', 'edit', company_id)
  or app.emp_perm('payroll_hours', 'view', employee_id) or employee_id = app.my_employee_id(company_id));
drop policy if exists sa_insert on public.staff_attendance;
create policy sa_insert on public.staff_attendance for insert with check (app.has_perm('uniform', 'edit', company_id));

-- Quien asigna calentamiento, registra asistencia o revisa planeaciones necesita ver la lista de personas.
drop policy if exists emp_select on public.employees;
create policy emp_select on public.employees for select
  using (user_id = auth.uid()
         or app.has_perm('employees','view', company_id, department_id, group_id, id)
         or app.is_head_coach_for(company_id, department_id)
         or app.has_perm('warmup','edit', company_id, department_id, group_id, id)
         or app.has_perm('warmup','view', company_id, department_id, group_id, id)
         or app.has_perm('warmup','configure', company_id)
         or app.has_perm('uniform','edit', company_id)
         or app.has_perm('planning','view', company_id));

grant select, insert on public.warmup_leaders, public.staff_attendance to authenticated;
grant select, insert, update on public.planning_files to authenticated;
grant select on public.warmup_leader_latest, public.planning_status, public.staff_attendance_latest to authenticated;

-- ---------- Archivos (Supabase Storage) ----------
create or replace function app.planning_path_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = public, app as $$
declare co uuid; who text;
begin
  begin co := split_part(p_name, '/', 1)::uuid; exception when others then return false; end;
  who := split_part(p_name, '/', 2);
  if who = 'general' then
    return case when p_write then app.has_perm('planning', 'configure', co) else app.can_see_company(co) end;
  end if;
  return who = coalesce(app.my_employee_id(co)::text, '-')
      or (not p_write and app.has_perm('planning', 'view', co))
      or (p_write and app.has_perm('planning', 'edit', co));
end $$;
grant execute on all functions in schema app to authenticated;

do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('planeaciones', 'planeaciones', false) on conflict (id) do nothing;
    execute 'drop policy if exists planeaciones_select on storage.objects';
    execute 'create policy planeaciones_select on storage.objects for select to authenticated using (bucket_id = ''planeaciones'' and app.planning_path_ok(name, false))';
    execute 'drop policy if exists planeaciones_insert on storage.objects';
    execute 'create policy planeaciones_insert on storage.objects for insert to authenticated with check (bucket_id = ''planeaciones'' and app.planning_path_ok(name, true))';
  end if;
end $$;

-- Quitar (ocultar) un apunte o archivo propio: función aparte porque, una vez oculto, su autor ya no lo ve.
create or replace function public.hide_planning_file(p_id uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare f public.planning_files;
begin
  select * into f from public.planning_files where id = p_id;
  if not found or f.hidden_at is not null then raise exception 'Archivo no encontrado'; end if;
  if not (f.created_by = auth.uid() or app.has_perm('planning', 'configure', f.company_id)) then raise exception 'Solo quien lo subió lo puede quitar'; end if;
  update public.planning_files set hidden_at = now() where id = p_id;   -- la función corre como dueña de la tabla; el trigger valida
end $$;
revoke execute on function public.hide_planning_file(uuid) from public, anon;
grant execute on function public.hide_planning_file(uuid) to authenticated;
