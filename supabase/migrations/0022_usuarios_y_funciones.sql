-- =====================================================================
-- 0022  Usuarios y permisos
-- - Puede haber varios directores y varios administradores; todos los del mismo perfil son iguales.
-- - Un director puede PAUSAR sus propias funciones por módulo (nómina, efectivo, etc.) y
--   reactivarlas cuando quiera. Pausar no le quita el cargo. Queda auditado.
-- - Nunca puede quedarse la empresa sin un director activo.
-- =====================================================================
alter table public.app_users add column if not exists paused_modules app.perm_module[] not null default '{}';

create or replace function app.director_paused(p_module app.perm_module) returns boolean
language sql stable security definer set search_path = public, app as $$
  select coalesce((select p_module = any(paused_modules) from public.app_users where id = auth.uid()), false);
$$;

create or replace function app.has_perm(
  p_module app.perm_module, p_action app.perm_action,
  p_company uuid, p_dept uuid default null, p_group uuid default null, p_employee uuid default null
) returns boolean
language sql stable security definer set search_path = public, app as $$
  select (app.is_director() and not app.director_paused(p_module)) or exists (
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

create or replace function app.guard_user_update() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if app.is_backoffice() then return new; end if;
  -- Funciones pausadas: solo uno mismo, y solo si es director.
  if new.paused_modules is distinct from old.paused_modules then
    if old.id <> auth.uid() or coalesce(current_setting('app.self_pause_fn', true), '') <> 'on' then
      raise exception 'Solo cada director pausa o reactiva sus propias funciones';
    end if;
  end if;
  if (new.role is distinct from old.role or new.status is distinct from old.status) then
    if not app.is_director() and not app.has_perm('users','edit', null) then
      raise exception 'Sin autorización para cambiar perfil o estado';
    end if;
    if new.role is distinct from old.role and not app.is_director() then
      raise exception 'Solo un director puede cambiar perfiles';
    end if;
    if old.id = auth.uid() and not app.is_director() then
      raise exception 'No puedes cambiar tu propio perfil o estado';
    end if;
    -- Nunca sin director activo.
    if old.role = 'director' and old.status = 'active' and (new.role <> 'director' or new.status <> 'active')
       and (select count(*) from public.app_users where role = 'director' and status = 'active' and id <> old.id) = 0 then
      raise exception 'Debe quedar al menos un director activo';
    end if;
  end if;
  return new;
end $$;

-- Pausar / reactivar una función propia (solo directores).
create or replace function app.set_my_paused(p_module app.perm_module, p_paused boolean)
returns void language plpgsql security definer set search_path = public, app as $$
begin
  if not app.is_director() then raise exception 'Solo los directores pausan funciones propias'; end if;
  if p_module = 'users' then raise exception 'Usuarios y permisos no se puede pausar (es desde donde se reactiva)'; end if;
  perform set_config('app.self_pause_fn', 'on', true);
  update public.app_users
     set paused_modules = case when p_paused then array(select distinct unnest(paused_modules || p_module))
                               else array_remove(paused_modules, p_module) end
   where id = auth.uid();
  perform set_config('app.self_pause_fn', 'off', true);
end $$;
create or replace function public.set_my_paused(p_module text, p_paused boolean)
returns void language sql as $$ select app.set_my_paused(p_module::app.perm_module, p_paused) $$;
revoke execute on function public.set_my_paused(text, boolean) from public, anon;
grant execute on function public.set_my_paused(text, boolean) to authenticated;
grant execute on all functions in schema app to authenticated;
