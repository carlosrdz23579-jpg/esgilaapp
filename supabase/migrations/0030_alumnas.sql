-- =====================================================================
-- 0030  Alumnas (importadas de EVO), clases, inscripción por mes,
--       pase de lista con hora de llegada y notas internas.
-- Requiere 0029. Repetible.
-- =====================================================================

-- ---------- Clases (actividad + horario, por sucursal) ----------
create table if not exists public.class_groups (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  activity      text not null check (length(trim(activity)) > 0),
  start_time    text not null check (start_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  end_time      text not null check (end_time   ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  duration_override_min int check (duration_override_min is null or duration_override_min between 15 and 600),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (company_id, activity, start_time)
);
-- Duración detectada (fin − inicio) salvo que se haya puesto una excepción manual.
create or replace view public.class_groups_v with (security_invoker = true) as
  select c.*,
    ((split_part(end_time, ':', 1)::int * 60 + split_part(end_time, ':', 2)::int)
     - (split_part(start_time, ':', 1)::int * 60 + split_part(start_time, ':', 2)::int)) as detected_min,
    coalesce(duration_override_min,
      ((split_part(end_time, ':', 1)::int * 60 + split_part(end_time, ':', 2)::int)
       - (split_part(start_time, ':', 1)::int * 60 + split_part(start_time, ':', 2)::int))) as duration_min
  from public.class_groups c;

-- ---------- Alumnas ----------
create table if not exists public.students (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  evo_id       text,
  full_name    text not null check (length(trim(full_name)) > 0),
  phone        text,
  birth_date   date,
  enrolled_on  date,
  is_active    boolean not null default true,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (company_id, evo_id),
  unique (id, company_id)
);

-- ---------- Importaciones de EVO (bitácora) ----------
create table if not exists public.evo_imports (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  month       date not null check (extract(day from month) = 1),
  file_name   text,
  students    int not null default 0,
  classes     int not null default 0,
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default now()
);

-- ---------- Inscripción: qué días le toca cada clase, por mes ----------
create table if not exists public.student_enrollments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  student_id  uuid not null,
  class_id    uuid not null references public.class_groups(id),
  month       date not null check (extract(day from month) = 1),
  weekdays    smallint[] not null default '{}',     -- 0 domingo … 6 sábado
  import_id   uuid references public.evo_imports(id),
  created_at  timestamptz not null default now(),
  unique (student_id, class_id, month),
  foreign key (student_id, company_id) references public.students(id, company_id)
);
create index if not exists se_class_month on public.student_enrollments (class_id, month);

-- ---------- Pase de lista (sólo se agrega; la última fila del día gana) ----------
create table if not exists public.student_attendance (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  student_id  uuid not null,
  class_id    uuid not null references public.class_groups(id),
  date        date not null,
  arrival     text check (arrival is null or arrival ~ '^([01]\d|2[0-3]):[0-5]\d$'),   -- null = faltó
  extra       boolean not null default false,     -- vino un día que no le tocaba
  annulled    boolean not null default false,     -- se quitó de la lista (registro equivocado)
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (student_id, company_id) references public.students(id, company_id)
);
create index if not exists sat_class_date on public.student_attendance (class_id, date, student_id, created_at desc);
create or replace view public.student_attendance_latest with (security_invoker = true) as
  select distinct on (student_id, class_id, date) * from public.student_attendance
  order by student_id, class_id, date, created_at desc;

create or replace function app.guard_student_att() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op <> 'INSERT' then raise exception 'No se edita: vuelve a pasar lista de ese día'; end if;
  if not app.is_backoffice() then
    new.created_by := auth.uid();
    if new.date > app.today_mx() then raise exception 'No se pasa lista de días futuros'; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_sat on public.student_attendance;
create trigger trg_guard_sat before insert or update or delete on public.student_attendance for each row execute function app.guard_student_att();

-- ---------- Notas internas de maestros sobre alumnas ----------
-- Se "borran" marcándolas; dirección las sigue viendo.
create table if not exists public.student_notes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  student_id  uuid not null,
  body        text not null check (length(trim(body)) > 0),
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid references public.app_users(id),
  foreign key (student_id, company_id) references public.students(id, company_id)
);
alter table public.student_notes add column if not exists author_name text;
create index if not exists sn_student on public.student_notes (student_id, created_at desc);

create or replace function app.guard_student_note() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Las notas no se eliminan: se marcan como borradas'; end if;
  if tg_op = 'INSERT' then
    if not app.is_backoffice() then new.created_by := auth.uid(); new.deleted_at := null; new.deleted_by := null; end if;
    new.author_name := (select coalesce(nullif(trim(full_name), ''), email) from public.app_users where id = new.created_by);
    return new;
  end if;
  -- UPDATE: sólo marcar como borrada, por su autor o dirección
  if new.body <> old.body or new.student_id <> old.student_id or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at or new.author_name is distinct from old.author_name or old.deleted_at is not null then
    raise exception 'Una nota sólo se puede borrar, no editar';
  end if;
  if not app.is_backoffice() and old.created_by is distinct from auth.uid() and not app.is_director() then
    raise exception 'Sólo quien escribió la nota puede borrarla';
  end if;
  new.deleted_at := coalesce(new.deleted_at, now());
  new.deleted_by := coalesce(auth.uid(), new.deleted_by);
  return new;
end $$;
drop trigger if exists trg_guard_sn on public.student_notes;
create trigger trg_guard_sn before insert or update or delete on public.student_notes for each row execute function app.guard_student_note();

-- Auditoría
drop trigger if exists aud_sat on public.student_attendance;
create trigger aud_sat after insert on public.student_attendance for each row execute function app.audit();
drop trigger if exists aud_sn on public.student_notes;
create trigger aud_sn after insert or update on public.student_notes for each row execute function app.audit();
drop trigger if exists aud_cg on public.class_groups;
create trigger aud_cg after insert or update on public.class_groups for each row execute function app.audit();

