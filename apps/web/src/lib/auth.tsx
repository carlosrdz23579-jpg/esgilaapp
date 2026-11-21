import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type Role = 'director' | 'admin' | 'rrhh' | 'empleado';
export interface AppUser { id: string; email: string; full_name: string; role: Role; status: 'pending' | 'active' | 'suspended' }
export interface Company { id: string; trade_name: string; is_active: boolean }
export interface Grant { module: string; action: string; company_id: string | null }
/** Expedientes propios donde la persona es Head Coach activo (le dan acceso a su departamento). */
export interface HeadCoachOf { employee_id: string; company_id: string; department_id: string }

interface Ctx {
  loading: boolean; session: Session | null; user: AppUser | null;
  companies: Company[]; grants: Grant[]; headCoachOf: HeadCoachOf[];
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
  const [headCoachOf, setHeadCoachOf] = useState<HeadCoachOf[]>([]);
  const [companyId, setCompanyId] = useState<string | 'all'>('all');

  const load = useCallback(async (s: Session | null) => {
    if (!s) { setUser(null); setCompanies([]); setGrants([]); setHeadCoachOf([]); setLoading(false); return; }
    const { data: u } = await supabase.from('app_users').select('*').eq('id', s.user.id).maybeSingle();
    setUser((u as AppUser) ?? null);
    if (u && (u as AppUser).status === 'active') {
      const [c, g, h] = await Promise.all([
        supabase.from('companies').select('id,trade_name,is_active').order('trade_name'),
        supabase.from('permission_grants').select('module,action,company_id').eq('user_id', s.user.id).is('revoked_at', null),
        supabase.from('employees').select('id,company_id,department_id').eq('user_id', s.user.id).eq('is_head_coach', true).eq('state', 'activo'),
      ]);
      setCompanies((c.data as Company[]) ?? []); setGrants((g.data as Grant[]) ?? []);
      setHeadCoachOf(((h.data ?? []) as { id: string; company_id: string; department_id: string }[])
        .map(x => ({ employee_id: x.id, company_id: x.company_id, department_id: x.department_id })));
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
    <AuthCtx.Provider value={{ loading, session, user, companies, grants, headCoachOf, companyId, setCompanyId, can,
      reload: () => load(session), signOut: async () => { await supabase.auth.signOut(); } }}>
      {children}
    </AuthCtx.Provider>
  );
}
