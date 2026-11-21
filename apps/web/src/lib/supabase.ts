import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!url || !key) {
  throw new Error('Falta configurar VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY en apps/web/.env.local');
}

// Solo clave pública: la seguridad real la imponen las políticas RLS de la base de datos.
// NUNCA poner aquí la clave service_role/secret.
export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
});
