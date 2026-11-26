import { useState } from 'react';
import { usePersisted } from '../lib/usePersisted';
import { useAuth } from '../lib/auth';
import Employees from './Employees';
import Companies from './Companies';
import Attendance from './Attendance';
import Payroll from './Payroll';
import Cash from './Cash';
import Warmup from './Warmup';
import Users from './Users';
import CoachCalendar from './CoachCalendar';
import Students from './Students';
import FollowUp from './FollowUp';
import Settings from './Settings';

interface Mod { key: string; label: string; icon: string; visible: (a: ReturnType<typeof useAuth>) => boolean }
const ALWAYS = () => true;
export const MODULES: Mod[] = [
  { key: 'inicio', label: 'Inicio', icon: '🏠', visible: ALWAYS },
  { key: 'empresas', label: 'Empresas', icon: '🏢', visible: a => a.can('companies') },
  { key: 'empleados', label: 'Empleados', icon: '👥', visible: a => a.can('employees') || a.headCoachOf.length > 0 },
  { key: 'alumnas', label: 'Alumnas', icon: '🤸', visible: a => ['view', 'edit', 'create', 'configure'].some(x => a.can('students', x)) },
  { key: 'seguimiento', label: 'Seguimiento', icon: '📈', visible: ALWAYS },   // cada quien ve al menos el suyo
  { key: 'asistencia', label: 'Asistencia (checador)', icon: '⏱️', visible: a => a.can('payroll_hours') },
  { key: 'nomina', label: 'Nómina', icon: '🧾', visible: ALWAYS },   // cada quien ve al menos su propia nómina
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
  const [active, setActive] = usePersisted<string>('modulo', 'inicio');
  // Módulos que se juntaron en Calendario.
  if (active === 'coaches' || active === 'calentamiento') setActive('calendario');
  const [open, setOpen] = useState(false);
  const mods = MODULES.filter(m => m.visible(auth));
  const current = mods.find(m => m.key === active) ?? mods[0];
  const showAll = auth.user?.role === 'director' || auth.grants.some(g => g.company_id === null) || auth.companies.length > 1;

  return (
    <div className="flex min-h-screen">
      <aside className={`fixed inset-y-0 left-0 z-20 w-64 transform bg-white shadow transition overflow-y-auto md:sticky md:top-0 md:h-screen md:shrink-0 md:translate-x-0 ${open ? '' : '-translate-x-full'}`}>
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
          {current?.key === 'empleados' ? <Employees /> : current?.key === 'empresas' ? <Companies /> : current?.key === 'asistencia' ? <Attendance /> : current?.key === 'nomina' ? <Payroll /> : current?.key === 'efectivo' ? <Cash /> : current?.key === 'calentamiento' ? <Warmup /> : current?.key === 'usuarios' ? <Users /> : current?.key === 'calendario' ? <CoachCalendar /> : current?.key === 'config' ? <Settings /> : current?.key === 'alumnas' ? <Students /> : current?.key === 'seguimiento' ? <FollowUp /> : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
              Módulo en construcción (aún sin funcionalidad). Empresas cargadas: {auth.companies.length}.
            </div>)}
        </main>
      </div>
    </div>
  );
}
