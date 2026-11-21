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

-- 0008: Head Coach, dos sucursales, revocar permisos, horarios.
do $$
declare admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        vin uuid := (select id from public.companies where trade_name = 'ESGILA Viñedos');
        coach_car uuid := (select id from public.departments where company_id = car and name = 'Coach');
        staff_car uuid := (select id from public.departments where company_id = car and name = 'Staff');
        coach_vin uuid := (select id from public.departments where company_id = vin and name = 'Coach');
        g1 uuid := (select id from public.groups where department_id = coach_car and name = 'Parkour');
        g2 uuid := (select id from public.groups where department_id = coach_car and name = 'Telas');
        hc_user uuid; rrhh_user uuid; hc uuid; c1 uuid; s1 uuid; ok boolean; n int;
begin
  insert into auth.users(email) values ('hc@x.com') returning id into hc_user;
  insert into auth.users(email) values ('rh@x.com') returning id into rrhh_user;
  update public.app_users set status = 'active' where id = hc_user;
  update public.app_users set status = 'active', role = 'rrhh' where id = rrhh_user;
  insert into public.employees (company_id, full_name, department_id, is_head_coach, user_id) values (car, 'HC', coach_car, true, hc_user) returning id into hc;
  insert into public.employees (company_id, full_name, department_id, group_id) values (car, 'Coach 1', coach_car, g1) returning id into c1;
  insert into public.employees (company_id, full_name, department_id) values (car, 'Staff 1', staff_car) returning id into s1;
  -- 0009: una cuenta = un expediente (no se duplica en Viñedos)
  ok := false; begin insert into public.employees (company_id, full_name, department_id, user_id) values (vin, 'HC en Viñedos', coach_vin, hc_user);
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'se permitió un segundo expediente para la misma cuenta'; end if;

  -- ===== Como Head Coach =====
  perform set_config('request.jwt.claim.sub', hc_user::text, true);
  set local role authenticated;
  update public.employees set group_id = g2, job_title = 'Coach Telas' where id = c1;
  if (select group_id from public.employees where id = c1) <> g2 then raise exception 'HC no pudo mover de grupo'; end if;
  ok := false; begin update public.employees set state = 'baja' where id = c1; exception when others then ok := true; end;
  if not ok then raise exception 'HC pudo dar de baja'; end if;
  if exists (select 1 from public.employees where id = s1) then raise exception 'HC ve a Staff'; end if;
  update public.employees set job_title = 'yo' where id = hc;            -- su propio expediente: RLS no lo deja (0 filas)
  if (select job_title from public.employees where id = hc) is not null then raise exception 'HC se editó a sí mismo'; end if;
  if app.has_perm('payroll_hours','view', car, coach_car) then raise exception 'HC con horas sin asignar'; end if;
  ok := false; begin perform app.set_head_coach_responsibility(hc, 'anuncios', true); exception when others then ok := true; end;
  if not ok then raise exception 'HC se asignó responsabilidades'; end if;
  reset role;

  -- ===== RR.HH. no puede dar responsabilidades económicas =====
  perform set_config('request.jwt.claim.sub', rrhh_user::text, true);
  set local role authenticated;
  ok := false; begin perform public.set_head_coach_responsibility(hc, 'horas_ver', true); exception when others then ok := true; end;
  if not ok then raise exception 'RRHH dio una responsabilidad económica'; end if;
  reset role;

  -- ===== Administrador asigna y revoca =====
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  perform public.set_head_coach_responsibility(hc, 'horas_ver', true);
  perform public.set_head_coach_responsibility(hc, 'horas_ver', true);    -- idempotente
  select count(*) into n from public.head_coach_responsibilities(hc) where active; if n <> 1 then raise exception 'responsabilidades activas: %', n; end if;
  ok := false; begin insert into public.permission_grants (user_id, module, action, source, via_employee) values (hc_user, 'cash', 'view', 'head_coach', hc);
  exception when others then ok := true; end;
  if not ok then raise exception 'se pudo insertar un grant de Head Coach a mano'; end if;
  insert into public.employee_work_schedules (company_id, employee_id, blocks, effective_from, reason)
    values (car, c1, '[{"weekday":1,"start":"16:00","end":"20:00"}]', current_date, 'horario base');
  ok := false; begin insert into public.employee_work_schedules (company_id, employee_id, blocks, effective_from, reason)
    values (car, c1, '[{"weekday":1,"start":"20:00","end":"16:00"}]', current_date, 'malo'); exception when check_violation then ok := true; end;
  if not ok then raise exception 'aceptó un bloque con fin antes del inicio'; end if;
  insert into public.checker_ids (company_id, device_id, employee_id, label) values (car, '17', c1, 'jrisy'), (car, '30', c1, 'jrisy');
  insert into public.checker_ids (company_id, device_id, ignored, label) values (car, '1', true, 'ya no está');
  -- Checada en el aparato de Viñedos de una persona de CAR: se liga a su expediente de CAR.
  insert into public.checker_ids (company_id, device_id, employee_id, label) values (vin, '28', c1, 'Itzel_Glz');
  -- Conceptos: portero (por día) + limpieza (por día, lun-vie) en la misma persona.
  insert into public.compensation_concepts (company_id, employee_id, concept_key, label, kind, amount_cents, weekdays, effective_from, reason)
    values (car, c1, 'portero', 'Portero', 'por_dia', 25000, '{0,1,2,3,4,5,6}', current_date, 'alta'),
           (car, c1, 'limpieza', 'Limpieza', 'por_dia', 15000, '{1,2,3,4,5}', current_date, 'alta');
  if (select count(*) from app.concepts_at(c1, current_date)) <> 2 then raise exception 'conceptos vigentes'; end if;
  reset role;

  -- Head Coach ahora sí tiene horas; al quitarle la marca, las pierde.
  perform set_config('request.jwt.claim.sub', hc_user::text, true);
  set local role authenticated;
  if not app.has_perm('payroll_hours','view', car, coach_car) then raise exception 'HC sin la responsabilidad asignada'; end if;
  if app.has_perm('payroll_hours','view', car, staff_car) then raise exception 'HC con horas fuera de su departamento'; end if;
  if not exists (select 1 from public.employee_work_schedules where employee_id = c1) then raise exception 'HC no ve horarios con la responsabilidad'; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);   -- back-office (SQL Editor)
  update public.employees set is_head_coach = false where id = hc;
  perform set_config('request.jwt.claim.sub', hc_user::text, true);
  set local role authenticated;
  if app.has_perm('payroll_hours','view', car, coach_car) then raise exception 'conservó la responsabilidad sin ser HC'; end if;
  if exists (select 1 from public.employees where id = c1) then raise exception 'sigue viendo coaches sin ser HC'; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  update public.employees set is_head_coach = true where id = hc;
  perform public.set_head_coach_responsibility(hc, 'horas_ver', false);
  select count(*) into n from public.head_coach_responsibilities(hc) where active; if n <> 0 then raise exception 'no se revocó'; end if;
  reset role;
  raise notice 'OK: Head Coach, un expediente por persona, checador entre sucursales, conceptos, revocación, horarios y checador';
