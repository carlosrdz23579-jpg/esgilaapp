-- =====================================================================
-- 0027  Configuración por sucursal (todo lo que antes estaba fijo)
--   warmup_schedule      calentamientos por DÍA DE LA SEMANA: {"1":[{"start":"16:00","end":"17:30","teachers":2},…], "6":[…]}
--                        un día sin entrada o con [] = no hay calentamiento ese día.
--   late_deduction_bps   rebaja por retardo (2500 = 25 % de una hora)
--   warmup_deduction_min minutos descontados por día sin calentamiento activo (30)
--   planning_deadline_day día del mes anterior en que vence la planeación mensual (25)
--   planning_max_uploads envíos permitidos por parte (2)
--   late_tolerance_min   ya existía (15)
-- Solo un director o quien tenga Configuración → Configurar cambia estos valores.
-- =====================================================================
alter table public.companies
  add column if not exists warmup_schedule jsonb,
  add column if not exists late_deduction_bps int not null default 2500 check (late_deduction_bps between 0 and 10000),
  add column if not exists warmup_deduction_min int not null default 30 check (warmup_deduction_min between 0 and 120),
  add column if not exists planning_deadline_day int not null default 25 check (planning_deadline_day between 1 and 28),
  add column if not exists planning_max_uploads int not null default 2 check (planning_max_uploads between 1 and 10);

-- Pasar lo de 0026 (mismos calentamientos todos los días) a calentamientos por día. Viñedos: lunes a jueves.
update public.companies set warmup_schedule = case
    when trade_name ilike '%vi_edos%' then jsonb_build_object(
      '1', '[{"start":"16:00","end":"17:30","teachers":2},{"start":"17:30","end":"19:00","teachers":2}]'::jsonb,
      '2', '[{"start":"16:00","end":"17:30","teachers":2},{"start":"17:30","end":"19:00","teachers":2}]'::jsonb,
      '3', '[{"start":"16:00","end":"17:30","teachers":2},{"start":"17:30","end":"19:00","teachers":2}]'::jsonb,
      '4', '[{"start":"16:00","end":"17:30","teachers":2},{"start":"17:30","end":"19:00","teachers":2}]'::jsonb)
    else (select jsonb_object_agg(d::text, '[{"start":"16:00","end":"16:30","teachers":1}]'::jsonb) from generate_series(1, 6) d)
  end
 where warmup_schedule is null or warmup_schedule = '{}'::jsonb;
alter table public.companies alter column warmup_schedule set default '{}'::jsonb;
alter table public.companies alter column warmup_schedule set not null;

create or replace function app.slot_teachers_wd(p_company uuid, p_weekday int, p_slot int) returns int
language sql stable security definer set search_path = public, app as $$
  select coalesce((warmup_schedule -> p_weekday::text -> (p_slot - 1) ->> 'teachers')::int, 0) from public.companies where id = p_company;
$$;

create or replace function app.guard_warmup_leader() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare wd int;
begin
  if tg_op <> 'INSERT' then raise exception 'No se edita: asigna de nuevo'; end if;
  if tg_table_name = 'warmup_leaders' then
    wd := extract(dow from new.date)::int;
    if new.mode = 'asignado' and new.employee_id is null then raise exception 'Falta elegir a la persona'; end if;
    if new.mode <> 'asignado' then new.employee_id := null; end if;
  else
    wd := new.weekday;
  end if;
  if new.position > app.slot_teachers_wd(new.company_id, wd, new.slot) then
    raise exception 'Ese día no tiene ese calentamiento o ese lugar (revisa Configuración → Calentamiento)';
  end if;
  if new.employee_id is not null and not exists (select 1 from public.employees e where e.id = new.employee_id and e.company_id = new.company_id) then
    raise exception 'La persona no pertenece a esta sucursal';
  end if;
  if not app.is_backoffice() then new.created_by := auth.uid(); end if;
  return new;
end $$;

-- Planeación: límite y envíos según la sucursal.
create or replace function app.planning_deadline_co(p_company uuid, p_month date) returns date
language sql stable security definer set search_path = public, app as $$
  select (date_trunc('month', p_month) - interval '1 month')::date + (coalesce((select planning_deadline_day from public.companies where id = p_company), 25) - 1);
$$;
create or replace view public.planning_status with (security_invoker = true) as
  select f.*, case when f.kind = 'mensual' then (f.created_at at time zone 'America/Mexico_City')::date > app.planning_deadline_co(f.company_id, f.period_start) end as late,
         case when f.kind = 'mensual' then app.planning_deadline_co(f.company_id, f.period_start) end as deadline
  from public.planning_files f;

create or replace function app.planning_max(p_company uuid) returns int
language sql stable security definer set search_path = public, app as $$
  select coalesce((select planning_max_uploads from public.companies where id = p_company), 2) $$;

-- El trigger de planeaciones lee el máximo de la sucursal.
do $$
declare src text;
begin
  select pg_get_functiondef('app.guard_planning()'::regprocedure) into src;
  if position('if n >= 2 then' in src) > 0 then
    src := replace(src, 'if n >= 2 then raise exception ''Ya subiste 2 veces esta parte de la planeación de ese mes''; end if;',
                        'if n >= app.planning_max(new.company_id) then raise exception ''Ya llegaste al máximo de envíos de esta parte para ese mes''; end if;');
    execute src;
  end if;
end $$;

-- Solo director o Configuración → Configurar cambian estos valores.
create or replace function app.guard_company_settings() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if app.is_backoffice() then return new; end if;
  if (new.warmup_schedule, new.late_deduction_bps, new.warmup_deduction_min, new.planning_deadline_day, new.planning_max_uploads,
      new.late_tolerance_min, new.warmup_slots, new.warmups_per_day)
     is distinct from
     (old.warmup_schedule, old.late_deduction_bps, old.warmup_deduction_min, old.planning_deadline_day, old.planning_max_uploads,
      old.late_tolerance_min, old.warmup_slots, old.warmups_per_day)
     and not app.has_perm('settings', 'configure', old.id) then
    raise exception 'Solo un director o quien tenga permiso de Configuración cambia estos ajustes';
  end if;
  if jsonb_typeof(new.warmup_schedule) <> 'object' then raise exception 'Calentamientos inválidos'; end if;
  return new;
end $$;
drop trigger if exists trg_guard_company_settings on public.companies;
create trigger trg_guard_company_settings before update on public.companies for each row execute function app.guard_company_settings();

-- Quien tiene Configuración puede guardar (la política de update de companies pedía companies/edit).
drop policy if exists co_update on public.companies;
create policy co_update on public.companies for update
  using (app.has_perm('companies','edit', id) or app.has_perm('settings','configure', id))
  with check (app.has_perm('companies','edit', id) or app.has_perm('settings','configure', id));
grant execute on all functions in schema app to authenticated;
