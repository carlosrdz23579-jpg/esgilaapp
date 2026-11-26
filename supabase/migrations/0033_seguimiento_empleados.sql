-- =====================================================================
-- 0033  Seguimiento de empleados
--   indicators          catálogo por sucursal (sí/no o escala 1–5), opcionalmente por departamento
--   indicator_marks     marca por persona, indicador y día (sólo se agrega; la última gana)
--   employee_notes      notas con fecha y autor: 'publica' (la ve el empleado) o 'privada'
--                       (sólo quien tiene permiso). Se borran marcándolas; dirección las sigue viendo.
-- Permisos: followup view = ver · followup edit = escribir notas y marcar
--           indicators configure = editar el catálogo. Se pueden dar por departamento o grupo.
-- Repetible.
-- =====================================================================
create table if not exists public.indicators (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  name          text not null check (length(trim(name)) > 0),
  description   text,
  kind          text not null default 'si_no' check (kind in ('si_no', 'escala')),
  department_id uuid references public.departments(id),        -- null = aplica a todos
  sort          int not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (company_id, name)
);

create table if not exists public.indicator_marks (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  employee_id   uuid not null,
  indicator_id  uuid not null references public.indicators(id),
  date          date not null,
  value         smallint check (value is null or value between 0 and 5),   -- si_no: 1/0 · escala: 1..5 · null = quitar
  note          text,
  author_name   text,
  created_by    uuid references public.app_users(id) default auth.uid(),
  created_at    timestamptz not null default clock_timestamp(),
  foreign key (employee_id, company_id) references public.employees(id, company_id)
);
create index if not exists im_emp_date on public.indicator_marks (employee_id, date, indicator_id, created_at desc);
create or replace view public.indicator_marks_latest with (security_invoker = true) as
  select distinct on (employee_id, indicator_id, date) * from public.indicator_marks
  order by employee_id, indicator_id, date, created_at desc;