end $$;

-- 0010: descuentos
do $$
declare admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        dir uuid := (select id from public.app_users where email = 'aldost228@gmail.com');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        emp uuid := (select id from public.employees where full_name = 'Coach 1');
        d1 uuid; ok boolean;
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  insert into public.deductions (company_id, employee_id, label, amount_cents, kind, start_date, reason, status)
    values (car, emp, 'Uniforme', 35000, 'unico', current_date, 'uniforme extraviado', 'autorizado') returning id into d1;
  if (select status from public.deductions where id = d1) <> 'pendiente' then raise exception 'se capturó ya autorizado'; end if;
  ok := false; begin update public.deductions set status = 'autorizado' where id = d1; exception when others then ok := true; end;
  if not ok then raise exception 'el capturista se autorizó a sí mismo'; end if;
  ok := false; begin update public.deductions set amount_cents = 1 where id = d1; exception when others then ok := true; end;
  if not ok then raise exception 'se editó el importe'; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', dir::text, true);
  set local role authenticated;
  update public.deductions set status = 'autorizado', decision_note = 'ok' where id = d1;
  if (select decided_by from public.deductions where id = d1) <> dir then raise exception 'no registró quién autorizó'; end if;
  update public.deductions set status = 'cancelado' where id = d1;
  ok := false; begin update public.deductions set status = 'autorizado' where id = d1; exception when others then ok := true; end;
  if not ok then raise exception 'se reactivó un cancelado'; end if;
  reset role;
  raise notice 'OK: descuentos (capturar, autorizar por otra persona, cancelar, no editar)';
