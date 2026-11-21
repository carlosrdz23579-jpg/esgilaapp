-- =====================================================================
-- 0013  Nómina por periodo: corridas, versiones (respaldo/restaurar), líneas por empleado,
--       confirmación del empleado y autorización del director.
-- Flujo: borrador -> en_revision (publicada a empleados) -> autorizada (inmutable).
-- - Cada cálculo o corrección es una VERSIÓN nueva; restaurar copia una versión anterior
--   como versión nueva (nunca se pierde nada).
-- - El empleado confirma u observa la versión vigente hasta las 18:00 (hora de México) de su
--   día de pago. El silencio nunca cuenta como confirmación.
-- - Autoriza quien tenga permiso de autorizar nómina y no haya hecho la última versión
--   (salvo el director). El director puede autorizar aunque falten confirmaciones.
-- - Solo el director reabre una nómina autorizada (queda auditado).
-- =====================================================================
create table if not exists public.payroll_runs (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id),
  period_start       date not null,
  period_end         date not null check (period_end >= period_start),
  nominal_pay_date   date not null,
  status             text not null default 'borrador' check (status in ('borrador', 'en_revision', 'autorizada', 'cancelada')),
  current_version    int not null default 0,
  authorized_version int,
  authorized_by      uuid references public.app_users(id),
  authorized_at      timestamptz,
  created_by         uuid references public.app_users(id) default auth.uid(),
  created_at         timestamptz not null default now()
);
create unique index if not exists payroll_runs_period_key on public.payroll_runs (company_id, period_start, period_end) where status <> 'cancelada';

create table if not exists public.payroll_versions (
  run_id        uuid not null references public.payroll_runs(id),
  version       int not null check (version >= 1),
  note          text not null check (length(trim(note)) > 0),
  restored_from int,
  totals        jsonb not null default '{}',
  created_by    uuid references public.app_users(id) default auth.uid(),
  created_at    timestamptz not null default clock_timestamp(),
  primary key (run_id, version)
);

create table if not exists public.payroll_lines (
  run_id          uuid not null,
  version         int not null,
  company_id      uuid not null,
  employee_id     uuid not null,
  pay_date        date not null,                 -- día real de pago de esta persona (sábado, jueves…)
  gross_cents     bigint not null,
  deduction_cents bigint not null check (deduction_cents >= 0),
  net_cents       bigint not null,
  reported_cents  bigint,                        -- "nómina reportada" (pendiente de definir su cálculo)
  detail          jsonb not null,                -- desglose: conceptos, días, retardos, extras, descuentos
  primary key (run_id, version, employee_id),
  foreign key (run_id, version) references public.payroll_versions(run_id, version),
  foreign key (employee_id, company_id) references public.employees(id, company_id)
);

create table if not exists public.payroll_confirmations (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.payroll_runs(id),
  version     int not null,
  employee_id uuid not null references public.employees(id),
  decision    text not null check (decision in ('confirmada', 'observacion')),
  comment     text,
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  check (decision = 'confirmada' or length(trim(coalesce(comment, ''))) > 0)
);
create index if not exists pc_run_emp on public.payroll_confirmations (run_id, employee_id, created_at desc);

-- Inmutables: versiones, líneas y confirmaciones
drop trigger if exists trg_pv_immutable on public.payroll_versions;
create trigger trg_pv_immutable before update or delete on public.payroll_versions for each row execute function app.block_mutation();
drop trigger if exists trg_pl_immutable on public.payroll_lines;
create trigger trg_pl_immutable before update or delete on public.payroll_lines for each row execute function app.block_mutation();
drop trigger if exists trg_pc_immutable on public.payroll_confirmations;
create trigger trg_pc_immutable before update or delete on public.payroll_confirmations for each row execute function app.block_mutation();

