declare const __BUILD__: string;
import { useState } from 'react';
import { usePersisted } from '../lib/usePersisted';
import { useAuth } from '../lib/auth';
import { usePrefs } from '../lib/prefs';
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
import Billing from './Billing';
import Caja from './Caja';
import Feedback from './Feedback';
import Settings from './Settings';
import ProfilePanel, { Avatar } from './ProfilePanel';
import { Icon, type IconName } from './icons';
import { Dropdown } from './ui';

interface Mod { key: string; label: string; icon: IconName; group: string; admin?: boolean; visible: (a: ReturnType<typeof useAuth>) => boolean }
const ALWAYS = () => true;
export const MODULES: Mod[] = [
  { key: 'inicio', label: 'Inicio', icon: 'home', group: 'General', visible: ALWAYS },
  { key: 'calendario', label: 'Calendario', icon: 'calendar', group: 'General', visible: ALWAYS },
  { key: 'anuncios', label: 'Anuncios', icon: 'megaphone', group: 'General', visible: ALWAYS },
  { key: 'chats', label: 'Chats y mensajes', icon: 'chat', group: 'General', visible: ALWAYS },
  { key: 'alumnas', label: 'Alumnas', icon: 'gymnast', group: 'Alumnas', visible: a => ['view', 'edit', 'create', 'configure'].some(x => a.can('students', x)) || ['view', 'edit', 'configure'].some(x => a.can('billing', x)) },
  { key: 'caja', label: 'Caja', icon: 'register', group: 'Alumnas', visible: a => ['view', 'edit', 'configure'].some(x => a.can('cashbox', x)) },
  { key: 'cobranza', label: 'Cobranza', icon: 'card', group: 'Alumnas', visible: a => ['view', 'edit', 'configure'].some(x => a.can('billing', x)) },
  { key: 'quejas', label: 'Quejas y sugerencias', icon: 'inbox', group: 'Alumnas', visible: ALWAYS },
  { key: 'empleados', label: 'Empleados', icon: 'users', group: 'Personal', visible: a => a.can('employees') || a.headCoachOf.length > 0 },
  { key: 'seguimiento', label: 'Seguimiento', icon: 'chart', group: 'Personal', visible: ALWAYS },   // cada quien ve al menos el suyo
  { key: 'asistencia', label: 'Asistencia (checador)', icon: 'clock', group: 'Personal', visible: a => a.can('payroll_hours') },
  { key: 'nomina', label: 'Nómina', icon: 'receipt', group: 'Personal', visible: ALWAYS },   // cada quien ve al menos su propia nómina
  { key: 'efectivo', label: 'Calculadora de efectivo', icon: 'cash', group: 'Personal', visible: a => a.can('cash') },
  { key: 'reportes', label: 'Reportes', icon: 'bars', group: 'Reportes', visible: a => a.can('reports_financial') || a.can('reports_shared') },
  // Configuración: van escondidas en el engrane de arriba
  { key: 'empresas', label: 'Empresas y sucursales', icon: 'building', group: 'Configuración', admin: true, visible: a => a.can('companies') },
  { key: 'config', label: 'Configuración general', icon: 'gear', group: 'Configuración', admin: true, visible: a => a.can('settings') },
  { key: 'usuarios', label: 'Usuarios y permisos', icon: 'lock', group: 'Configuración', admin: true, visible: a => a.can('users') },
];
const GROUPS = ['General', 'Alumnas', 'Personal', 'Reportes'];

