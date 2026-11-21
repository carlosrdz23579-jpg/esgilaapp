-- =====================================================================
-- 0012  Reportes del checador subidos, checadas por día y revisión de excepciones
-- - checker_imports: cada archivo subido (de qué checador = company_id, qué rango).
-- - checker_punches: checadas por número de checador y día. Si se vuelve a subir el mismo rango,
--   cuenta la subida más reciente de ese checador (las anteriores quedan como historial).
-- - attendance_reviews: decisiones del nominista por empleado y día (aprobar extra, justificar
--   falta, quitar retardo, corregir checadas, aceptar). Solo-agregar con cancelación.
-- =====================================================================
create table if not exists public.checker_imports (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),     -- checador (sucursal) de donde viene
  from_date   date not null,
  to_date     date not null check (to_date >= from_date),
  file_name   text not null,
  people      int not null default 0,
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default clock_timestamp()   -- hora real: ordena subidas aun dentro de una transacción
);
alter table public.checker_imports alter column created_at set default clock_timestamp();

create table if not exists public.checker_punches (
  import_id  uuid not null references public.checker_imports(id),
  company_id uuid not null references public.companies(id),
  device_id  text not null,
  date       date not null,
  times      text[] not null check (cardinality(times) between 1 and 20),
  primary key (import_id, device_id, date)
);
create index if not exists cp_company_device_date on public.checker_punches (company_id, device_id, date);

create or replace function app.guard_punch() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if not exists (select 1 from public.checker_imports i where i.id = new.import_id and i.company_id = new.company_id
                 and new.date between i.from_date and i.to_date) then
    raise exception 'La checada no corresponde al checador o al rango del reporte';
  end if;
  if exists (select 1 from unnest(new.times) t where t !~ '^([01]\d|2[0-3]):[0-5]\d$') then
    raise exception 'Hora de checada inválida';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_punch on public.checker_punches;
create trigger trg_guard_punch before insert on public.checker_punches for each row execute function app.guard_punch();
drop trigger if exists trg_punch_immutable on public.checker_punches;
create trigger trg_punch_immutable before update or delete on public.checker_punches for each row execute function app.block_mutation();
drop trigger if exists trg_import_immutable on public.checker_imports;
create trigger trg_import_immutable before update or delete on public.checker_imports for each row execute function app.block_mutation();
drop trigger if exists aud_imports on public.checker_imports;
create trigger aud_imports after insert on public.checker_imports for each row execute function app.audit();

-- Checadas vigentes de un empleado en un rango, juntando TODOS los checadores donde tiene número
-- (p. ej. Itzel: checador de CAR + checador de Viñedos). Por checador y día gana la subida más reciente.
create or replace function app.employee_punches(p_employee uuid, p_from date, p_to date)
returns table (date date, company_id uuid, device_id text, times text[])
language sql stable as $$
  select distinct on (p.company_id, p.device_id, p.date) p.date, p.company_id, p.device_id, p.times
  from public.checker_punches p
  join public.checker_imports i on i.id = p.import_id
  join public.checker_ids c on c.company_id = p.company_id and c.device_id = p.device_id
  where c.employee_id = p_employee and p.date between p_from and p_to
  order by p.company_id, p.device_id, p.date, i.created_at desc
$$;
create or replace function public.employee_punches(p_employee uuid, p_from date, p_to date)
returns table (date date, company_id uuid, device_id text, times text[])
language sql stable as $$ select * from app.employee_punches(p_employee, p_from, p_to) $$;
revoke execute on function public.employee_punches(uuid, date, date) from public, anon;
grant execute on function public.employee_punches(uuid, date, date) to authenticated;

