-- Verificaciones tras aplicar migraciones + seeds. Cualquier fallo aborta (ON_ERROR_STOP).
do $$
declare n int;
begin
  select count(*) into n from public.companies;            if n <> 2  then raise exception 'empresas: %', n; end if;
  select count(*) into n from public.departments;          if n <> 4  then raise exception 'departamentos: %', n; end if;
  select count(*) into n from public.groups;               if n <> 12 then raise exception 'grupos: %', n; end if;
  select count(*) into n from public.permission_grants where module <> 'warmup';    if n <> 91 then raise exception 'permisos admin: %', n; end if;
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

-- 0013: nómina con versiones, restaurar, confirmación y autorización
do $$
declare admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        dir uuid := (select id from public.app_users where email = 'aldost228@gmail.com');
        hc_user uuid := (select id from auth.users where email = 'hc@x.com');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        c1 uuid := (select id from public.employees where full_name = 'Coach 1');
        hc uuid := (select id from public.employees where full_name = 'HC');
        run uuid; v int; ok boolean; n int; hoy date := app.today_mx();
        lines1 jsonb; lines2 jsonb;
begin
  lines1 := jsonb_build_array(
    jsonb_build_object('employee_id', c1, 'pay_date', hoy + 3, 'gross_cents', 100000, 'deduction_cents', 2500, 'net_cents', 97500, 'detail', '{}'::jsonb),
    jsonb_build_object('employee_id', hc, 'pay_date', hoy + 3, 'gross_cents', 200000, 'deduction_cents', 0, 'net_cents', 200000, 'detail', '{}'::jsonb));
  lines2 := jsonb_set(lines1, '{0,gross_cents}', '90000'); lines2 := jsonb_set(lines2, '{0,net_cents}', '87500');

  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  insert into public.payroll_runs (company_id, period_start, period_end, nominal_pay_date) values (car, hoy - 12, hoy + 2, hoy + 3) returning id into run;
  v := public.save_payroll_version(run, 'Cálculo inicial', lines1, '{}');
  v := public.save_payroll_version(run, 'Corrección de horas', lines2, '{}');
  if v <> 2 then raise exception 'versión %', v; end if;
  v := public.restore_payroll_version(run, 1, '');
  if v <> 3 or (select net_cents from public.payroll_lines where run_id = run and version = 3 and employee_id = c1) <> 97500 then raise exception 'restaurar'; end if;
  ok := false; begin perform public.save_payroll_version(run, 'mal', jsonb_set(lines1, '{0,net_cents}', '1'), '{}'); exception when others then ok := true; end;
  if not ok then raise exception 'aceptó neto inconsistente'; end if;
  begin update public.payroll_runs set status = 'autorizada' where id = run; exception when others then null; end;
  if (select status from public.payroll_runs where id = run) <> 'borrador' then raise exception 'cambió estado sin la función'; end if;
  perform public.set_payroll_status(run, 'publicar');
  ok := false; begin perform public.set_payroll_status(run, 'autorizar'); exception when others then ok := true; end;
  if not ok then raise exception 'el admin autorizó su propia versión'; end if;
  reset role;

  -- El Head Coach (empleado en esta nómina) ve SOLO su línea y confirma.
  perform set_config('request.jwt.claim.sub', hc_user::text, true);
  set local role authenticated;
  select count(*) into n from public.payroll_lines where run_id = run; if n <> 1 then raise exception 'el empleado ve % líneas', n; end if;
  ok := false; begin insert into public.payroll_confirmations (run_id, version, employee_id, decision) values (run, 2, hc, 'confirmada'); exception when others then ok := true; end;
  if not ok then raise exception 'confirmó una versión vieja'; end if;
  ok := false; begin insert into public.payroll_confirmations (run_id, version, employee_id, decision) values (run, 3, c1, 'confirmada'); exception when others then ok := true; end;
  if not ok then raise exception 'confirmó la nómina de otro'; end if;
  insert into public.payroll_confirmations (run_id, version, employee_id, decision, comment) values (run, 3, hc, 'observacion', 'Me faltó un día');
  reset role;

  -- El director autoriza aunque Coach 1 no confirmó; luego nada cambia; reabrir solo director.
  perform set_config('request.jwt.claim.sub', dir::text, true);
  set local role authenticated;
  perform public.set_payroll_status(run, 'autorizar');
  reset role;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  ok := false; begin perform public.save_payroll_version(run, 'tarde', lines1, '{}'); exception when others then ok := true; end;
  if not ok then raise exception 'modificó una nómina autorizada'; end if;
  ok := false; begin perform public.set_payroll_status(run, 'reabrir'); exception when others then ok := true; end;
  if not ok then raise exception 'el admin reabrió'; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', dir::text, true);
  set local role authenticated;
  perform public.set_payroll_status(run, 'reabrir');
  if (select status from public.payroll_runs where id = run) <> 'en_revision' then raise exception 'reabrir'; end if;
  reset role;
  raise notice 'OK: nómina (versiones, restaurar, publicar, confirmar solo la propia, autorizar por otro, reabrir director)';
