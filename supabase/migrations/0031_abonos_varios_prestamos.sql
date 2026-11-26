-- =====================================================================
-- 0031  Corrige autorizar una nómina con DOS o más préstamos.
-- El trigger que marca un préstamo como liquidado apagaba la bandera interna
-- app.loan_fn al terminar; si la autorización estaba registrando varios abonos,
-- el segundo se rechazaba ("Los abonos de nómina los registra la autorización…").
-- Ahora el trigger restaura el valor que había. Repetible.
-- =====================================================================
create or replace function app.loan_after_payment() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare l public.loans; prev text := coalesce(current_setting('app.loan_fn', true), '');
begin
  select * into l from public.loans where id = new.loan_id;
  perform set_config('app.loan_fn', 'on', true);
  if app.loan_paid(l.id) >= l.principal_cents + l.interest_cents and l.status = 'activo' then
    update public.loans set status = 'liquidado' where id = l.id;
  elsif app.loan_paid(l.id) < l.principal_cents + l.interest_cents and l.status = 'liquidado' then
    update public.loans set status = 'activo' where id = l.id;
  end if;
  perform set_config('app.loan_fn', prev, true);
  return new;
end $$;