-- Las corridas solo cambian por las funciones de abajo.
create or replace function app.guard_payroll_run() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Una nómina no se borra: se cancela'; end if;
  if tg_op = 'INSERT' then
    if not app.is_backoffice() then
      new.status := 'borrador'; new.current_version := 0; new.authorized_version := null;
      new.authorized_by := null; new.authorized_at := null; new.created_by := auth.uid();
    end if;
    return new;
  end if;
  if app.is_backoffice() or coalesce(current_setting('app.payroll_fn', true), '') = 'on' then return new; end if;
  raise exception 'La nómina solo cambia con sus acciones (guardar versión, publicar, autorizar, reabrir, cancelar)';
end $$;
drop trigger if exists trg_guard_payroll_run on public.payroll_runs;
create trigger trg_guard_payroll_run before insert or update or delete on public.payroll_runs
  for each row execute function app.guard_payroll_run();

drop trigger if exists aud_payroll_runs on public.payroll_runs;
create trigger aud_payroll_runs after insert or update on public.payroll_runs for each row execute function app.audit();

-- ---------- Acciones ----------
create or replace function app._run_for_edit(p_run uuid) returns public.payroll_runs
language plpgsql security definer set search_path = public, app as $$
declare r public.payroll_runs;
begin
  select * into r from public.payroll_runs where id = p_run for update;
  if not found then raise exception 'Nómina no encontrada'; end if;
  if not app.has_perm('payroll', 'edit', r.company_id) then raise exception 'Sin permiso para editar esta nómina'; end if;
  if r.status not in ('borrador', 'en_revision') then raise exception 'La nómina está %: no se puede modificar', r.status; end if;
  return r;
end $$;

-- Guarda una versión nueva con todas sus líneas (atómico). p_lines: [{employee_id, pay_date, gross_cents, deduction_cents, net_cents, reported_cents, detail}]
create or replace function app.save_payroll_version(p_run uuid, p_note text, p_lines jsonb, p_totals jsonb, p_restored_from int default null)
returns int language plpgsql security definer set search_path = public, app as $$
declare r public.payroll_runs; v int; l jsonb;
begin
  r := app._run_for_edit(p_run);
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'Líneas inválidas'; end if;
  v := r.current_version + 1;
  insert into public.payroll_versions (run_id, version, note, restored_from, totals) values (p_run, v, p_note, p_restored_from, coalesce(p_totals, '{}'));
  for l in select * from jsonb_array_elements(p_lines) loop
    if not exists (select 1 from public.employees e where e.id = (l->>'employee_id')::uuid and e.company_id = r.company_id) then
      raise exception 'Empleado % no pertenece a la empresa de esta nómina', l->>'employee_id';
    end if;
    if (l->>'net_cents')::bigint <> (l->>'gross_cents')::bigint - (l->>'deduction_cents')::bigint then
      raise exception 'Neto inconsistente para %', l->>'employee_id';
    end if;
    insert into public.payroll_lines (run_id, version, company_id, employee_id, pay_date, gross_cents, deduction_cents, net_cents, reported_cents, detail)
    values (p_run, v, r.company_id, (l->>'employee_id')::uuid, (l->>'pay_date')::date, (l->>'gross_cents')::bigint,
            (l->>'deduction_cents')::bigint, (l->>'net_cents')::bigint, nullif(l->>'reported_cents', '')::bigint, coalesce(l->'detail', '{}'));
  end loop;
  perform set_config('app.payroll_fn', 'on', true);
  update public.payroll_runs set current_version = v where id = p_run;
  perform set_config('app.payroll_fn', 'off', true);
  return v;
end $$;