export default function Shell() {
  const auth = useAuth(); const { prefs, set } = usePrefs();
  const [active, setActive] = usePersisted<string>('modulo', 'inicio');
  if (active === 'coaches' || active === 'calentamiento') setActive('calendario');
  const [open, setOpen] = useState(false); const [gear, setGear] = useState(false); const [profile, setProfile] = useState(false);
  const all = MODULES.filter(m => m.visible(auth));
  const nav = all.filter(m => !m.admin && !prefs.menuHidden.includes(m.key));
  const adminMods = all.filter(m => m.admin);
  const current = all.find(m => m.key === active) ?? nav[0] ?? all[0];
  const showAll = auth.user?.role === 'director' || auth.grants.some(g => g.company_id === null) || auth.companies.length > 1;
  const compact = prefs.compactMenu;
  const go = (k: string) => { setActive(k); setOpen(false); setGear(false); };
  const ordered = prefs.menuMode === 'personal' && prefs.menuOrder.length
    ? [...nav].sort((a, b) => (prefs.menuOrder.indexOf(a.key) + 1 || 99) - (prefs.menuOrder.indexOf(b.key) + 1 || 99)) : nav;

  const item = (m: Mod) => (
    <button key={m.key} onClick={() => go(m.key)} title={compact ? m.label : undefined}
      className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[0.92rem] transition
        ${current?.key === m.key ? 'bg-white/15 font-semibold text-white shadow-inner' : 'text-white/70 hover:bg-white/10 hover:text-white'} ${compact ? 'justify-center px-2' : ''}`}>
      <Icon name={m.icon} className={`h-5 w-5 shrink-0 ${current?.key === m.key ? 'text-white' : 'text-white/60 group-hover:text-white'}`} />
      {!compact && <span className="truncate">{m.label}</span>}
    </button>);

  return (
    <div className="flex min-h-screen">
      {open && <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-30 flex ${compact ? 'w-[4.5rem]' : 'w-64'} transform flex-col bg-gradient-to-b from-[#1e1b2e] via-[#241f3a] to-[#1a1726] transition md:sticky md:top-0 md:h-screen md:shrink-0 md:translate-x-0 ${open ? '' : '-translate-x-full'}`}>
        <div className={`flex items-center gap-2 px-4 pb-3 pt-5 ${compact ? 'justify-center px-2' : ''}`}>
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand text-lg font-bold text-white shadow-lg shadow-brand/30">E</div>
          {!compact && <div className="min-w-0"><div className="font-semibold leading-tight text-white">ESGILA</div><div className="text-[11px] text-white/50">Administración</div></div>}
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto px-3 pb-4 pt-2">
          {prefs.menuMode === 'personal'
            ? <div className="space-y-0.5">{ordered.map(item)}</div>
            : GROUPS.map(g => { const ms = nav.filter(m => m.group === g); if (!ms.length) return null; return (
              <div key={g} className="space-y-0.5">
                {!compact && <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/35">{g}</p>}
                {ms.map(item)}
              </div>); })}
        </nav>
        <div className={`border-t border-white/10 p-3 text-[10px] text-white/30 ${compact ? 'text-center' : ''}`}>
          <button className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-white/50 hover:bg-white/10 hover:text-white" onClick={() => set({ compactMenu: !compact })}>
            <Icon name={compact ? 'expand' : 'collapse'} className="h-4 w-4" />{!compact && 'Hacer menú angosto'}</button>
          {!compact && <>versión {__BUILD__}</>}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-black/5 bg-[rgb(var(--bg)/0.85)] px-4 py-2.5 backdrop-blur dark:border-white/5 md:px-6">
          <button className="rounded-lg p-2 hover:bg-slate-100 md:hidden" onClick={() => setOpen(!open)} aria-label="Menú"><Icon name="menu" className="h-5 w-5" /></button>
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-1 shadow-sm">
            <Icon name="building" className="h-4 w-4 text-slate-400" />
            <select value={auth.companyId} onChange={e => auth.setCompanyId(e.target.value)} className="border-0 bg-transparent py-0.5 pr-6 text-sm font-medium focus:ring-0" aria-label="Sucursal">
              {showAll && <option value="all">Todas las sucursales</option>}
              {auth.companies.filter(c => c.is_active).map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}
            </select>
          </div>
          <div className="ml-auto flex items-center gap-1">
            {adminMods.length > 0 && <Dropdown open={gear} onClose={() => setGear(false)} button={
              <button onClick={() => setGear(!gear)} className={`grid h-10 w-10 place-items-center rounded-xl transition hover:bg-slate-100 ${adminMods.some(m => m.key === current?.key) ? 'bg-brand/10 text-brand' : 'text-slate-500'}`} title="Configuración">
                <Icon name="gear" className="h-5 w-5" /></button>}>
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Configuración</p>
              {adminMods.map(m => <button key={m.key} onClick={() => go(m.key)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100 ${current?.key === m.key ? 'font-semibold text-brand' : ''}`}>
                <Icon name={m.icon} className="h-4 w-4 text-slate-400" />{m.label}</button>)}
            </Dropdown>}
            <button onClick={() => setProfile(true)} className="flex items-center gap-2 rounded-xl px-2 py-1 transition hover:bg-slate-100" title="Mi perfil y apariencia">
              <Avatar path={auth.user?.avatar_path} name={auth.user?.full_name || auth.user?.email || ''} size={34} />
              <span className="hidden text-left text-sm leading-tight sm:block"><span className="block max-w-[11rem] truncate font-medium">{auth.user?.full_name || auth.user?.email}</span>
                <span className="block text-[11px] capitalize text-slate-500">{auth.user?.role}</span></span>
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1500px] flex-1 p-4 md:p-6">
          <div className="mb-5 flex items-center gap-3">
            {current && <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand"><Icon name={current.icon} className="h-5 w-5" /></span>}
            <h2 className="text-2xl font-semibold tracking-tight">{current?.label}</h2>
          </div>
          {current?.key === 'empleados' ? <Employees /> : current?.key === 'empresas' ? <Companies /> : current?.key === 'asistencia' ? <Attendance /> : current?.key === 'nomina' ? <Payroll /> : current?.key === 'efectivo' ? <Cash /> : current?.key === 'calentamiento' ? <Warmup /> : current?.key === 'usuarios' ? <Users /> : current?.key === 'calendario' ? <CoachCalendar /> : current?.key === 'config' ? <Settings /> : current?.key === 'alumnas' ? <Students /> : current?.key === 'seguimiento' ? <FollowUp /> : current?.key === 'cobranza' ? <Billing /> : current?.key === 'caja' ? <Caja /> : current?.key === 'quejas' ? <Feedback /> : (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
              <Icon name={current?.icon ?? 'home'} className="mx-auto mb-2 h-8 w-8 text-slate-300" />Este módulo todavía está en construcción.
            </div>)}
        </main>
      </div>
      {profile && <ProfilePanel modules={all.filter(m => !m.admin).map(m => ({ key: m.key, label: m.label }))} onClose={() => setProfile(false)} />}
    </div>
  );
}

