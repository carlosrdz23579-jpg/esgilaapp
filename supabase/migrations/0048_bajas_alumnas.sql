-- =====================================================================
-- 0048  Bajas de alumnas con motivo (y reactivación), con historial. Repetible.
-- Dar de baja: termina sus planes en el último mes que viene, la marca inactiva y guarda
-- el motivo. Reactivar: la vuelve activa (los planes se asignan de nuevo en su ficha).
-- =====================================================================
alter table public.students add column if not exists withdrawn_on date;
alter table public.students add column if not exists withdrawal_reason text;

create table if not exists public.student_status_log (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  student_id  uuid not null,
  action      text not null check (action in ('baja', 'reactivacion', 'inscripcion')),
  reason      text,
  note        text,
  last_month  date,
  author_name text,
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  foreign key (student_id, company_id) references public.students(id, company_id)
);
create index if not exists ssl_student on public.student_status_log (student_id, created_at desc);
alter table public.student_status_log enable row level security;
drop policy if exists ssl_sel on public.student_status_log;
create policy ssl_sel on public.student_status_log for select using (app.can_see_students(company_id) or app.can_billing(company_id));
grant select on public.student_status_log to authenticated;

create or replace function public.withdraw_student(p_student uuid, p_reason text, p_note text default null, p_last_month date default null)
returns void language plpgsql security definer set search_path = public, app as $$
declare s public.students; lm date := date_trunc('month', coalesce(p_last_month, app.today_mx()))::date;
begin
  select * into s from public.students where id = p_student;
  if s.id is null then raise exception 'No existe la alumna'; end if;
  if not (app.has_perm('students','configure',s.company_id) or app.has_perm('billing','edit',s.company_id)) then raise exception 'Sin permiso para dar de baja'; end if;
  if length(trim(coalesce(p_reason, ''))) < 2 then raise exception 'Elige el motivo de la baja'; end if;
  -- termina sus planes individuales en ese mes (los que empiezan después se cancelan)
  update public.subscriptions set cancelled_at = now() where student_id = p_student and cancelled_at is null and start_month > lm;
  update public.subscriptions set end_month = lm where student_id = p_student and cancelled_at is null and (end_month is null or end_month > lm);
  update public.students set is_active = false, withdrawn_on = app.today_mx(), withdrawal_reason = trim(p_reason), updated_at = now() where id = p_student;
  insert into public.student_status_log (company_id, student_id, action, reason, note, last_month, author_name)
    values (s.company_id, p_student, 'baja', trim(p_reason), nullif(trim(p_note), ''), lm, app.author_name(auth.uid()));
end $$;
grant execute on function public.withdraw_student(uuid, text, text, date) to authenticated;

create or replace function public.reactivate_student(p_student uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public, app as $$
declare s public.students;
begin
  select * into s from public.students where id = p_student;
  if not (app.has_perm('students','configure',s.company_id) or app.has_perm('billing','edit',s.company_id)) then raise exception 'Sin permiso'; end if;
  update public.students set is_active = true, withdrawn_on = null, withdrawal_reason = null, updated_at = now() where id = p_student;
  insert into public.student_status_log (company_id, student_id, action, note, author_name) values (s.company_id, p_student, 'reactivacion', nullif(trim(p_note), ''), app.author_name(auth.uid()));
end $$;
grant execute on function public.reactivate_student(uuid, text) to authenticated;