-- Restaurar = copiar una versión anterior como versión nueva.
create or replace function app.restore_payroll_version(p_run uuid, p_version int, p_note text)
returns int language plpgsql security definer set search_path = public, app as $$
declare r public.payroll_runs; lines jsonb; tot jsonb;
begin
  r := app._run_for_edit(p_run);
  select totals into tot from public.payroll_versions where run_id = p_run and version = p_version;
  if not found then raise exception 'La versión % no existe', p_version; end if;
  select coalesce(jsonb_agg(jsonb_build_object('employee_id', employee_id, 'pay_date', pay_date, 'gross_cents', gross_cents,
           'deduction_cents', deduction_cents, 'net_cents', net_cents, 'reported_cents', reported_cents, 'detail', detail)), '[]')
    into lines from public.payroll_lines where run_id = p_run and version = p_version;
  return app.save_payroll_version(p_run, coalesce(nullif(trim(p_note), ''), 'Restaurada desde la versión ' || p_version), lines, tot, p_version);
end $$;

create or replace function app.set_payroll_status(p_run uuid, p_action text)
returns void language plpgsql security definer set search_path = public, app as $$
declare r public.payroll_runs; last_author uuid;
begin
  select * into r from public.payroll_runs where id = p_run for update;
  if not found then raise exception 'Nómina no encontrada'; end if;
  perform set_config('app.payroll_fn', 'on', true);
  if p_action = 'publicar' then
    if not app.has_perm('payroll', 'edit', r.company_id) then raise exception 'Sin permiso'; end if;
    if r.status <> 'borrador' or r.current_version = 0 then raise exception 'Solo se publica un borrador calculado'; end if;
    update public.payroll_runs set status = 'en_revision' where id = p_run;
  elsif p_action = 'autorizar' then
    if not app.has_perm('payroll', 'authorize', r.company_id) then raise exception 'Necesitas permiso de autorizar nómina'; end if;
    if r.status not in ('borrador', 'en_revision') or r.current_version = 0 then raise exception 'No hay una nómina calculada por autorizar'; end if;
    select created_by into last_author from public.payroll_versions where run_id = p_run and version = r.current_version;
    if last_author = auth.uid() and not app.is_director() then
      raise exception 'No puedes autorizar una nómina cuya última versión hiciste tú';
    end if;
    update public.payroll_runs set status = 'autorizada', authorized_version = r.current_version,
      authorized_by = auth.uid(), authorized_at = now() where id = p_run;
  elsif p_action = 'reabrir' then
    if not app.is_director() then raise exception 'Solo el director reabre una nómina autorizada'; end if;
    if r.status <> 'autorizada' then raise exception 'Solo se reabre una nómina autorizada'; end if;
    update public.payroll_runs set status = 'en_revision', authorized_version = null, authorized_by = null, authorized_at = null where id = p_run;
  elsif p_action = 'cancelar' then
    if not app.has_perm('payroll', 'edit', r.company_id) then raise exception 'Sin permiso'; end if;
    if r.status = 'autorizada' then raise exception 'Una nómina autorizada no se cancela; el director puede reabrirla'; end if;
    update public.payroll_runs set status = 'cancelada' where id = p_run;
  else
    raise exception 'Acción desconocida: %', p_action;
  end if;
  perform set_config('app.payroll_fn', 'off', true);
end $$;

-- Confirmación del empleado: solo su propia línea, de la versión vigente, publicada, antes de las 18:00 de su día de pago.
create or replace function app.guard_confirmation() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare r public.payroll_runs; pd date;
begin
  if app.is_backoffice() then return new; end if;
  select * into r from public.payroll_runs where id = new.run_id;
  if r.status <> 'en_revision' then raise exception 'Esta nómina no está abierta a revisión'; end if;
  if new.version <> r.current_version then raise exception 'Hay una versión más reciente de tu nómina; revisa esa'; end if;
  if new.employee_id is distinct from app.my_employee_id(r.company_id) then raise exception 'Solo puedes confirmar tu propia nómina'; end if;
  select pay_date into pd from public.payroll_lines where run_id = new.run_id and version = new.version and employee_id = new.employee_id;
  if not found then raise exception 'No apareces en esta nómina'; end if;
  if now() > ((pd + time '18:00') at time zone 'America/Mexico_City') then
    raise exception 'El plazo para revisar tu nómina terminó a las 18:00 de tu día de pago';
  end if;
  new.created_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_guard_confirmation on public.payroll_confirmations;
