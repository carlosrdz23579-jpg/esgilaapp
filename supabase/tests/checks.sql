-- Verificaciones tras aplicar migraciones + seeds. Cualquier fallo aborta (ON_ERROR_STOP).
do $$
declare n int;
begin
  select count(*) into n from public.companies;            if n <> 2  then raise exception 'empresas: %', n; end if;
  select count(*) into n from public.departments;          if n <> 4  then raise exception 'departamentos: %', n; end if;
  select count(*) into n from public.groups;               if n <> 12 then raise exception 'grupos: %', n; end if;
  select count(*) into n from public.permission_grants;    if n <> 91 then raise exception 'permisos admin: %', n; end if;
  select count(*) into n from public.pay_schedules where cutoff = 'dia_anterior';
  if n <> 2 then raise exception 'calendarios con corte dia_anterior: %', n; end if;
  insert into public.employees (company_id, full_name, department_id)
    select d.company_id, 'Prueba', d.id from public.departments d where d.name = 'Coach' limit 1;
  select cardinality(work_days) into n from public.employees where full_name = 'Prueba';
  if n <> 6 then raise exception 'work_days por defecto debería ser lunes a sábado'; end if;
  begin
    update public.employees set work_days = '{}' where full_name = 'Prueba';
    raise exception 'work_days vacío debió rechazarse';
  exception when check_violation then null; end;
  if (select frequency from app.effective_schedule((select id from public.employees where full_name='Prueba'), current_date)) <> 'quincenal'
    then raise exception 'calendario efectivo'; end if;
  raise notice 'OK: todas las verificaciones pasaron';
end $$;
