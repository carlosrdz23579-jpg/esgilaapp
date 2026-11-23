-- =====================================================================
-- 0020  Campos de "Datos Generales" (formato de Colaboradores ESGILA) en el expediente.
-- Salud (tipo de sangre, alergias/condiciones) se guarda con los mismos permisos del expediente:
-- lo ve quien tiene permiso de ver empleados; un empleado solo ve el suyo.
-- =====================================================================
alter table public.employees
  add column if not exists external_no       int,          -- "No." del Excel de colaboradores
  add column if not exists area              text,         -- Área tal como la usan (Coaching, Administración, Limpieza…)
  add column if not exists termination_date  date,         -- Fecha de baja
  add column if not exists nss               text,
  add column if not exists emergency_contact text,
  add column if not exists emergency_phone   text,
  add column if not exists blood_type        text,
  add column if not exists health_notes      text,         -- Alergias / condiciones
  add column if not exists shirt_size        text,
  add column if not exists bank              text;
create index if not exists employees_curp_idx on public.employees (upper(curp)) where curp is not null;