end $$;

-- 0014: tarifa de referencia para retardo
do $$
declare car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        c1 uuid := (select id from public.employees where full_name = 'Coach 1');
begin
  insert into public.compensation_concepts (company_id, employee_id, concept_key, label, kind, amount_cents, effective_from, reason)
    values (car, c1, 'base_retardo', 'Base para retardo', 'tarifa_retardo', 6500, current_date, 'prueba');
  raise notice 'OK: tarifa_retardo';
end $$;

-- 0015: préstamos
do $$
declare admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        dir uuid := (select id from public.app_users where email = 'aldost228@gmail.com');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        c1 uuid := (select id from public.employees where full_name = 'Coach 1');
        hc uuid := (select id from public.employees where full_name = 'HC');
        loan uuid; ploan uuid; sk uuid; run uuid; v int; ok boolean; hoy date := app.today_mx();
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  ok := false; begin insert into public.loans (company_id, employee_id, lender, principal_cents, interest_cents, installment_cents, start_date, reason)
    values (car, c1, 'empresa', 300000, 10000, 50000, hoy, 'x'); exception when check_violation then ok := true; end;
  if not ok then raise exception 'préstamo de empresa con interés'; end if;
  insert into public.loans (company_id, employee_id, lender, principal_cents, installment_cents, start_date, reason)
    values (car, c1, 'empresa', 100000, 60000, hoy - 20, 'emergencia') returning id into loan;
  insert into public.loans (company_id, employee_id, lender, principal_cents, interest_cents, installment_cents, start_date, reason)
    values (car, c1, 'director', 200000, 20000, 50000, hoy - 20, 'personal') returning id into ploan;
  ok := false; begin update public.loans set status = 'activo' where id = loan; exception when others then ok := true; end;
  if not ok then raise exception 'el capturista autorizó su préstamo'; end if;
  insert into public.loan_skips (loan_id, skip_date, reason) values (loan, hoy, 'lo pidió el empleado') returning id into sk;
  reset role;

  perform set_config('request.jwt.claim.sub', dir::text, true);
  set local role authenticated;
  update public.loans set status = 'activo' where id in (loan, ploan);
  update public.loan_skips set status = 'autorizado' where id = sk;
  reset role;

  -- Nómina autorizada con descuento de préstamo registra el abono; reabrir lo revierte.
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  ok := false; begin insert into public.loan_payments (loan_id, amount_cents, source) values (loan, 60000, 'nomina'); exception when others then ok := true; end;
  if not ok then raise exception 'abono de nómina a mano'; end if;
  insert into public.payroll_runs (company_id, period_start, period_end, nominal_pay_date) values (car, hoy - 40, hoy - 26, hoy - 25) returning id into run;
  v := public.save_payroll_version(run, 'con préstamo', jsonb_build_array(jsonb_build_object('employee_id', c1, 'pay_date', hoy - 25,
        'gross_cents', 200000, 'deduction_cents', 60000, 'net_cents', 140000,
        'detail', jsonb_build_object('loanLines', jsonb_build_array(jsonb_build_object('loan_id', loan, 'amount', '60000')))),
        jsonb_build_object('employee_id', hc, 'pay_date', hoy - 25, 'gross_cents', 1, 'deduction_cents', 0, 'net_cents', 1, 'detail', '{}'::jsonb)), '{}');
  reset role;
  perform set_config('request.jwt.claim.sub', dir::text, true);
  set local role authenticated;
  perform public.set_payroll_status(run, 'autorizar');
  if app.loan_paid(loan) <> 60000 then raise exception 'no registró el abono: %', app.loan_paid(loan); end if;
  perform public.set_payroll_status(run, 'reabrir');
  if app.loan_paid(loan) <> 0 then raise exception 'no revirtió el abono'; end if;
  perform public.set_payroll_status(run, 'autorizar');
  reset role;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  insert into public.loan_payments (loan_id, amount_cents, source, note) values (loan, 40000, 'manual', 'pagó en efectivo');
  if (select status from public.loans where id = loan) <> 'liquidado' then raise exception 'no se liquidó'; end if;
  ok := false; begin insert into public.loan_payments (loan_id, amount_cents, source, note) values (ploan, 999999, 'manual', 'x'); exception when others then ok := true; end;
  if not ok then raise exception 'abono mayor al saldo'; end if;
  reset role;
  raise notice 'OK: préstamos (sin interés de empresa, autorizar, saltar por director, abono al autorizar, reversa, liquidar)';
