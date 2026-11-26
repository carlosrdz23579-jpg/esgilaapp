-- =====================================================================
-- 0038  Doble disciplina. Repetible.
--   discipline_rules  por sucursal y disciplina:
--     · is_combo        la "disciplina" es una combinación (Doble disciplina); sus planes son por horas TOTALES
--     · max_total_hours máximo de horas de la combinación (12)
--     · min_hours / max_hours  rango de horas de ESTA disciplina dentro de una combinación (máx. 8)
--   subscription_members + discipline, hours: en una doble disciplina, una fila por disciplina
--   (cada una con su grupo y sus días). El precio sale del plan de la combinación con esas horas totales.
-- =====================================================================
create table if not exists public.discipline_rules (
  company_id      uuid not null references public.companies(id),
  discipline      text not null,
  is_combo        boolean not null default false,
  min_hours       numeric(4,1) not null default 1 check (min_hours >= 0),
  max_hours       numeric(4,1) not null default 8 check (max_hours > 0),
  max_total_hours numeric(4,1) not null default 12 check (max_total_hours > 0),
  min_total_hours numeric(4,1),
  updated_at      timestamptz not null default now(),
  primary key (company_id, discipline),
  check (max_hours >= min_hours)
);
alter table public.subscription_members add column if not exists discipline text;
alter table public.subscription_members add column if not exists hours numeric(4,1) check (hours is null or hours > 0);

create or replace function app.guard_combo_member() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare pl public.plans; combo public.discipline_rules; r public.discipline_rules; total numeric;
begin
  select p.* into pl from public.plans p join public.subscriptions s on s.plan_id = p.id where s.id = new.subscription_id;
  select * into combo from public.discipline_rules where company_id = pl.company_id and discipline = pl.discipline and is_combo;
  if combo.discipline is null then return new; end if;
  if new.discipline is null or new.hours is null then raise exception 'En doble disciplina cada fila lleva disciplina y horas'; end if;
  if new.discipline = pl.discipline then raise exception 'Elige las disciplinas que se combinan'; end if;
  if exists (select 1 from public.subscription_members where subscription_id = new.subscription_id and discipline = new.discipline and id <> new.id) then
    raise exception '% ya está en esta combinación', new.discipline;
  end if;
  select * into r from public.discipline_rules where company_id = pl.company_id and discipline = new.discipline;
  if new.hours < coalesce(r.min_hours, 1) or new.hours > coalesce(r.max_hours, 8) then
    raise exception '%: entre % y % horas en doble disciplina', new.discipline, coalesce(r.min_hours, 1), coalesce(r.max_hours, 8);
  end if;
  select coalesce(sum(hours), 0) + new.hours into total from public.subscription_members where subscription_id = new.subscription_id and id <> new.id;
  if total > combo.max_total_hours then raise exception 'El total es % h; el máximo es % h', total, combo.max_total_hours; end if;
  if pl.hours_per_week is not null and total > pl.hours_per_week then raise exception 'El plan es de % h y ya van % h', pl.hours_per_week, total; end if;
  return new;
end $$;
drop trigger if exists trg_guard_combo on public.subscription_members;
create trigger trg_guard_combo before insert or update on public.subscription_members for each row execute function app.guard_combo_member();
drop trigger if exists aud_discipline_rules on public.discipline_rules;
create trigger aud_discipline_rules after insert or update on public.discipline_rules for each row execute function app.audit();

alter table public.discipline_rules enable row level security;
drop policy if exists dr_sel on public.discipline_rules; create policy dr_sel on public.discipline_rules for select using (app.can_billing(company_id));
drop policy if exists dr_ins on public.discipline_rules; create policy dr_ins on public.discipline_rules for insert with check (app.has_perm('billing','configure',company_id));
drop policy if exists dr_upd on public.discipline_rules; create policy dr_upd on public.discipline_rules for update using (app.has_perm('billing','configure',company_id)) with check (app.has_perm('billing','configure',company_id));
grant select, insert, update on public.discipline_rules to authenticated;
