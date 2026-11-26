-- =====================================================================
-- 0032  Marcar a quién ya se le entregó su pago (efectivo o transferencia),
-- por nómina autorizada. Sólo se agrega: desmarcar es otra fila; la última gana
-- y queda quién lo marcó y cuándo. Repetible.
-- =====================================================================
create table if not exists public.pay_deliveries (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references public.payroll_runs(id),
  company_id   uuid not null references public.companies(id),
  employee_id  uuid not null references public.employees(id),
  method       text not null check (method in ('efectivo', 'transferencia')),
  delivered    boolean not null,
  author_name  text,
  created_by   uuid references public.app_users(id) default auth.uid(),
  created_at   timestamptz not null default clock_timestamp()
);
create index if not exists pd_run on public.pay_deliveries (run_id, employee_id, created_at desc);
create or replace view public.pay_deliveries_latest with (security_invoker = true) as
  select distinct on (run_id, employee_id) * from public.pay_deliveries order by run_id, employee_id, created_at desc;

create or replace function app.guard_pay_delivery() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op <> 'INSERT' then raise exception 'No se edita: vuelve a marcar o desmarcar'; end if;
  if not exists (select 1 from public.payroll_runs r where r.id = new.run_id and r.company_id = new.company_id and r.status = 'autorizada') then
    raise exception 'Sólo se marcan entregas de una nómina autorizada de esta sucursal';
  end if;
  if not app.is_backoffice() then new.created_by := auth.uid(); end if;
  new.author_name := (select coalesce(nullif(trim(full_name), ''), email) from public.app_users where id = new.created_by);
  return new;
end $$;
drop trigger if exists trg_guard_pd on public.pay_deliveries;
create trigger trg_guard_pd before insert or update or delete on public.pay_deliveries for each row execute function app.guard_pay_delivery();
drop trigger if exists aud_pd on public.pay_deliveries;
create trigger aud_pd after insert on public.pay_deliveries for each row execute function app.audit();

alter table public.pay_deliveries enable row level security;
drop policy if exists pd_select on public.pay_deliveries;
create policy pd_select on public.pay_deliveries for select using (app.has_perm('cash', 'view', company_id) or app.has_perm('cash', 'edit', company_id));
drop policy if exists pd_insert on public.pay_deliveries;
create policy pd_insert on public.pay_deliveries for insert with check (app.has_perm('cash', 'edit', company_id));
grant select, insert on public.pay_deliveries to authenticated;
grant select on public.pay_deliveries_latest to authenticated;