end $$;

-- 0016: efectivo
do $$
declare admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        run uuid := (select id from public.payroll_runs where status = 'autorizada' limit 1);
        ok boolean;
begin
  if (select pay_method from public.employees where full_name = 'Coach 1') <> 'efectivo' then raise exception 'pay_method por defecto'; end if;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  ok := false; begin insert into public.cash_reconciliations (run_id, company_id, planned_cents, withdrawn_cents, delivered_cents)
    values (run, car, 140000, 150000, 140000); exception when others then ok := true; end;
  if not ok then raise exception 'aceptó diferencia sin nota'; end if;
  insert into public.cash_reconciliations (run_id, company_id, planned_cents, withdrawn_cents, delivered_cents, note)
    values (run, car, 140000, 150000, 140000, 'sobraron $100, regresan a caja');
  reset role;
  raise notice 'OK: efectivo (forma de pago, conciliación con nota obligatoria si hay diferencia)';
end $$;

-- 0018: calentamiento
do $$
declare admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        c1 uuid := (select id from public.employees where full_name = 'Coach 1');
        ok boolean;
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  insert into public.warmup_marks (company_id, employee_id, date, active) values (car, c1, app.today_mx() - 1, false);
  insert into public.warmup_marks (company_id, employee_id, date, active, note) values (car, c1, app.today_mx() - 1, true, 'me equivoqué');
  if (select active from public.warmup_latest where employee_id = c1 and date = app.today_mx() - 1) is not true then raise exception 'último registro'; end if;
  ok := false; begin insert into public.warmup_marks (company_id, employee_id, date, active) values (car, c1, app.today_mx() + 1, false); exception when others then ok := true; end;
  if not ok then raise exception 'marcó día futuro'; end if;
  ok := false; begin insert into public.warmup_marks (company_id, employee_id, date, active)
    values (car, (select id from public.employees where full_name = 'Staff 1'), app.today_mx() - 1, false); exception when others then ok := true; end;
  if not ok then raise exception 'marcó calentamiento a Staff'; end if;
  reset role;
  raise notice 'OK: calentamiento (solo coaches)';
end $$;

-- 0021: anular historial de pago
do $$
declare admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        c1 uuid := (select id from public.employees where full_name = 'Coach 1');
        x uuid; ok boolean;
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  insert into public.compensation_concepts (company_id, employee_id, concept_key, label, kind, amount_cents, effective_from, reason)
    values (car, c1, 'clases', 'Clases', 'por_hora', 8000, '2026-11-23', 'error') returning id into x;
  ok := false; begin update public.compensation_concepts set amount_cents = 9000 where id = x; exception when others then ok := true; end;
  if not ok then raise exception 'se editó el importe'; end if;
  ok := false; begin update public.compensation_concepts set annulled_at = now() where id = x; exception when others then ok := true; end;
  if not ok then raise exception 'anuló sin motivo'; end if;
  update public.compensation_concepts set annulled_at = now(), annul_reason = 'capturé mal el importe' where id = x;
  insert into public.compensation_concepts (company_id, employee_id, concept_key, label, kind, amount_cents, effective_from, reason)
    values (car, c1, 'clases', 'Clases', 'por_hora', 9000, '2026-11-23', 'corrección');   -- misma fecha: ya se permite
  if (select amount_cents from app.concepts_at(c1, '2026-11-30') where concept_key = 'clases') <> 9000 then raise exception 'vigente tras anular'; end if;
  if (select annulled_by from public.compensation_concepts where id = x) <> admin then raise exception 'no registró quién anuló'; end if;
  reset role;
  raise notice 'OK: anular historial de pago';
end $$;

-- 0022: directores múltiples, pausar funciones propias, nunca sin director
do $$
declare dir uuid := (select id from public.app_users where email = 'aldost228@gmail.com');
        admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        dir2 uuid; ok boolean;
