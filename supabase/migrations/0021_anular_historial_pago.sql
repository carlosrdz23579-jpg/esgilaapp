-- =====================================================================
-- 0021  Anular filas del historial de pago (conceptos) por error de captura.
-- No se borra: se marca anulada con quién, cuándo y motivo, y deja de contar para todo
-- (pago vigente, nómina nueva y la regla de "una fila por concepto y fecha").
-- Las nóminas ya autorizadas no cambian: guardan el pago con el que se calcularon.
-- =====================================================================
alter table public.compensation_concepts
  add column if not exists annulled_at   timestamptz,
  add column if not exists annulled_by   uuid references public.app_users(id),
  add column if not exists annul_reason  text;

-- La unicidad ya no aplica a filas anuladas (permite volver a capturar esa fecha bien).
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.compensation_concepts'::regclass and contype = 'u'
             and pg_get_constraintdef(oid) ilike '%(employee_id, concept_key, effective_from)%'
  loop
    execute format('alter table public.compensation_concepts drop constraint %I', c);
  end loop;
end $$;
create unique index if not exists cc_unique_vigente on public.compensation_concepts (employee_id, concept_key, effective_from) where annulled_at is null;

create or replace function app.guard_concept_update() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'El historial de pago no se borra: anula la fila'; end if;
  if app.is_backoffice() then return new; end if;
  if old.annulled_at is not null then raise exception 'Esta fila ya está anulada'; end if;
  if (new.company_id, new.employee_id, new.concept_key, new.label, new.kind, new.amount_cents, new.weekdays, new.active, new.effective_from, new.reason, new.created_by, new.created_at)
     is distinct from
     (old.company_id, old.employee_id, old.concept_key, old.label, old.kind, old.amount_cents, old.weekdays, old.active, old.effective_from, old.reason, old.created_by, old.created_at)
     or new.annulled_at is null then
    raise exception 'Una fila del historial no se edita: anúlala y captura la correcta';
  end if;
  if coalesce(length(trim(new.annul_reason)), 0) = 0 then raise exception 'El motivo de la anulación es obligatorio'; end if;
  new.annulled_at := now(); new.annulled_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_cc_immutable on public.compensation_concepts;
drop trigger if exists trg_cc_guard_update on public.compensation_concepts;
create trigger trg_cc_guard_update before update or delete on public.compensation_concepts
  for each row execute function app.guard_concept_update();
drop trigger if exists aud_cc_update on public.compensation_concepts;
create trigger aud_cc_update after update on public.compensation_concepts for each row execute function app.audit();

drop policy if exists cc_update on public.compensation_concepts;
create policy cc_update on public.compensation_concepts for update
  using (app.emp_perm('salary','edit', employee_id)) with check (app.emp_perm('salary','edit', employee_id));
grant update on public.compensation_concepts to authenticated;

create or replace function app.concepts_at(p_employee uuid, p_date date)
returns setof public.compensation_concepts language sql stable as $$
  select distinct on (concept_key) * from public.compensation_concepts
  where employee_id = p_employee and effective_from <= p_date and annulled_at is null
  order by concept_key, effective_from desc, created_at desc
$$;
grant execute on all functions in schema app to authenticated;
