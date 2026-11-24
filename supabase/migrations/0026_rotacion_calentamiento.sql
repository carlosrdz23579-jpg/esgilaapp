-- =====================================================================
-- 0026  Calentamientos por sucursal con varios maestros y rotación semanal.
--   companies.warmup_slots: [{"label":"4:00–5:30 pm","teachers":2}, …]
--     Viñedos: 2 calentamientos × 2 maestros.  CAR: 1 × 1.
--   warmup_rotation: quién dirige cada día de la semana (se repite cada semana).
--   warmup_leaders: cambios de un día concreto (mode: asignado | sin_asignar | rotacion = volver a la rotación).
-- El último registro de cada (día de la semana o fecha, calentamiento, lugar) es el que cuenta.
-- =====================================================================
alter table public.companies add column if not exists warmup_slots jsonb;

update public.companies set warmup_slots = '[{"label":"Calentamiento","teachers":1}]' where warmup_slots is null;
alter table public.companies alter column warmup_slots set default '[{"label":"Calentamiento","teachers":1}]';
alter table public.companies alter column warmup_slots set not null;
do $$ begin
  alter table public.companies add constraint companies_warmup_slots_valid check (
    jsonb_typeof(warmup_slots) = 'array' and jsonb_array_length(warmup_slots) between 1 and 4);
exception when duplicate_object then null; end $$;
update public.companies set warmups_per_day = jsonb_array_length(warmup_slots);

create or replace function app.slot_teachers(p_company uuid, p_slot int) returns int
language sql stable security definer set search_path = public, app as $$
  select coalesce((warmup_slots -> (p_slot - 1) ->> 'teachers')::int, 0) from public.companies where id = p_company;
$$;

-- Cambios de un día
alter table public.warmup_leaders add column if not exists position smallint not null default 1 check (position between 1 and 4);
alter table public.warmup_leaders add column if not exists mode text not null default 'asignado' check (mode in ('asignado', 'sin_asignar', 'rotacion'));
-- Los días que ya estaban "sin asignar" pasan a ese modo (la regla de no editar se pausa solo para esto).
alter table public.warmup_leaders disable trigger trg_guard_wl;
update public.warmup_leaders set mode = 'sin_asignar' where employee_id is null and mode = 'asignado';
alter table public.warmup_leaders enable trigger trg_guard_wl;
drop index if exists wl_company_date_slot;
create index if not exists wl_company_date_slot_pos on public.warmup_leaders (company_id, date, slot, position, created_at desc);
drop view if exists public.warmup_leader_latest;
create view public.warmup_leader_latest with (security_invoker = true) as
  select distinct on (company_id, date, slot, position) company_id, date, slot, position, mode, employee_id, created_by, created_at
  from public.warmup_leaders order by company_id, date, slot, position, created_at desc;

-- Rotación semanal
create table if not exists public.warmup_rotation (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  weekday     smallint not null check (weekday between 0 and 6),
  slot        smallint not null check (slot between 1 and 4),
  position    smallint not null check (position between 1 and 4),
  employee_id uuid references public.employees(id),          -- null = nadie
  created_by  uuid references public.app_users(id) default auth.uid(),
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists wr_idx on public.warmup_rotation (company_id, weekday, slot, position, created_at desc);
create or replace view public.warmup_rotation_latest with (security_invoker = true) as
  select distinct on (company_id, weekday, slot, position) company_id, weekday, slot, position, employee_id, created_at
  from public.warmup_rotation order by company_id, weekday, slot, position, created_at desc;

create or replace function app.guard_warmup_leader() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op <> 'INSERT' then raise exception 'No se edita: asigna de nuevo'; end if;
  if new.position > app.slot_teachers(new.company_id, new.slot) then
    raise exception 'Ese calentamiento no tiene ese lugar (revisa los calentamientos de la sucursal)';
  end if;
  if tg_table_name = 'warmup_leaders' then
    if new.mode = 'asignado' and new.employee_id is null then raise exception 'Falta elegir a la persona'; end if;
    if new.mode <> 'asignado' then new.employee_id := null; end if;
  end if;
  if new.employee_id is not null and not exists (select 1 from public.employees e where e.id = new.employee_id and e.company_id = new.company_id) then
    raise exception 'La persona no pertenece a esta sucursal';
  end if;
  if not app.is_backoffice() then new.created_by := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists trg_guard_wr on public.warmup_rotation;
create trigger trg_guard_wr before insert or update or delete on public.warmup_rotation for each row execute function app.guard_warmup_leader();
drop trigger if exists aud_wr on public.warmup_rotation;
create trigger aud_wr after insert on public.warmup_rotation for each row execute function app.audit();

alter table public.warmup_rotation enable row level security;
drop policy if exists wr_select on public.warmup_rotation;
create policy wr_select on public.warmup_rotation for select using (app.can_see_company(company_id));
drop policy if exists wr_insert on public.warmup_rotation;
create policy wr_insert on public.warmup_rotation for insert with check (app.has_perm('warmup', 'configure', company_id));
grant select, insert on public.warmup_rotation to authenticated;
grant select on public.warmup_leader_latest, public.warmup_rotation_latest to authenticated;
grant execute on all functions in schema app to authenticated;

create or replace function public.unaccent_safe(t text) returns text language sql immutable as $$
  select translate(lower(t), 'áéíóúüñ', 'aeiouun') $$;

-- Viñedos: 2 calentamientos × 2 maestros (solo mientras no tenga rotación capturada).
update public.companies c set warmup_slots = '[{"label":"4:00–5:30 pm","teachers":2},{"label":"5:30–7:00 pm","teachers":2}]'
 where c.trade_name ilike '%vi_edos%' and c.warmup_slots = '[{"label":"Calentamiento","teachers":1}]'::jsonb
   and not exists (select 1 from public.warmup_rotation r where r.company_id = c.id);
update public.companies set warmups_per_day = jsonb_array_length(warmup_slots);

-- Rotación inicial de Viñedos (la que dio la dirección). Se liga por nombre solo si hay una persona que coincide;
-- lo que no se encuentre queda vacío y se completa en la pantalla.
do $$
declare vin uuid := (select id from public.companies where trade_name ilike '%vi_edos%' limit 1);
        r record; emp uuid; n int;
begin
  if vin is null or exists (select 1 from public.warmup_rotation where company_id = vin) then return; end if;
  for r in select * from (values
    (1,1,1,'%giomari%'),(1,1,2,'%sarah%'),(2,1,1,'%yazmin%'),(2,1,2,'%ximena%'),(3,1,1,'%sayana%'),(3,1,2,'%valeria%trejo%'),(4,1,1,'%giomari%'),(4,1,2,'%mayte%'),
    (1,2,1,'%angela%'),(1,2,2,'%valentina%trejo%'),(2,2,1,'%gabriel%valles%'),(2,2,2,'%mayte%'),(3,2,1,'%muslera%'),(3,2,2,'%sergio%'),(4,2,1,'%angela%'),(4,2,2,'%valentina%trejo%')
  ) as t(wd, sl, pos, pat) loop
    select count(*), min(id::text)::uuid into n, emp from public.employees
     where company_id = vin and state = 'activo' and unaccent_safe(full_name) ilike r.pat;
    insert into public.warmup_rotation (company_id, weekday, slot, position, employee_id) values (vin, r.wd, r.sl, r.pos, case when n = 1 then emp end);
  end loop;
end $$;
