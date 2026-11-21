import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type Role = 'director' | 'admin' | 'rrhh' | 'empleado';
export interface AppUser { id: string; email: string; full_name: string; role: Role; status: 'pending' | 'active' | 'suspended' }
export interface Company { id: string; trade_name: string; is_active: boolean }
export interface Grant { module: string; action: string; company_id: string | null }

interface Ctx {
  loading: boolean; session: Session | null; user: AppUser | null;
  companies: Company[]; grants: Grant[];
  companyId: string | 'all'; setCompanyId: (id: string | 'all') => void;
  /** Solo para mostrar/ocultar menús. La seguridad real la aplica la base de datos (RLS). */
  can: (module: string, action?: string) => boolean;
  reload: () => Promise<void>; signOut: () => Promise<void>;
}
const AuthCtx = createContext<Ctx>(null as unknown as Ctx);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AppUser | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [companyId, setCompanyId] = useState<string | 'all'>('all');

  const load = useCallback(async (s: Session | null) => {
    if (!s) { setUser(null); setCompanies([]); setGrants([]); setLoading(false); return; }
    const { data: u } = await supabase.from('app_users').select('*').eq('id', s.user.id).maybeSingle();
    setUser((u as AppUser) ?? null);
    if (u && (u as AppUser).status === 'active') {
      const [c, g] = await Promise.all([
        supabase.from('companies').select('id,trade_name,is_active').order('trade_name'),
        supabase.from('permission_grants').select('module,action,company_id').eq('user_id', s.user.id),
      ]);
      setCompanies((c.data as Company[]) ?? []); setGrants((g.data as Grant[]) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); load(data.session); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); load(s); });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const can = (module: string, action = 'view') =>
    user?.role === 'director' ||
    grants.some(g => g.module === module && g.action === action &&
      (companyId === 'all' || g.company_id === null || g.company_id === companyId));

  return (
    <AuthCtx.Provider value={{ loading, session, user, companies, grants, companyId, setCompanyId, can,
      reload: () => load(session), signOut: async () => { await supabase.auth.signOut(); } }}>
      {children}
    </AuthCtx.Provider>
  );
}
