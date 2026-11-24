-- =====================================================================
-- 0023  Anular (borrar) horarios base capturados por error.
-- No se borra la fila: queda anulada con quién, cuándo y motivo, y deja de contar para la
-- asistencia y la nómina nueva. Las nóminas ya calculadas guardan sus horas y no cambian.
-- =====================================================================
alter table public.employee_work_schedules
  add column if not exists annulled_at  timestamptz,
  add column if not exists annulled_by  uuid references public.app_users(id),
  add column if not exists annul_reason text;

create or replace function app.guard_work_schedule() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Un horario no se borra: anúlalo'; end if;
  if app.is_backoffice() then return new; end if;
  if old.annulled_at is not null then raise exception 'Este horario ya está anulado'; end if;
  if (new.company_id, new.employee_id, new.blocks, new.effective_from, new.reason, new.created_by, new.created_at)
     is distinct from (old.company_id, old.employee_id, old.blocks, old.effective_from, old.reason, old.created_by, old.created_at)
     or new.annulled_at is null then
    raise exception 'Un horario no se edita: anúlalo y captura el correcto';
  end if;
  if coalesce(length(trim(new.annul_reason)), 0) = 0 then raise exception 'El motivo es obligatorio'; end if;
  new.annulled_at := now(); new.annulled_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_ews_immutable on public.employee_work_schedules;
drop trigger if exists trg_ews_guard on public.employee_work_schedules;
create trigger trg_ews_guard before update or delete on public.employee_work_schedules
  for each row execute function app.guard_work_schedule();
drop trigger if exists aud_ews_update on public.employee_work_schedules;
create trigger aud_ews_update after update on public.employee_work_schedules for each row execute function app.audit();

drop policy if exists ews_update on public.employee_work_schedules;
create policy ews_update on public.employee_work_schedules for update
  using (app.emp_perm('payroll_hours','edit', employee_id)) with check (app.emp_perm('payroll_hours','edit', employee_id));
grant update on public.employee_work_schedules to authenticated;
grant execute on all functions in schema app to authenticated;
