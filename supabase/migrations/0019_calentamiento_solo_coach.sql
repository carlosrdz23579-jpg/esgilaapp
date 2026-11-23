-- =====================================================================
-- 0019  El calentamiento aplica SOLO a personas del departamento Coach (no a Staff).
-- El permiso para marcarlo sí puede tenerlo cualquiera (incluido Staff).
-- El descuento por día sin calentamiento activo es de 30 minutos de su tarifa (lo calcula la nómina).
-- =====================================================================
create or replace function app.is_coach(p_employee uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from public.employees e join public.departments d on d.id = e.department_id
                 where e.id = p_employee and lower(trim(d.name)) = 'coach');
$$;

create or replace function app.guard_warmup() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op <> 'INSERT' then raise exception 'El registro de calentamiento no se edita: marca de nuevo el día'; end if;
  if not app.is_coach(new.employee_id) then raise exception 'El calentamiento solo aplica a coaches'; end if;
  if not app.is_backoffice() then
    new.created_by := auth.uid();
    if new.date > app.today_mx() then raise exception 'No se marca el calentamiento de días futuros'; end if;
    if exists (select 1 from public.employees e where e.id = new.employee_id and e.user_id = auth.uid()) then
      raise exception 'No puedes marcar tu propio calentamiento';
    end if;
  end if;
  return new;
end $$;
grant execute on all functions in schema app to authenticated;
