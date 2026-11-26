-- =====================================================================
-- 0041  El cupo de un grupo es POR DÍA: Baby Gym 1 de 16:00 a 17:00 admite 12 niñas
-- el lunes, 12 el martes, etc. Cuentan las alumnas con plan en ese grupo y ese día, y
-- también las que vienen de EVO (su última lista del mes), sin contar dos veces a nadie.
-- Repetible.
-- =====================================================================

-- Ocupación por día de la semana de un grupo en un mes (0 domingo … 6 sábado)
create or replace function app.group_load(p_class uuid, p_month date)
returns table (weekday smallint, taken int)
language sql stable security definer set search_path = public, app as $$
  with m as (select date_trunc('month', p_month)::date as m),
  plan_days as (
    select x.student_id, unnest(x.weekdays) as wd
    from public.subscription_members x join public.subscriptions s on s.id = x.subscription_id, m
    where x.class_id = p_class and app.sub_active(s, m.m)
  ),
  evo_month as (select max(e.month) as em from public.student_enrollments e, m where e.class_id = p_class and e.month <= m.m),
  evo_days as (
    select e.student_id, unnest(e.weekdays) as wd from public.student_enrollments e, evo_month
    where e.class_id = p_class and e.month = evo_month.em
  ),
  everyone as (select student_id, wd from plan_days union select student_id, wd from evo_days)
  select d::smallint, (select count(distinct student_id)::int from everyone where wd = d) from generate_series(0, 6) d;
$$;
create or replace function public.group_load(p_class uuid, p_month date)
returns table (weekday smallint, taken int)
language sql stable security definer set search_path = public, app as $$ select * from app.group_load(p_class, p_month) $$;
grant execute on function public.group_load(uuid, date) to authenticated;

-- Lo más ocupado de la semana (para mostrar un solo número)
create or replace function app.group_taken(p_class uuid, p_month date) returns int
language sql stable security definer set search_path = public, app as $$
  select coalesce(max(taken), 0) from app.group_load(p_class, p_month);
$$;

create or replace function app.guard_sub_member() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare s public.subscriptions; cap int; m date; d smallint; t int;
        names text[] := array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
begin
  select * into s from public.subscriptions where id = new.subscription_id;
  if new.class_id is not null then
    select capacity into cap from public.class_groups where id = new.class_id;
    m := greatest(s.start_month, date_trunc('month', app.today_mx())::date);
    if cap is not null then
      foreach d in array coalesce(new.weekdays, '{}') loop
        -- ocupación de ese día sin contar a esta misma alumna (si ya estaba, no suma)
        select count(distinct q.student_id) into t from (
          select x.student_id from public.subscription_members x join public.subscriptions y on y.id = x.subscription_id
           where x.class_id = new.class_id and d = any(x.weekdays) and app.sub_active(y, m) and x.id is distinct from new.id
          union
          select e.student_id from public.student_enrollments e
           where e.class_id = new.class_id and d = any(e.weekdays)
             and e.month = (select max(month) from public.student_enrollments where class_id = new.class_id and month <= m)
        ) q where q.student_id <> new.student_id;
        if t >= cap then
          raise exception 'El grupo ya está lleno el % (cupo %). Elige otro día u otro grupo, o sube el cupo en Cobranza → Grupos.', names[d + 1], cap;
        end if;
      end loop;
    end if;
  end if;
  if s.student_id is not null and new.student_id <> s.student_id then raise exception 'Un plan individual sólo lleva a su alumna'; end if;
  if s.family_id is not null then
    if not exists (select 1 from public.students where id = new.student_id and family_id = s.family_id) then
      raise exception 'La alumna no es de esa familia';
    end if;
    if (select count(distinct student_id) from public.subscription_members where subscription_id = s.id and student_id <> new.student_id)
       >= coalesce((select max_members from public.plans where id = s.plan_id), 10) then
      raise exception 'El plan familiar ya tiene el máximo de integrantes';
    end if;
  end if;
  return new;
end $$;