-- ---------- Permiso de lectura: cualquier acción del módulo deja ver la lista ----------
create or replace function app.can_see_students(c uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.has_perm('students','view',c) or app.has_perm('students','edit',c)
      or app.has_perm('students','create',c) or app.has_perm('students','configure',c);
$$;

-- ---------- RLS ----------
alter table public.class_groups        enable row level security;
alter table public.students            enable row level security;
alter table public.evo_imports         enable row level security;
alter table public.student_enrollments enable row level security;
alter table public.student_attendance  enable row level security;
alter table public.student_notes       enable row level security;

drop policy if exists cg_select on public.class_groups;
create policy cg_select on public.class_groups for select using (app.can_see_students(company_id));
drop policy if exists cg_update on public.class_groups;
create policy cg_update on public.class_groups for update using (app.has_perm('students','configure',company_id)) with check (app.has_perm('students','configure',company_id));
drop policy if exists st_select on public.students;
create policy st_select on public.students for select using (app.can_see_students(company_id));
drop policy if exists st_update on public.students;
create policy st_update on public.students for update using (app.has_perm('students','configure',company_id)) with check (app.has_perm('students','configure',company_id));
drop policy if exists ei_select on public.evo_imports;
create policy ei_select on public.evo_imports for select using (app.can_see_students(company_id));
drop policy if exists se_select on public.student_enrollments;
create policy se_select on public.student_enrollments for select using (app.can_see_students(company_id));
drop policy if exists sat_select on public.student_attendance;
create policy sat_select on public.student_attendance for select using (app.can_see_students(company_id));
drop policy if exists sat_insert on public.student_attendance;
create policy sat_insert on public.student_attendance for insert with check (app.has_perm('students','edit',company_id));
drop policy if exists sn_select on public.student_notes;
create policy sn_select on public.student_notes for select using (
  (deleted_at is null and (app.has_perm('students','create',company_id) or app.has_perm('students','view',company_id)))
  or app.is_director());
drop policy if exists sn_insert on public.student_notes;
create policy sn_insert on public.student_notes for insert with check (app.has_perm('students','create',company_id));
drop policy if exists sn_update on public.student_notes;
create policy sn_update on public.student_notes for update using (created_by = auth.uid() or app.is_director()) with check (true);

grant select, update on public.class_groups, public.students to authenticated;
grant select on public.evo_imports, public.student_enrollments, public.class_groups_v, public.student_attendance_latest to authenticated;
grant select, insert on public.student_attendance to authenticated;
grant select, insert, update on public.student_notes to authenticated;

-- ---------- Importar de EVO ----------
-- p_rows: [{evo_id, name, phone, birth (yyyy-mm-dd|null), enrolled, activity, start "HH:MM", end, weekdays:[..]}]
-- Crea/actualiza clases y alumnas (por ID de EVO) y reemplaza la inscripción de ESE mes
-- sólo en las clases que vienen en el archivo. Devuelve el id de la importación.
create or replace function public.import_evo(p_company uuid, p_month date, p_file text, p_rows jsonb)
returns uuid language plpgsql security definer set search_path = public, app as $$
declare imp uuid; r jsonb; cls uuid; stu uuid; m date := date_trunc('month', p_month)::date;
        touched uuid[] := '{}'; nstu int := 0;
begin
  if not app.has_perm('students','configure',p_company) then raise exception 'Sin permiso para importar alumnas'; end if;
  insert into evo_imports(company_id, month, file_name) values (p_company, m, p_file) returning id into imp;
  -- 1) clases
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into class_groups(company_id, activity, start_time, end_time)
      values (p_company, trim(r->>'activity'), r->>'start', r->>'end')
      on conflict (company_id, activity, start_time) do update set end_time = excluded.end_time, is_active = true
      returning id into cls;
    if not cls = any(touched) then touched := touched || cls; end if;
  end loop;
  delete from student_enrollments where class_id = any(touched) and month = m;
  -- 2) alumnas + inscripción
  for r in select * from jsonb_array_elements(p_rows) loop
    select id into cls from class_groups where company_id = p_company and activity = trim(r->>'activity') and start_time = r->>'start';
    insert into students(company_id, evo_id, full_name, phone, birth_date, enrolled_on)
      values (p_company, nullif(r->>'evo_id',''), trim(r->>'name'), nullif(r->>'phone',''),
              nullif(r->>'birth','')::date, nullif(r->>'enrolled','')::date)
      on conflict (company_id, evo_id) do update set full_name = excluded.full_name,
        phone = coalesce(excluded.phone, students.phone), birth_date = coalesce(excluded.birth_date, students.birth_date),
        enrolled_on = coalesce(excluded.enrolled_on, students.enrolled_on), is_active = true, updated_at = now()
      returning id into stu;
    insert into student_enrollments(company_id, student_id, class_id, month, weekdays, import_id)
      values (p_company, stu, cls, m, coalesce((select array_agg(x::smallint) from jsonb_array_elements_text(r->'weekdays') x), '{}'), imp)
      on conflict (student_id, class_id, month) do update set
        weekdays = (select array_agg(distinct w order by w) from unnest(student_enrollments.weekdays || excluded.weekdays) w),
        import_id = imp;
    nstu := nstu + 1;
  end loop;
  update evo_imports set students = nstu, classes = coalesce(array_length(touched,1),0) where id = imp;
  return imp;
end $$;
revoke all on function public.import_evo(uuid, date, text, jsonb) from public;
grant execute on function public.import_evo(uuid, date, text, jsonb) to authenticated;
