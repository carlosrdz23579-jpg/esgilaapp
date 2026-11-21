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

-- 0007: reglas de edición/cancelación probadas como el administrador (no back-office).
do $$
declare admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        co uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        fut uuid; vig uuid; hoy date := app.today_mx();
        ok boolean;
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into public.pay_schedules (company_id, scope, frequency, monthly_day, effective_from, reason)
    values (co, 'empresa', 'mensual', 31, hoy + 10, 'prueba futura') returning id into fut;
  update public.pay_schedules set monthly_day = 30 where id = fut;                        -- editar programado: OK
  if (select monthly_day from public.pay_schedules where id = fut) <> 30 then raise exception 'no editó el programado'; end if;

  ok := false; begin update public.pay_schedules set effective_from = hoy - 1 where id = fut;
  exception when others then ok := true; end;
  if not ok then raise exception 'permitió mover un programado al pasado'; end if;

  update public.pay_schedules set cancelled_at = now(), cancel_reason = 'error de captura' where id = fut;   -- cancelar: OK
  if (select cancelled_by from public.pay_schedules where id = fut) <> admin then raise exception 'no registró quién canceló'; end if;

  vig := (select id from public.pay_schedules where company_id = co and scope = 'empresa' and cancelled_at is null and effective_from <= hoy limit 1);
  ok := false; begin update public.pay_schedules set biweekly_day_1 = 10 where id = vig;
  exception when others then ok := true; end;
  if not ok then raise exception 'permitió editar un calendario vigente'; end if;

  ok := false; begin update public.pay_schedules set cancelled_at = now(), cancel_reason = 'x' where id = vig;
  exception when others then ok := true; end;
  if not ok then raise exception 'permitió cancelar un calendario vigente'; end if;

  ok := false; begin update public.pay_schedules set effective_to = hoy - 1 where id = vig;
  exception when others then ok := true; end;
  if not ok then raise exception 'permitió terminar en el pasado'; end if;

  ok := false; begin delete from public.pay_schedules where id = vig;
  exception when others then ok := true; end;
  -- sin política DELETE, RLS no borra nada aunque no lance error:
  if not exists (select 1 from public.pay_schedules where id = vig) then raise exception 'se pudo borrar'; end if;

  update public.pay_schedules set effective_to = hoy + 30 where id = vig;                 -- terminar: OK
  reset role;
  raise notice 'OK: reglas de 0007 (editar programado, cancelar, terminar, no borrar)';
end $$;
