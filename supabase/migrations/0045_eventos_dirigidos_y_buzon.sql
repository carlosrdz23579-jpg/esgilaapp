-- =====================================================================
-- 0045  Eventos del calendario dirigidos (a departamentos, grupos o personas) y
--       buzón de quejas y sugerencias de los papás, con seguimiento. Repetible.
-- =====================================================================

-- ---------- Eventos dirigidos ----------
alter table public.calendar_events add column if not exists audience text not null default 'todos' check (audience in ('todos', 'dirigido'));
create table if not exists public.event_targets (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.calendar_events(id),
  department_id uuid references public.departments(id),
  group_id      uuid references public.groups(id),
  employee_id   uuid references public.employees(id),
  check (num_nonnulls(department_id, group_id, employee_id) = 1)
);
create index if not exists et_event on public.event_targets (event_id);

-- ¿El evento va para la persona que está viendo?
create or replace function app.event_for_me(p_event uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from public.event_targets t join public.employees e on e.user_id = auth.uid()
                 where t.event_id = p_event and (t.employee_id = e.id or t.department_id = e.department_id or t.group_id = e.group_id));
$$;
drop policy if exists ce_select on public.calendar_events;
create policy ce_select on public.calendar_events for select using (
  app.has_perm('calendar','edit',company_id) or app.is_director()
  or (app.can_see_company(company_id) and (audience = 'todos' or app.event_for_me(id))));
alter table public.event_targets enable row level security;
drop policy if exists et_sel on public.event_targets; create policy et_sel on public.event_targets for select using (
  app.has_perm('calendar','edit',(select company_id from public.calendar_events where id = event_id)) or app.event_for_me(event_id) or app.is_director());
drop policy if exists et_ins on public.event_targets; create policy et_ins on public.event_targets for insert with check (
  app.has_perm('calendar','edit',(select company_id from public.calendar_events where id = event_id)));
grant select, insert on public.event_targets to authenticated;

-- ---------- Buzón de quejas y sugerencias (de papás) ----------
create table if not exists public.parent_feedback (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  received_on    date not null default app.today_mx(),
  kind           text not null check (kind in ('queja', 'sugerencia', 'felicitacion')),
  area           text not null default 'otro',
  channel        text,                                   -- en persona, WhatsApp, llamada…
  reporter_name  text,
  reporter_phone text,
  student_id     uuid references public.students(id),
  employee_id    uuid references public.employees(id),  -- persona a la que se refiere (si aplica)
  description    text not null check (length(trim(description)) > 0),
  priority       text not null default 'media' check (priority in ('baja', 'media', 'alta')),
  status         text not null default 'nueva' check (status in ('nueva', 'en_revision', 'atendida', 'cerrada')),
  author_name    text,
  created_by     uuid references public.app_users(id) default auth.uid(),
  created_at     timestamptz not null default now()
);
create index if not exists pf_company on public.parent_feedback (company_id, status, received_on desc);
create table if not exists public.parent_feedback_updates (
  id          uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references public.parent_feedback(id),
  status      text check (status is null or status in ('nueva', 'en_revision', 'atendida', 'cerrada')),
  comment     text,
  author_name text,
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  check (status is not null or length(trim(coalesce(comment, ''))) > 0)
);

create or replace function app.guard_feedback() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'DELETE' then raise exception 'Las quejas no se borran: se cierran'; end if;
  if tg_op = 'INSERT' then
    if not app.is_backoffice() then new.created_by := auth.uid(); new.status := 'nueva'; end if;
    new.author_name := app.author_name(new.created_by); return new;
  end if;
  if coalesce(current_setting('app.fb_status', true), '') = 'on'
     and (to_jsonb(new) - 'status') = (to_jsonb(old) - 'status') then return new; end if;
  raise exception 'No se edita: agrega un seguimiento';
end $$;
drop trigger if exists trg_guard_pf on public.parent_feedback;
create trigger trg_guard_pf before insert or update or delete on public.parent_feedback for each row execute function app.guard_feedback();

-- Un seguimiento con estado cambia el estado de la queja (sólo así cambia)
create or replace function app.feedback_update() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if not app.is_backoffice() then new.created_by := auth.uid(); end if;
  new.author_name := app.author_name(new.created_by);
  if new.status is not null then
    perform set_config('app.fb_status', 'on', true);
    update public.parent_feedback set status = new.status where id = new.feedback_id;
    perform set_config('app.fb_status', '', true);
  end if;
  return new;
end $$;
drop trigger if exists trg_pf_update on public.parent_feedback_updates;
create trigger trg_pf_update before insert on public.parent_feedback_updates for each row execute function app.feedback_update();
drop trigger if exists aud_pf on public.parent_feedback;
create trigger aud_pf after insert or update on public.parent_feedback for each row execute function app.audit();
drop trigger if exists aud_pfu on public.parent_feedback_updates;
create trigger aud_pfu after insert on public.parent_feedback_updates for each row execute function app.audit();

alter table public.parent_feedback enable row level security;
alter table public.parent_feedback_updates enable row level security;
drop policy if exists pf_sel on public.parent_feedback; create policy pf_sel on public.parent_feedback for select using (
  created_by = auth.uid() or app.has_perm('complaints','view',company_id) or app.has_perm('complaints','edit',company_id));
drop policy if exists pf_ins on public.parent_feedback; create policy pf_ins on public.parent_feedback for insert with check (
  app.has_perm('complaints','create',company_id) or app.has_perm('complaints','edit',company_id));
drop policy if exists pfu_sel on public.parent_feedback_updates; create policy pfu_sel on public.parent_feedback_updates for select using (
  exists (select 1 from public.parent_feedback f where f.id = feedback_id));
drop policy if exists pfu_ins on public.parent_feedback_updates; create policy pfu_ins on public.parent_feedback_updates for insert with check (
  exists (select 1 from public.parent_feedback f where f.id = feedback_id and (app.has_perm('complaints','edit',f.company_id)
    or (f.created_by = auth.uid() and status is null))));
grant select, insert on public.parent_feedback, public.parent_feedback_updates to authenticated;
