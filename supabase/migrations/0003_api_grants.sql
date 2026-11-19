-- 0003  Permisos de la API para el rol authenticated (aplicada a mano en Supabase)
grant usage on schema app to authenticated;
grant execute on all functions in schema app to authenticated;

grant usage on schema public to authenticated;
grant select, insert, update on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

alter default privileges in schema public grant select, insert, update on tables to authenticated;
alter default privileges in schema public grant usage, select on sequences to authenticated;
alter default privileges in schema app grant execute on functions to authenticated;

revoke delete on all tables in schema public from authenticated;
