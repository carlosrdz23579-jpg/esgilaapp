-- =====================================================================
-- 0047  Perfil de cada usuario: foto, nombre visible y preferencias de apariencia
--       (tema, tamaño de letra, color, menú personalizado) guardadas en su cuenta,
--       para que se vean igual en cualquier computadora o celular. Repetible.
-- =====================================================================
alter table public.app_users add column if not exists avatar_path text;
alter table public.app_users add column if not exists ui_prefs jsonb not null default '{}'::jsonb;

-- Cada quien cambia SÓLO su nombre, su foto y sus preferencias (no su rol ni su estado).
create or replace function public.set_my_profile(p_full_name text default null, p_avatar_path text default null, p_prefs jsonb default null)
returns void language plpgsql security definer set search_path = public, app as $$
begin
  if auth.uid() is null then raise exception 'Sin sesión'; end if;
  if p_avatar_path is not null and p_avatar_path <> '' and split_part(p_avatar_path, '/', 1) <> auth.uid()::text then raise exception 'Foto inválida'; end if;
  update public.app_users set
    full_name   = coalesce(nullif(trim(p_full_name), ''), full_name),
    avatar_path = case when p_avatar_path is null then avatar_path when p_avatar_path = '' then null else p_avatar_path end,
    ui_prefs    = case when p_prefs is null then ui_prefs else ui_prefs || p_prefs end
  where id = auth.uid();
end $$;
grant execute on function public.set_my_profile(text, text, jsonb) to authenticated;

-- Fotos de perfil: <usuario>/<archivo>. Las ven todos los usuarios (para chats, autores de notas…).
do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('avatars', 'avatars', false) on conflict (id) do nothing;
    execute 'drop policy if exists avatars_select on storage.objects';
    execute 'create policy avatars_select on storage.objects for select to authenticated using (bucket_id = ''avatars'')';
    execute 'drop policy if exists avatars_insert on storage.objects';
    execute 'create policy avatars_insert on storage.objects for insert to authenticated with check (bucket_id = ''avatars'' and split_part(name, ''/'', 1) = auth.uid()::text)';
  end if;
end $$;