begin
  perform set_config('request.jwt.claim.sub', dir::text, true);
  set local role authenticated;
  if not app.has_perm('payroll', 'authorize', car) then raise exception 'director sin nómina'; end if;
  perform public.set_my_paused('payroll', true);
  if app.has_perm('payroll', 'authorize', car) then raise exception 'pausado y aún autoriza'; end if;
  if not app.has_perm('employees', 'view', car) then raise exception 'pausar nómina afectó empleados'; end if;
  perform public.set_my_paused('payroll', false);
  if not app.has_perm('payroll', 'authorize', car) then raise exception 'no se reactivó'; end if;
  ok := false; begin perform public.set_my_paused('users', true); exception when others then ok := true; end;
  if not ok then raise exception 'pausó usuarios'; end if;
  ok := false; begin update public.app_users set role = 'admin' where id = dir; exception when others then ok := true; end;
  if not ok then raise exception 'se quedó sin director'; end if;
  ok := false; begin update public.app_users set paused_modules = '{cash}' where id = admin; exception when others then ok := true; end;
  if not ok then raise exception 'pausó funciones de otro'; end if;
  reset role;
  -- Segundo director: con dos, uno puede dejar de serlo.
  insert into auth.users(email) values ('dir2@x.com') returning id into dir2;
  perform set_config('request.jwt.claim.sub', dir::text, true);
  set local role authenticated;
  update public.app_users set role = 'director', status = 'active' where id = dir2;
  update public.app_users set role = 'admin' where id = dir2;
  reset role;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  ok := false; begin perform public.set_my_paused('cash', true); exception when others then ok := true; end;
  if not ok then raise exception 'un admin pausó'; end if;
  reset role;
  raise notice 'OK: usuarios (varios directores, pausar propias funciones, siempre un director)';
end $$;

-- 0023: anular horarios
do $$
declare admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        c1 uuid := (select id from public.employees where full_name = 'Coach 1');
        x uuid := (select id from public.employee_work_schedules where employee_id = c1 limit 1); ok boolean;
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  ok := false; begin update public.employee_work_schedules set blocks = '[]' where id = x; exception when others then ok := true; end;
  if not ok then raise exception 'se editó un horario'; end if;
  update public.employee_work_schedules set annulled_at = now(), annul_reason = 'fecha mal' where id = x;
  if (select annulled_by from public.employee_work_schedules where id = x) <> admin then raise exception 'no registró'; end if;
  reset role;
  raise notice 'OK: anular horarios';
end $$;

-- 0024: calendario de coaches
do $$
declare admin uuid := (select id from public.app_users where email = 'aldost228@gmail.com');   -- director
        hc_user uuid := (select id from auth.users where email = 'hc@x.com');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        hc uuid := (select id from public.employees where full_name = 'HC');
        c1 uuid := (select id from public.employees where full_name = 'Coach 1');
        a uuid; ok boolean; n int;
begin
  if app.planning_deadline('2026-12-01') <> '2026-11-25' then raise exception 'límite'; end if;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  insert into public.warmup_leaders (company_id, date, employee_id) values (car, '2026-11-24', hc);
  insert into public.planning_files (company_id, kind, period_start, period_end, title, storage_path, file_name)
    values (car, 'general', '2026-10-01', '2026-12-31', 'Trimestre 4', car || '/general/t4.pdf', 't4.pdf');
  insert into public.staff_attendance (company_id, employee_id, date, arrival, uniform) values (car, c1, app.today_mx() - 1, '15:58', false);
  reset role;
  -- Como empleado (HC): ve la general, sube y oculta su apunte; no sube general; no ve apuntes de otro.
  perform set_config('request.jwt.claim.sub', hc_user::text, true);
  set local role authenticated;
  if not exists (select 1 from public.planning_files where kind = 'general') then raise exception 'no ve la general'; end if;
  insert into public.planning_files (company_id, kind, employee_id, period_start, note) values (car, 'apunte', hc, current_date, 'objetivo: rueda') returning id into a;
  ok := false; begin insert into public.planning_files (company_id, kind, period_start, period_end, note) values (car, 'general', current_date, current_date, 'x'); exception when others then ok := true; end;
  if not ok then raise exception 'empleado subió general'; end if;
  ok := false; begin insert into public.planning_files (company_id, kind, employee_id, period_start, note) values (car, 'apunte', c1, current_date, 'x'); exception when others then ok := true; end;
  if not ok then raise exception 'subió apunte de otro'; end if;
  insert into public.planning_files (company_id, kind, employee_id, period_start, part, note) values (car, 'mensual', hc, '2020-01-01', 1, 'v1'), (car, 'mensual', hc, '2020-01-01', 1, 'v2');
  ok := false; begin insert into public.planning_files (company_id, kind, employee_id, period_start, part, note) values (car, 'mensual', hc, '2020-01-01', 1, 'v3'); exception when others then ok := true; end;
  if not ok then raise exception 'tercer envío'; end if;
  perform public.hide_planning_file(a);
  if exists (select 1 from public.planning_files where id = a) then raise exception 'sigue viendo su apunte borrado'; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  if not exists (select 1 from public.planning_files where id = a and hidden_at is not null) then raise exception 'dirección no ve el borrado'; end if;
  select count(*) into n from public.planning_status where kind = 'mensual' and late; if n <> 2 then raise exception 'tardías: %', n; end if;
  reset role;
  raise notice 'OK: calendario de coaches (líder de calentamiento, planeaciones, apuntes ocultos, asistencia de maestros)';
