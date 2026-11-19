-- =====================================================================
-- 0002  Corrección: permitir la configuración inicial desde el SQL Editor.
-- Los candados de 0001 bloqueaban incluso al propietario de la base de datos
-- (auth.uid() es NULL ahí), por lo que no se podía nombrar al primer director.
-- "Contexto de back-office" = sesión directa de base de datos o service_role;
-- NUNCA una petición de la API con la clave pública (esa pasa por 'authenticator').
-- =====================================================================
create or replace function app.is_backoffice() returns boolean
language sql stable as $$
  select (auth.uid() is null and session_user not in ('authenticator','anon','authenticated'))
      or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role';
$$;

create or replace function app.guard_grants() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare target_role app.user_role;
begin
  if app.is_backoffice() then return new; end if;
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

create or replace function app.guard_user_update() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if app.is_backoffice() then return new; end if;
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

create or replace function app.guard_employee_link() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if app.is_backoffice() then return new; end if;
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