end $$;

-- 0011: ingresos extra (mismo control que descuentos)
do $$
declare admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        dir uuid := (select id from public.app_users where email = 'aldost228@gmail.com');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        emp uuid := (select id from public.employees where full_name = 'Coach 1');
        x uuid; ok boolean;
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  insert into public.extra_earnings (company_id, employee_id, label, amount_cents, kind, start_date, reason)
    values (car, emp, 'Bono competencia', 50000, 'unico', current_date, '1er lugar estatal') returning id into x;
  ok := false; begin update public.extra_earnings set status = 'autorizado' where id = x; exception when others then ok := true; end;
  if not ok then raise exception 'el capturista autorizó su propio ingreso extra'; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', dir::text, true);
  set local role authenticated;
  update public.extra_earnings set status = 'autorizado' where id = x;
  reset role;
  raise notice 'OK: ingresos extra';
end $$;

-- 0012: checadas de dos checadores para la misma persona; resubida gana; revisiones.
do $$
declare admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        vin uuid := (select id from public.companies where trade_name = 'ESGILA Viñedos');
        emp uuid := (select id from public.employees where full_name = 'Coach 1');   -- ligado a CAR '17','30' y Viñedos '28'
        i1 uuid; i2 uuid; i3 uuid; r uuid; n int; ok boolean;
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  insert into public.checker_imports (company_id, from_date, to_date, file_name) values (car, '2026-10-15', '2026-10-29', 'car.xls') returning id into i1;
  insert into public.checker_punches (import_id, company_id, device_id, date, times) values
    (i1, car, '17', '2026-10-16', '{16:03,20:01}'), (i1, car, '30', '2026-10-19', '{16:00,20:00}');
  insert into public.checker_imports (company_id, from_date, to_date, file_name) values (vin, '2026-10-15', '2026-10-29', 'vin.xls') returning id into i2;
  insert into public.checker_punches (import_id, company_id, device_id, date, times) values (i2, vin, '28', '2026-10-17', '{09:00,13:00}');
  select count(*) into n from public.employee_punches(emp, '2026-10-15', '2026-10-29');
  if n <> 3 then raise exception 'checadas cruzadas: %', n; end if;
  -- resubida del checador de CAR corrige el día 16
  insert into public.checker_imports (company_id, from_date, to_date, file_name) values (car, '2026-10-16', '2026-10-16', 'car2.xls') returning id into i3;
  insert into public.checker_punches (import_id, company_id, device_id, date, times) values (i3, car, '17', '2026-10-16', '{16:00,20:05}');
  if (select times from public.employee_punches(emp, '2026-10-16', '2026-10-16')) <> '{16:00,20:05}' then raise exception 'no ganó la subida más reciente'; end if;
  ok := false; begin insert into public.checker_punches (import_id, company_id, device_id, date, times) values (i3, car, '17', '2026-10-20', '{16:00}');
  exception when others then ok := true; end;
  if not ok then raise exception 'aceptó checada fuera del rango del reporte'; end if;
  insert into public.attendance_reviews (company_id, employee_id, date, kind, reason) values (car, emp, '2026-10-17', 'aprobar_extra', 'competencia') returning id into r;
  ok := false; begin update public.attendance_reviews set reason = 'x' where id = r; exception when others then ok := true; end;
  if not ok then raise exception 'se editó una revisión'; end if;
  update public.attendance_reviews set cancelled_at = now() where id = r;
  reset role;
  raise notice 'OK: checadas de dos checadores, resubida, revisiones';
end $$;
