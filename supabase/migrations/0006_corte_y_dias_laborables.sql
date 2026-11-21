-- =====================================================================
-- 0006  Reglas de pago de ESGILA
-- 1) Corte: el día de pago NO entra en la quincena que se paga; cuenta en la siguiente
--    (pago del 15 = del último día del mes anterior al 14; pago del último día = del 15 al penúltimo).
-- 2) Días laborables por empleado: si el día de pago no es laborable para la persona,
--    se le paga su último día laborable anterior (lunes–sábado → sábado; lunes–jueves → jueves).
-- Las filas existentes de pay_schedules quedan con corte 'dia_anterior' (la regla del negocio).
-- =====================================================================
alter table public.pay_schedules
  add column if not exists cutoff text not null default 'dia_anterior'
  check (cutoff in ('dia_anterior', 'dia_de_pago'));

alter table public.employees
  add column if not exists work_days smallint[] not null default '{1,2,3,4,5,6}';   -- 0 domingo … 6 sábado

do $$ begin
  alter table public.employees add constraint employees_work_days_valid
    check (cardinality(work_days) between 1 and 7 and work_days <@ '{0,1,2,3,4,5,6}'::smallint[]);
exception when duplicate_object then null; end $$;