create trigger trg_guard_confirmation before insert on public.payroll_confirmations for each row execute function app.guard_confirmation();
drop trigger if exists aud_confirmations on public.payroll_confirmations;
create trigger aud_confirmations after insert on public.payroll_confirmations for each row execute function app.audit();

-- ---------- RLS ----------
-- Auxiliares (security definer) para no encadenar políticas entre payroll_runs y payroll_lines.
create or replace function app.run_published(p_run uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from public.payroll_runs r where r.id = p_run and r.status in ('en_revision', 'autorizada'));
$$;
create or replace function app.run_current_version(p_run uuid) returns int
language sql stable security definer set search_path = public, app as $$
  select current_version from public.payroll_runs where id = p_run;
$$;
create or replace function app.in_current_run(p_run uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from public.payroll_runs r join public.payroll_lines l on l.run_id = r.id and l.version = r.current_version
                 where r.id = p_run and l.employee_id = app.my_employee_id(r.company_id));
$$;

alter table public.payroll_runs          enable row level security;
alter table public.payroll_versions      enable row level security;
alter table public.payroll_lines         enable row level security;
alter table public.payroll_confirmations enable row level security;

drop policy if exists pr_select on public.payroll_runs;
create policy pr_select on public.payroll_runs for select using (
  app.has_perm('payroll', 'view', company_id)
  or (status in ('en_revision', 'autorizada') and app.in_current_run(id)));
drop policy if exists pr_insert on public.payroll_runs;
create policy pr_insert on public.payroll_runs for insert with check (app.has_perm('payroll', 'edit', company_id));

drop policy if exists pv_select on public.payroll_versions;
create policy pv_select on public.payroll_versions for select using (
  exists (select 1 from public.payroll_runs r where r.id = run_id and app.has_perm('payroll', 'view', r.company_id)));

-- Un empleado solo ve SU línea, y solo de nóminas publicadas o autorizadas.
drop policy if exists pl_select on public.payroll_lines;
create policy pl_select on public.payroll_lines for select using (
  app.has_perm('payroll', 'view', company_id)
  or (employee_id = app.my_employee_id(company_id)
      and app.run_published(run_id) and version = app.run_current_version(run_id)));

drop policy if exists pcf_select on public.payroll_confirmations;
create policy pcf_select on public.payroll_confirmations for select using (
  employee_id = app.my_employee_id((select company_id from public.employees where id = employee_id))
  or exists (select 1 from public.payroll_runs r where r.id = run_id and app.has_perm('payroll', 'view', r.company_id)));
drop policy if exists pcf_insert on public.payroll_confirmations;
create policy pcf_insert on public.payroll_confirmations for insert with check (true);   -- reglas en el trigger

grant select, insert on public.payroll_runs, public.payroll_confirmations to authenticated;
grant select on public.payroll_versions, public.payroll_lines to authenticated;

-- Entradas públicas (la API solo expone public)
create or replace function public.save_payroll_version(p_run uuid, p_note text, p_lines jsonb, p_totals jsonb)
returns int language sql as $$ select app.save_payroll_version(p_run, p_note, p_lines, p_totals, null) $$;
create or replace function public.restore_payroll_version(p_run uuid, p_version int, p_note text)
returns int language sql as $$ select app.restore_payroll_version(p_run, p_version, p_note) $$;
create or replace function public.set_payroll_status(p_run uuid, p_action text)
returns void language sql as $$ select app.set_payroll_status(p_run, p_action) $$;
revoke execute on function public.save_payroll_version(uuid, text, jsonb, jsonb), public.restore_payroll_version(uuid, int, text),
  public.set_payroll_status(uuid, text) from public, anon;
grant execute on function public.save_payroll_version(uuid, text, jsonb, jsonb), public.restore_payroll_version(uuid, int, text),
  public.set_payroll_status(uuid, text) to authenticated;
grant execute on all functions in schema app to authenticated;