create table if not exists public.attendance_reviews (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  employee_id  uuid not null,
  date         date not null,
  kind         text not null check (kind in ('aprobar_extra', 'justificar_falta', 'quitar_retardo', 'corregir_checadas', 'aceptar')),
  times        text[] check (times is null or cardinality(times) between 0 and 20),
  reason       text not null check (length(trim(reason)) > 0),
  created_by   uuid references public.app_users(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references public.app_users(id),
  check ((kind = 'corregir_checadas') = (times is not null)),
  foreign key (employee_id, company_id) references public.employees(id, company_id)
);
create index if not exists ar_emp_date on public.attendance_reviews (employee_id, date);

create or replace function app.guard_review() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Las revisiones no se borran: cancélalas'; end if;
  if tg_op = 'INSERT' then
    if new.times is not null and exists (select 1 from unnest(new.times) t where t !~ '^([01]\d|2[0-3]):[0-5]\d$') then
      raise exception 'Hora inválida en la corrección';
    end if;
    if not app.is_backoffice() then new.created_by := auth.uid(); new.cancelled_at := null; new.cancelled_by := null; end if;
    return new;
  end if;
  if app.is_backoffice() then return new; end if;
  if old.cancelled_at is not null or new.cancelled_at is null
     or (new.company_id, new.employee_id, new.date, new.kind, new.times, new.reason, new.created_by, new.created_at)
        is distinct from (old.company_id, old.employee_id, old.date, old.kind, old.times, old.reason, old.created_by, old.created_at) then
    raise exception 'Una revisión no se edita: solo se puede cancelar';
  end if;
  new.cancelled_at := now(); new.cancelled_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_guard_review on public.attendance_reviews;
create trigger trg_guard_review before insert or update or delete on public.attendance_reviews
  for each row execute function app.guard_review();
drop trigger if exists aud_reviews on public.attendance_reviews;
create trigger aud_reviews after insert or update on public.attendance_reviews for each row execute function app.audit();

alter table public.checker_imports    enable row level security;
alter table public.checker_punches    enable row level security;
alter table public.attendance_reviews enable row level security;

drop policy if exists ci_select on public.checker_imports;
create policy ci_select on public.checker_imports for select using (app.has_perm('payroll_hours','view', company_id));
drop policy if exists ci_insert on public.checker_imports;
create policy ci_insert on public.checker_imports for insert with check (app.has_perm('payroll_hours','edit', company_id));

-- Una checada se ve con permiso de horas sobre el checador, o sobre el empleado al que está ligada.
drop policy if exists cp_select on public.checker_punches;
create policy cp_select on public.checker_punches for select using (
  app.has_perm('payroll_hours','view', company_id)
  or exists (select 1 from public.checker_ids c where c.company_id = checker_punches.company_id
             and c.device_id = checker_punches.device_id and c.employee_id is not null
             and (app.emp_perm('payroll_hours','view', c.employee_id)
                  or c.employee_id = app.my_employee_id((select company_id from public.employees where id = c.employee_id)))));
drop policy if exists cp_insert on public.checker_punches;
create policy cp_insert on public.checker_punches for insert with check (app.has_perm('payroll_hours','edit', company_id));

-- Para cruzar checadores, quien ve al empleado necesita ver su número en el otro checador.
drop policy if exists chk_select on public.checker_ids;
create policy chk_select on public.checker_ids for select
  using (app.has_perm('payroll_hours','view', company_id)
         or (employee_id is not null and app.emp_perm('payroll_hours','view', employee_id)));

drop policy if exists ar_select on public.attendance_reviews;
create policy ar_select on public.attendance_reviews for select
  using (app.emp_perm('payroll_hours','view', employee_id) or employee_id = app.my_employee_id(company_id));
drop policy if exists ar_insert on public.attendance_reviews;
create policy ar_insert on public.attendance_reviews for insert with check (app.emp_perm('payroll_hours','edit', employee_id));
drop policy if exists ar_update on public.attendance_reviews;
create policy ar_update on public.attendance_reviews for update
  using (app.emp_perm('payroll_hours','edit', employee_id)) with check (app.emp_perm('payroll_hours','edit', employee_id));

grant select, insert on public.checker_imports, public.checker_punches to authenticated;
grant select, insert, update on public.attendance_reviews to authenticated;
grant execute on all functions in schema app to authenticated;
