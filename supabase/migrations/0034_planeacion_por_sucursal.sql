-- =====================================================================
-- 0034  Planeación configurable por sucursal
--   planning_period  'trimestral' | 'mensual'  — periodo de la planeación general y de cómo
--                    se cuentan los apuntes (CAR trimestral, Viñedos mensual)
--   planning_parts   0 | 1 | 2  — en cuántas partes entrega cada maestro su planeación del mes
--                    (0 = no entregan planeación mensual, sólo apuntes). CAR 0, Viñedos 2.
-- Repetible.
-- =====================================================================
alter table public.companies
  add column if not exists planning_period text not null default 'trimestral' check (planning_period in ('trimestral', 'mensual')),
  add column if not exists planning_parts  int  not null default 2 check (planning_parts between 0 and 2);

do $$ begin
  if not exists (select 1 from public.companies where planning_period = 'mensual') then
    update public.companies set planning_period = 'mensual', planning_parts = 2 where trade_name ilike '%viñedos%';
    update public.companies set planning_period = 'trimestral', planning_parts = 0 where trade_name ilike '%car%';
  end if;
end $$;

create or replace function app.guard_company_settings() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if app.is_backoffice() then return new; end if;
  if (new.warmup_schedule, new.late_deduction_bps, new.warmup_deduction_min, new.planning_deadline_day, new.planning_max_uploads,
      new.late_tolerance_min, new.warmup_slots, new.warmups_per_day, new.planning_period, new.planning_parts)
     is distinct from
     (old.warmup_schedule, old.late_deduction_bps, old.warmup_deduction_min, old.planning_deadline_day, old.planning_max_uploads,
      old.late_tolerance_min, old.warmup_slots, old.warmups_per_day, old.planning_period, old.planning_parts)
     and not app.has_perm('settings', 'configure', old.id) then
    raise exception 'Solo un director o quien tenga permiso de Configuración cambia estos ajustes';
  end if;
  if jsonb_typeof(new.warmup_schedule) <> 'object' then raise exception 'Calentamientos inválidos'; end if;
  return new;
end $$;
