-- =====================================================================
-- 0042  Más datos de la alumna, foto, y prospectos con clase muestra. Repetible.
--   students + correo, género, apodo, CURP, tutor (nombre y teléfono), observaciones,
--              cómo nos conoció, foto (bucket privado 'fotos-alumnas'),
--              kind 'alumna' | 'prospecto' (prospecto = aún sin plan, viene a clase muestra)
--   trial_classes  clase muestra: grupo, fecha, si vino y comentarios
-- =====================================================================
alter table public.students
  add column if not exists email          text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add column if not exists gender         text check (gender is null or gender in ('femenino', 'masculino', 'otro')),
  add column if not exists nickname       text,
  add column if not exists curp           text check (curp is null or length(curp) = 18),
  add column if not exists guardian_name  text,
  add column if not exists guardian_phone text,
  add column if not exists notes          text,
  add column if not exists source         text,
  add column if not exists photo_path     text,
  add column if not exists kind           text not null default 'alumna' check (kind in ('alumna', 'prospecto')),
  add column if not exists became_student_on date;

create table if not exists public.trial_classes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  student_id  uuid not null,
  class_id    uuid references public.class_groups(id),
  date        date not null,
  attended    boolean,                       -- null = aún no se sabe
  comments    text,
  author_name text,
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  cancelled_at timestamptz,
  foreign key (student_id, company_id) references public.students(id, company_id)
);
create index if not exists tc_date on public.trial_classes (company_id, date);

create or replace function app.guard_trial() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Una clase muestra no se borra: se cancela'; end if;
  if tg_op = 'INSERT' then
    if not app.is_backoffice() then new.created_by := auth.uid(); end if;
    new.author_name := app.author_name(new.created_by);
    return new;
  end if;
  if (new.student_id, new.company_id, new.created_by, new.created_at) is distinct from (old.student_id, old.company_id, old.created_by, old.created_at) then
    raise exception 'No se cambia de alumna: cancela y agenda otra';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_tc on public.trial_classes;
create trigger trg_guard_tc before insert or update or delete on public.trial_classes for each row execute function app.guard_trial();
drop trigger if exists aud_trial_classes on public.trial_classes;
create trigger aud_trial_classes after insert or update on public.trial_classes for each row execute function app.audit();
drop trigger if exists aud_students on public.students;
create trigger aud_students after insert or update on public.students for each row execute function app.audit();

alter table public.trial_classes enable row level security;
drop policy if exists tc_sel on public.trial_classes; create policy tc_sel on public.trial_classes for select using (app.can_see_students(company_id) or app.can_billing(company_id));
drop policy if exists tc_ins on public.trial_classes; create policy tc_ins on public.trial_classes for insert with check (app.has_perm('students','configure',company_id) or app.has_perm('billing','edit',company_id));
drop policy if exists tc_upd on public.trial_classes; create policy tc_upd on public.trial_classes for update
  using (app.has_perm('students','configure',company_id) or app.has_perm('billing','edit',company_id) or app.has_perm('students','edit',company_id)) with check (true);
grant select, insert, update on public.trial_classes to authenticated;

-- Fotos: <empresa>/<alumna>/<archivo>. Las ve quien ve alumnas; las sube quien las da de alta.
create or replace function app.student_photo_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = public, app as $$
declare co uuid;
begin
  begin co := split_part(p_name, '/', 1)::uuid; exception when others then return false; end;
  return case when p_write then app.has_perm('students','configure',co) or app.has_perm('billing','edit',co)
              else app.can_see_students(co) or app.can_billing(co) end;
end $$;
grant execute on function app.student_photo_ok(text, boolean) to authenticated;
do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('fotos-alumnas', 'fotos-alumnas', false) on conflict (id) do nothing;
    execute 'drop policy if exists fotos_alumnas_select on storage.objects';
    execute 'create policy fotos_alumnas_select on storage.objects for select to authenticated using (bucket_id = ''fotos-alumnas'' and app.student_photo_ok(name, false))';
    execute 'drop policy if exists fotos_alumnas_insert on storage.objects';
    execute 'create policy fotos_alumnas_insert on storage.objects for insert to authenticated with check (bucket_id = ''fotos-alumnas'' and app.student_photo_ok(name, true))';
  end if;
end $$;