create table if not exists public.employee_notes (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  employee_id   uuid not null,
  date          date not null default app.today_mx(),
  visibility    text not null check (visibility in ('publica', 'privada')),
  body          text not null check (length(trim(body)) > 0),
  author_name   text,
  created_by    uuid references public.app_users(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid references public.app_users(id),
  foreign key (employee_id, company_id) references public.employees(id, company_id)
);
create index if not exists en_emp on public.employee_notes (employee_id, date desc);

-- ---------- Reglas ----------
create or replace function app.author_name(u uuid) returns text
language sql stable security definer set search_path = public, app as $$
  select coalesce(nullif(trim(full_name), ''), email) from public.app_users where id = u;
$$;
create or replace function app.is_me(p_employee uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from public.employees where id = p_employee and user_id = auth.uid());
$$;

create or replace function app.guard_indicator_mark() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op <> 'INSERT' then raise exception 'No se edita: vuelve a marcar el día'; end if;
  if not app.is_backoffice() then
    new.created_by := auth.uid();
    if app.is_me(new.employee_id) then raise exception 'No puedes calificarte a ti mismo'; end if;
    if new.date > app.today_mx() then raise exception 'No se marcan días futuros'; end if;
  end if;
  if (select kind from public.indicators where id = new.indicator_id) = 'si_no' and new.value not in (0, 1) then
    raise exception 'Este indicador es sí/no';
  end if;
  new.author_name := app.author_name(new.created_by);
  return new;
end $$;
drop trigger if exists trg_guard_im on public.indicator_marks;
create trigger trg_guard_im before insert or update or delete on public.indicator_marks for each row execute function app.guard_indicator_mark();

create or replace function app.guard_employee_note() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Las notas no se eliminan: se marcan como borradas'; end if;
  if tg_op = 'INSERT' then
    if not app.is_backoffice() then
      new.created_by := auth.uid(); new.deleted_at := null; new.deleted_by := null;
      if app.is_me(new.employee_id) then raise exception 'No puedes escribir notas de seguimiento sobre ti mismo'; end if;
    end if;
    new.author_name := app.author_name(new.created_by);
    return new;
  end if;
  if new.body <> old.body or new.employee_id <> old.employee_id or new.visibility <> old.visibility or new.date <> old.date
     or new.created_by is distinct from old.created_by or new.author_name is distinct from old.author_name or old.deleted_at is not null then
    raise exception 'Una nota sólo se puede borrar, no editar';
  end if;
  if not app.is_backoffice() and old.created_by is distinct from auth.uid() and not app.is_director() then
    raise exception 'Sólo quien escribió la nota puede borrarla';
  end if;
  new.deleted_at := coalesce(new.deleted_at, now()); new.deleted_by := coalesce(auth.uid(), new.deleted_by);
  return new;
end $$;
drop trigger if exists trg_guard_en on public.employee_notes;
create trigger trg_guard_en before insert or update or delete on public.employee_notes for each row execute function app.guard_employee_note();

drop trigger if exists aud_ind on public.indicators;
create trigger aud_ind after insert or update on public.indicators for each row execute function app.audit();
drop trigger if exists aud_im on public.indicator_marks;
create trigger aud_im after insert on public.indicator_marks for each row execute function app.audit();
drop trigger if exists aud_en on public.employee_notes;
create trigger aud_en after insert or update on public.employee_notes for each row execute function app.audit();

-- ---------- RLS ----------
alter table public.indicators      enable row level security;
alter table public.indicator_marks enable row level security;
alter table public.employee_notes  enable row level security;

drop policy if exists ind_select on public.indicators;
create policy ind_select on public.indicators for select using (app.can_see_company(company_id));
drop policy if exists ind_insert on public.indicators;
create policy ind_insert on public.indicators for insert with check (app.has_perm('indicators','configure',company_id));
drop policy if exists ind_update on public.indicators;
create policy ind_update on public.indicators for update using (app.has_perm('indicators','configure',company_id)) with check (app.has_perm('indicators','configure',company_id));

drop policy if exists im_select on public.indicator_marks;
create policy im_select on public.indicator_marks for select using (
  app.is_me(employee_id) or app.emp_perm('followup','view',employee_id) or app.emp_perm('followup','edit',employee_id));
drop policy if exists im_insert on public.indicator_marks;
create policy im_insert on public.indicator_marks for insert with check (app.emp_perm('followup','edit',employee_id));

drop policy if exists en_select on public.employee_notes;
create policy en_select on public.employee_notes for select using (
  app.is_director()
  or (deleted_at is null and (app.emp_perm('followup','view',employee_id) or app.emp_perm('followup','edit',employee_id)
                              or (visibility = 'publica' and app.is_me(employee_id)))));
drop policy if exists en_insert on public.employee_notes;
create policy en_insert on public.employee_notes for insert with check (app.emp_perm('followup','edit',employee_id));
drop policy if exists en_update on public.employee_notes;
create policy en_update on public.employee_notes for update using (created_by = auth.uid() or app.is_director()) with check (true);

grant select, insert, update on public.indicators, public.employee_notes to authenticated;
grant select, insert on public.indicator_marks to authenticated;
grant select on public.indicator_marks_latest to authenticated;

-- Quien da seguimiento necesita ver la lista de personas.
drop policy if exists emp_select on public.employees;
create policy emp_select on public.employees for select
  using (user_id = auth.uid()
         or app.has_perm('employees','view', company_id, department_id, group_id, id)
         or app.is_head_coach_for(company_id, department_id)
         or app.has_perm('warmup','edit', company_id, department_id, group_id, id)
         or app.has_perm('warmup','view', company_id, department_id, group_id, id)
         or app.has_perm('warmup','configure', company_id)
         or app.has_perm('uniform','edit', company_id)
         or app.has_perm('planning','view', company_id)
         or app.has_perm('followup','view', company_id, department_id, group_id, id)
         or app.has_perm('followup','edit', company_id, department_id, group_id, id));

-- ---------- Catálogo inicial (sólo si la sucursal no tiene ninguno) ----------
insert into public.indicators (company_id, name, description, kind, sort)
select c.id, x.name, x.descr, x.kind, x.sort
from public.companies c
cross join (values
  ('Puntualidad', 'Llegó a tiempo a su primera clase', 'si_no', 1),
  ('Uniforme', 'Uniforme completo y correcto', 'si_no', 2),
  ('Calentamiento activo', 'Participó activamente en el calentamiento', 'si_no', 3),
  ('Planeación', 'Trae y sigue su planeación de clase', 'si_no', 4),
  ('Actitud y trato', 'Con alumnas, padres y compañeros (1 a 5)', 'escala', 5)
) as x(name, descr, kind, sort)
where not exists (select 1 from public.indicators i where i.company_id = c.id);
