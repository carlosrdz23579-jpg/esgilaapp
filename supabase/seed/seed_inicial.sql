-- Empresas
insert into public.companies (trade_name)
select v from (values ('ESGILA CAR'), ('ESGILA Viñedos')) t(v)
where not exists (select 1 from public.companies c where c.trade_name = t.v);

-- Departamentos (ambas empresas)
insert into public.departments (company_id, name)
select c.id, d.name
from public.companies c
cross join (values ('Coach'), ('Staff')) d(name)
where c.trade_name in ('ESGILA CAR', 'ESGILA Viñedos')
on conflict (company_id, name) do nothing;

-- Grupos (dentro de Coach, en ambas empresas)
insert into public.groups (company_id, department_id, name)
select d.company_id, d.id, g.name
from public.departments d
join public.companies c on c.id = d.company_id
cross join (values ('Regulares'), ('Equipo'), ('Intermedio'), ('Parkour'), ('Baby Gym'), ('Telas')) g(name)
where d.name = 'Coach' and c.trade_name in ('ESGILA CAR', 'ESGILA Viñedos')
on conflict (department_id, name) do nothing;

-- Director
update public.app_users set role = 'director', status = 'active'
where lower(email) = 'aldost228@gmail.com';

-- Administrador (acceso a ambas empresas)
update public.app_users set role = 'admin', status = 'active'
where lower(email) = 'carlosrdz23579@gmail.com';

-- Permisos del administrador (todos los módulos operativos, sin eliminar, sin usuarios ni configuración)
insert into public.permission_grants (user_id, module, action)
select u.id, m.module::app.perm_module, a.action::app.perm_action
from public.app_users u
cross join unnest(array['companies','employees','salary','payroll','payroll_hours','pay_schedules',
  'reports_financial','reports_shared','cash','complaints','announcements','calendar','chat']) as m(module)
cross join unnest(array['view','create','edit','authorize','export','share','configure']) as a(action)
where lower(u.email) = 'carlosrdz23579@gmail.com' and u.role = 'admin'
  and not exists (
    select 1 from public.permission_grants g
    where g.user_id = u.id and g.module = m.module::app.perm_module and g.action = a.action::app.perm_action
      and g.company_id is null and g.department_id is null and g.group_id is null and g.employee_id is null);

-- Verificación rápida
select 'empresas' as dato, count(*) from public.companies
union all select 'departamentos', count(*) from public.departments
union all select 'grupos', count(*) from public.groups
union all select 'usuarios activos', count(*) from public.app_users where status = 'active'
union all select 'permisos del admin', count(*) from public.permission_grants;
