insert into public.pay_schedules (company_id, scope, frequency, biweekly_day_1, biweekly_day_2, weekend_rule, effective_from, reason)
select c.id, 'empresa', 'quincenal', 15, 31, 'antes', date '2026-01-01', 'Configuración inicial (quincenal predeterminada)'
from public.companies c
where not exists (select 1 from public.pay_schedules s where s.company_id = c.id and s.scope = 'empresa');

select c.trade_name, s.frequency, s.biweekly_day_1, s.biweekly_day_2, s.weekend_rule
from public.pay_schedules s join public.companies c on c.id = s.company_id;