end $$;

-- 0025: dos calentamientos en Viñedos, uno en CAR
do $$
declare dir uuid := (select id from public.app_users where email = 'aldost228@gmail.com');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        vin uuid := (select id from public.companies where trade_name = 'ESGILA Viñedos'); ok boolean;
begin
  if (select warmups_per_day from public.companies where id = vin) <> 2 then raise exception 'Viñedos no tiene 2'; end if;
  perform set_config('request.jwt.claim.sub', dir::text, true);
  set local role authenticated;
  insert into public.warmup_leaders (company_id, date, slot, mode) values (vin, '2026-11-24', 2, 'sin_asignar');
  ok := false; begin insert into public.warmup_leaders (company_id, date, slot) values (car, '2026-11-24', 2); exception when others then ok := true; end;
  if not ok then raise exception 'CAR aceptó 2 calentamientos'; end if;
  reset role;
  raise notice 'OK: calentamientos por día por sucursal';
end $$;

-- 0026: rotación de calentamiento (2 × 2 en Viñedos)
do $$
declare dir uuid := (select id from public.app_users where email = 'aldost228@gmail.com');
        vin uuid := (select id from public.companies where trade_name = 'ESGILA Viñedos');
        car uuid := (select id from public.companies where trade_name = 'ESGILA CAR');
        coach_vin uuid := (select id from public.departments where company_id = vin and name = 'Coach');
        g uuid; ok boolean;
begin
  if (select count(*) from public.warmup_rotation where company_id = vin) <> 16 then raise exception 'rotación inicial'; end if;
  insert into public.employees (company_id, full_name, department_id) values (vin, 'Giomari Prueba', coach_vin) returning id into g;
  perform set_config('request.jwt.claim.sub', dir::text, true);
  set local role authenticated;
  insert into public.warmup_rotation (company_id, weekday, slot, position, employee_id) values (vin, 1, 2, 2, g);
  ok := false; begin insert into public.warmup_rotation (company_id, weekday, slot, position) values (vin, 1, 2, 3); exception when others then ok := true; end;
  if not ok then raise exception 'aceptó 3er maestro'; end if;
  ok := false; begin insert into public.warmup_leaders (company_id, date, slot, position, mode, employee_id) values (car, '2026-11-24', 1, 2, 'asignado', null); exception when others then ok := true; end;
  if not ok then raise exception 'CAR aceptó 2 maestros'; end if;
  insert into public.warmup_leaders (company_id, date, slot, position, mode) values (vin, '2026-11-23', 1, 1, 'rotacion');
  reset role;
  raise notice 'OK: rotación de calentamiento';
end $$;

-- 0027: configuración por sucursal
do $$
declare dir uuid := (select id from public.app_users where email = 'aldost228@gmail.com');
        admin uuid := (select id from public.app_users where email = 'carlosrdz23579@gmail.com');
        vin uuid := (select id from public.companies where trade_name = 'ESGILA Viñedos'); ok boolean;
begin
  perform set_config('request.jwt.claim.sub', dir::text, true);
  set local role authenticated;
  ok := false; begin insert into public.warmup_leaders (company_id, date, slot, position, mode) values (vin, '2026-11-27', 1, 1, 'sin_asignar'); exception when others then ok := true; end;
  if not ok then raise exception 'aceptó calentamiento en viernes'; end if;
  update public.companies set warmup_schedule = warmup_schedule || '{"6":[{"start":"10:00","end":"11:00","teachers":1}]}', planning_deadline_day = 20 where id = vin;
  insert into public.warmup_leaders (company_id, date, slot, position, mode) values (vin, '2026-11-28', 1, 1, 'sin_asignar');
  if app.planning_deadline_co(vin, '2026-12-01') <> '2026-11-20' then raise exception 'límite configurable'; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  set local role authenticated;
  ok := false; begin update public.companies set late_deduction_bps = 0 where id = vin; exception when others then ok := true; end;
  if not ok then raise exception 'admin sin permiso cambió la configuración'; end if;
  reset role;
  raise notice 'OK: configuración por sucursal';
end $$;
