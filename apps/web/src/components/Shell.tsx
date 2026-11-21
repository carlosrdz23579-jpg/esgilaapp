import { useState } from 'react';
import { useAuth } from '../lib/auth';
import Employees from './Employees';

interface Mod { key: string; label: string; icon: string; visible: (a: ReturnType<typeof useAuth>) => boolean }
const ALWAYS = () => true;
export const MODULES: Mod[] = [
  { key: 'inicio', label: 'Inicio', icon: '🏠', visible: ALWAYS },
  { key: 'empresas', label: 'Empresas', icon: '🏢', visible: a => a.can('companies') },
  { key: 'empleados', label: 'Empleados', icon: '👥', visible: a => a.can('employees') },
  { key: 'nomina', label: 'Nómina', icon: '🧾', visible: a => a.user?.role === 'empleado' || a.can('payroll') },
  { key: 'reportes', label: 'Reportes', icon: '📊', visible: a => a.can('reports_financial') || a.can('reports_shared') },
  { key: 'efectivo', label: 'Calculadora de efectivo', icon: '💵', visible: a => a.can('cash') },
  { key: 'quejas', label: 'Quejas y sugerencias', icon: '📝', visible: ALWAYS },
  { key: 'anuncios', label: 'Anuncios', icon: '📣', visible: ALWAYS },
  { key: 'calendario', label: 'Calendario', icon: '📅', visible: ALWAYS },
  { key: 'chats', label: 'Chats y mensajes', icon: '💬', visible: ALWAYS },
  { key: 'config', label: 'Configuración', icon: '⚙️', visible: a => a.can('settings') },
  { key: 'usuarios', label: 'Usuarios y permisos', icon: '🔐', visible: a => a.can('users') },
];

export default function Shell() {
  const auth = useAuth();
  const [active, setActive] = useState('inicio');
  const [open, setOpen] = useState(false);
  const mods = MODULES.filter(m => m.visible(auth));
  const current = mods.find(m => m.key === active) ?? mods[0];
  const showAll = auth.user?.role === 'director' || auth.grants.some(g => g.company_id === null) || auth.companies.length > 1;

  return (
    <div className="flex min-h-screen">
      <aside className={`fixed inset-y-0 left-0 z-20 w-64 transform bg-white shadow transition md:static md:translate-x-0 ${open ? '' : '-translate-x-full'}`}>
        <div className="p-4 text-lg font-semibold text-brand">Administración</div>
        <nav className="space-y-1 px-2">
          {mods.map(m => (
            <button key={m.key} onClick={() => { setActive(m.key); setOpen(false); }}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${current?.key === m.key ? 'bg-brand text-white' : 'hover:bg-slate-100'}`}>
              <span>{m.icon}</span><span>{m.label}</span>
            </button>))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 bg-white px-4 py-3 shadow-sm">
          <button className="md:hidden" onClick={() => setOpen(!open)} aria-label="Menú">☰</button>
          <select value={auth.companyId} onChange={e => auth.setCompanyId(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm" aria-label="Empresa">
            {showAll && <option value="all">Todas las empresas</option>}
            {auth.companies.filter(c => c.is_active).map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}
          </select>
          <div className="ml-auto text-right text-xs">
            <div className="font-medium">{auth.user?.full_name || auth.user?.email}</div>
            <button className="text-brand" onClick={auth.signOut}>Cerrar sesión</button>
          </div>
        </header>
        <main className="flex-1 p-4">
          <h2 className="mb-4 text-xl font-semibold">{current?.label}</h2>
          {current?.key === 'empleados' ? <Employees /> : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
              Módulo en construcción (aún sin funcionalidad). Empresas cargadas: {auth.companies.length}.
            </div>)}
        </main>
      </div>
    </div>
  );
}
