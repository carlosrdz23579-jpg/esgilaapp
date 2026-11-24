-- =====================================================================
-- 0025  Varios calentamientos por día según la sucursal (Viñedos: 2, CAR: 1).
-- warmup_leaders.slot = número de calentamiento del día (1, 2…). El último registro por
-- (sucursal, día, calentamiento) es el que cuenta.
-- =====================================================================
alter table public.companies add column if not exists warmups_per_day smallint not null default 1 check (warmups_per_day between 1 and 4);
update public.companies set warmups_per_day = 2 where trade_name ilike '%vi_edos%' and warmups_per_day = 1;

alter table public.warmup_leaders add column if not exists slot smallint not null default 1 check (slot between 1 and 4);
drop index if exists wl_company_date;
create index if not exists wl_company_date_slot on public.warmup_leaders (company_id, date, slot, created_at desc);

drop view if exists public.warmup_leader_latest;
create view public.warmup_leader_latest with (security_invoker = true) as
  select distinct on (company_id, date, slot) company_id, date, slot, employee_id, created_by, created_at
  from public.warmup_leaders order by company_id, date, slot, created_at desc;
grant select on public.warmup_leader_latest to authenticated;

create or replace function app.guard_warmup_leader() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op <> 'INSERT' then raise exception 'No se edita: asigna de nuevo el día'; end if;
  if new.slot > (select warmups_per_day from public.companies where id = new.company_id) then
    raise exception 'Esta sucursal tiene % calentamiento(s) por día', (select warmups_per_day from public.companies where id = new.company_id);
  end if;
  if new.employee_id is not null and not exists (select 1 from public.employees e where e.id = new.employee_id and e.company_id = new.company_id) then
    raise exception 'La persona no pertenece a esta sucursal';
  end if;
  if not app.is_backoffice() then new.created_by := auth.uid(); end if;
  return new;
end $$;
