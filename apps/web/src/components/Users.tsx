import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth, type Role } from '../lib/auth';
import { usePersisted } from '../lib/usePersisted';
import { Modal } from './ui';

const field = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const btn = 'rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60';

/** Módulos y las acciones que tienen sentido en cada uno. */
export const PERM_MODULES: { key: string; label: string; actions: string[]; economic?: boolean; group: string }[] = [
  { key: 'employees', label: 'Empleados (expedientes)', actions: ['view', 'create', 'edit'], group: 'Personal' },
  { key: 'companies', label: 'Empresas, departamentos y grupos', actions: ['view', 'create', 'edit', 'configure'], group: 'Personal' },
  { key: 'pay_schedules', label: 'Calendarios de pago', actions: ['view', 'configure'], group: 'Personal' },
  { key: 'salary', label: 'Salarios (pago de cada persona)', actions: ['view', 'edit'], economic: true, group: 'Dinero' },
  { key: 'payroll', label: 'Nómina', actions: ['view', 'edit', 'authorize'], economic: true, group: 'Dinero' },
  { key: 'payroll_hours', label: 'Horas, horarios y checador', actions: ['view', 'edit', 'configure'], economic: true, group: 'Dinero' },
  { key: 'cash', label: 'Calculadora de efectivo', actions: ['view', 'edit'], economic: true, group: 'Dinero' },
  { key: 'reports_financial', label: 'Reportes financieros', actions: ['view', 'export'], economic: true, group: 'Dinero' },
  { key: 'warmup', label: 'Calentamiento (Editar = marcar; Configurar = quién lo dirige)', actions: ['view', 'edit', 'configure'], group: 'Seguimiento' },
  { key: 'followup', label: 'Seguimiento de empleados (Ver; Editar = calificar indicadores y escribir notas)', actions: ['view', 'edit'], group: 'Seguimiento' },
  { key: 'indicators', label: 'Indicadores (Configurar = crear y editar el catálogo)', actions: ['view', 'configure'], group: 'Seguimiento' },
  { key: 'planning', label: 'Planeaciones (Ver = revisar; Configurar = subir la general)', actions: ['view', 'edit', 'configure'], group: 'Seguimiento' },
  { key: 'uniform', label: 'Asistencia y uniforme de maestros', actions: ['view', 'edit'], group: 'Seguimiento' },
  { key: 'students', label: 'Alumnas (Ver; Editar = pasar lista; Crear = notas internas; Configurar = importar de EVO y clases)', actions: ['view', 'edit', 'create', 'configure'], group: 'Alumnas' },
  { key: 'reports_shared', label: 'Reportes compartidos', actions: ['view', 'share'], group: 'Comunicación' },
  { key: 'announcements', label: 'Anuncios', actions: ['view', 'create', 'edit'], group: 'Comunicación' },
  { key: 'complaints', label: 'Quejas y sugerencias', actions: ['view', 'edit'], group: 'Comunicación' },
  { key: 'calendar', label: 'Calendario', actions: ['view', 'edit'], group: 'Comunicación' },
  { key: 'chat', label: 'Chats', actions: ['view', 'create'], group: 'Comunicación' },
  { key: 'users', label: 'Usuarios y permisos', actions: ['view', 'edit', 'configure'], group: 'Administración' },
  { key: 'settings', label: 'Configuración', actions: ['view', 'configure'], group: 'Administración' },
];
const ACTION_LABEL: Record<string, string> = { view: 'Ver', create: 'Crear', edit: 'Editar', authorize: 'Autorizar', configure: 'Configurar', export: 'Exportar', share: 'Compartir' };
const ROLE_LABEL: Record<Role, string> = { director: 'Director', admin: 'Administrador', rrhh: 'Recursos Humanos', empleado: 'Empleado' };
const STATUS_LABEL = { pending: 'Pendiente', active: 'Activo', suspended: 'Suspendido' } as const;

interface U { id: string; email: string; full_name: string; role: Role; status: keyof typeof STATUS_LABEL; created_at: string; paused_modules: string[] }
interface G { id: string; user_id: string; module: string; action: string; company_id: string | null; department_id: string | null;
  group_id: string | null; employee_id: string | null; source: string; revoked_at: string | null }
interface E { id: string; full_name: string; company_id: string; user_id: string | null }

export default function Users() {
  const { user, reload, can } = useAuth();
  const [users, setUsers] = useState<U[]>([]); const [emps, setEmps] = useState<E[]>([]);
  const [q, setQ] = useState(''); const [fStatus, setFStatus] = usePersisted<string>('usuarios:estado', '');
  const [openId, setOpenId] = usePersisted<string | null>('usuarios:abierto', null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [u, e] = await Promise.all([
      supabase.from('app_users').select('id,email,full_name,role,status,created_at,paused_modules').order('status').order('full_name'),
      supabase.from('employees').select('id,full_name,company_id,user_id').order('full_name').limit(2000)]);
    if (u.error || e.error) setMsg((u.error ?? e.error)!.message);
    setUsers((u.data as U[]) ?? []); setEmps((e.data as E[]) ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const visible = users.filter(u => (!fStatus || u.status === fStatus) && (!q || `${u.full_name} ${u.email}`.toLowerCase().includes(q.toLowerCase())));
  const pending = users.filter(u => u.status === 'pending').length;
  const open = users.find(u => u.id === openId) ?? null;
  const linked = (u: U) => emps.find(e => e.user_id === u.id);

  return (
    <div className="space-y-4">
      {user?.role === 'director' && <MyFunctions paused={user.paused_modules ?? []} onChanged={reload} />}
      <div className="flex flex-wrap items-end gap-2">
        <input className={`${field} max-w-xs`} placeholder="Buscar por nombre o correo…" value={q} onChange={e => setQ(e.target.value)} />
        <select className={field} value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option value="">Todos</option><option value="pending">Pendientes</option><option value="active">Activos</option><option value="suspended">Suspendidos</option></select>
        {pending > 0 && <span className="text-sm font-medium text-amber-700">{pending} solicitud(es) de acceso por revisar</span>}
      </div>
      <p className="text-xs text-slate-500">Para que alguien entre a la app: se registra con su correo, aparece aquí como <b>Pendiente</b>, y lo apruebas, le pones perfil y lo ligas a su expediente.</p>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-100 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Nombre</th><th className="px-3 py-2">Correo</th>
            <th className="px-3 py-2">Perfil</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">Expediente</th></tr></thead>
          <tbody>{visible.map(u => (
            <tr key={u.id} className="cursor-pointer border-t hover:bg-slate-50" onClick={() => setOpenId(u.id)}>
              <td className="px-3 py-2 font-medium text-brand">{u.full_name || '(sin nombre)'}{u.id === user?.id && <span className="ml-1 text-xs text-slate-400">(tú)</span>}</td>
              <td className="px-3 py-2 text-xs">{u.email}</td><td className="px-3 py-2">{ROLE_LABEL[u.role]}</td>
              <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs ${u.status === 'active' ? 'bg-green-100 text-green-700' : u.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-slate-200 text-slate-600'}`}>{STATUS_LABEL[u.status]}</span></td>
              <td className="px-3 py-2 text-xs">{linked(u)?.full_name ?? <span className="text-slate-400">sin ligar</span>}</td>
            </tr>))}</tbody>
        </table>
      </div>
      {open && <UserPanel u={open} emps={emps} isMe={open.id === user?.id} meRole={user?.role ?? 'empleado'} canConfigure={can('users', 'configure')}
        onClose={() => setOpenId(null)} onChanged={async () => { await load(); if (open.id === user?.id) await reload(); }} />}
    </div>
  );
}

/** Funciones del director: pausar y reactivar las suyas cuando quiera. */
function MyFunctions({ paused, onChanged }: { paused: string[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);
  async function toggle(m: string) {
    setBusy(m); setMsg(null);
    const { error } = await supabase.rpc('set_my_paused', { p_module: m, p_paused: !paused.includes(m) });
    setBusy(null); if (error) setMsg(error.message); else onChanged();
  }
  return (
    <details className="rounded-xl bg-white p-4 shadow-sm" open={paused.length > 0}>
      <summary className="cursor-pointer text-sm font-semibold">Mis funciones como director {paused.length > 0 && <span className="font-normal text-amber-700">· {paused.length} pausada(s)</span>}</summary>
      <p className="my-2 text-xs text-slate-500">Apaga las funciones que no te tocan por ahora. No pierdes el cargo: las vuelves a encender aquí cuando quieras, y queda registrado.</p>
      <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">{PERM_MODULES.filter(m => m.key !== 'users').map(m => (
        <label key={m.key} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!paused.includes(m.key)} disabled={busy === m.key} onChange={() => toggle(m.key)} />
          <span className={paused.includes(m.key) ? 'text-slate-400 line-through' : ''}>{m.label}</span></label>))}</div>
      {msg && <p className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
    </details>
  );
}

function UserPanel({ u, emps, isMe, meRole, canConfigure, onClose, onChanged }:
  { u: U; emps: E[]; isMe: boolean; meRole: Role; canConfigure: boolean; onClose: () => void; onChanged: () => void }) {
  const { companies, grants: myGrants } = useAuth();
  const [grants, setGrants] = useState<G[]>([]);
  const [scope, setScope] = useState<string>('');   // '' = todas las sucursales
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const isDirector = meRole === 'director';
  const current = emps.find(e => e.user_id === u.id);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('permission_grants').select('id,user_id,module,action,company_id,department_id,group_id,employee_id,source,revoked_at')
      .eq('user_id', u.id).is('revoked_at', null);
    if (error) setMsg(error.message); else setGrants((data as G[]) ?? []);
  }, [u.id]);
  useEffect(() => { load(); }, [load]);

  async function update(patch: Partial<U>, confirmText: string) {
    if (!window.confirm(confirmText)) return;
    setBusy(true); setMsg(null);
    const { data, error } = await supabase.from('app_users').update(patch).eq('id', u.id).select('id');
    setBusy(false);
    if (error) return setMsg(error.message); if (!data?.length) return setMsg('No se aplicó: sin permiso.');
    onChanged();
  }
  async function link(empId: string) {
    setBusy(true); setMsg(null);
    if (current) { const r = await supabase.from('employees').update({ user_id: null }).eq('id', current.id).select('id'); if (r.error) { setBusy(false); return setMsg(r.error.message); } }
    if (empId) { const r = await supabase.from('employees').update({ user_id: u.id }).eq('id', empId).select('id'); if (r.error) { setBusy(false); return setMsg(r.error.message); } if (!r.data?.length) { setBusy(false); return setMsg('No se aplicó: sin permiso.'); } }
    setBusy(false); onChanged();
  }

  // Permisos sin alcance fino (empresa o todas), editables con casillas.
  const simple = grants.filter(g => !g.department_id && !g.group_id && !g.employee_id && g.source === 'manual');
  const other = grants.filter(g => !simple.includes(g));
  const has = (m: string, a: string) => simple.find(g => g.module === m && g.action === a && (g.company_id ?? '') === scope);
  const covered = (m: string, a: string) => scope !== '' && simple.some(g => g.module === m && g.action === a && g.company_id === null);
  const iHave = (m: string, a: string) => isDirector || myGrants.some(g => g.module === m && g.action === a && (g.company_id === null || g.company_id === scope));

  async function toggle(m: string, a: string) {
    setMsg(null);
    const g = has(m, a);
    const r = g ? await supabase.from('permission_grants').update({ revoked_at: new Date().toISOString() }).eq('id', g.id).select('id')
      : await supabase.from('permission_grants').insert({ user_id: u.id, module: m, action: a, company_id: scope || null }).select('id');
    if (r.error) return setMsg(r.error.message); if (!r.data?.length) return setMsg('No se aplicó: sin permiso.');
    load();
  }
  async function revoke(g: G) {
    const r = await supabase.from('permission_grants').update({ revoked_at: new Date().toISOString() }).eq('id', g.id).select('id');
    if (r.error) setMsg(r.error.message); else load();
  }
  const groups = useMemo(() => [...new Set(PERM_MODULES.map(m => m.group))], []);
  const coName = (id: string | null) => (id ? companies.find(c => c.id === id)?.trade_name ?? '—' : 'todas');
  const fullAccess = u.role === 'director';

  return (
    <Modal wide onClose={onClose} title={<>{u.full_name || u.email} <span className="text-sm font-normal text-slate-500">· {u.email}</span></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <p className="mb-1 text-xs font-semibold text-slate-500">ESTADO</p>
          <p className="mb-2">{STATUS_LABEL[u.status]}</p>
          {!isMe && u.status !== 'active' && <button disabled={busy} className={btn} onClick={() => update({ status: 'active' }, `¿Dar acceso a ${u.email}?`)}>{u.status === 'pending' ? 'Aprobar acceso' : 'Reactivar'}</button>}
          {!isMe && u.status === 'active' && <button disabled={busy} className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700" onClick={() => update({ status: 'suspended' }, `¿Suspender el acceso de ${u.email}? No podrá entrar hasta que lo reactives.`)}>Suspender acceso</button>}
        </div>
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <p className="mb-1 text-xs font-semibold text-slate-500">PERFIL</p>
          {isDirector ? <select disabled={busy} className={field} value={u.role} onChange={e => update({ role: e.target.value as Role }, `¿Cambiar el perfil de ${u.email} a ${ROLE_LABEL[e.target.value as Role]}?`)}>
            {(Object.keys(ROLE_LABEL) as Role[]).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select> : <p>{ROLE_LABEL[u.role]}</p>}
          <p className="mt-1 text-xs text-slate-500">{u.role === 'director' ? 'Acceso total (puede pausar sus funciones).' : u.role === 'rrhh' ? 'Nunca puede recibir salarios, nómina, horas ni efectivo.' : 'Ve lo que le permitas abajo.'}</p>
          {!isDirector && <p className="text-xs text-slate-400">Solo un director cambia perfiles.</p>}
        </div>
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <p className="mb-1 text-xs font-semibold text-slate-500">EXPEDIENTE LIGADO</p>
          <select disabled={busy || isMe} className={`${field} w-full`} value={current?.id ?? ''} onChange={e => link(e.target.value)}>
            <option value="">— sin ligar —</option>
            {emps.filter(e => !e.user_id || e.user_id === u.id).map(e => <option key={e.id} value={e.id}>{e.full_name} · {coName(e.company_id)}</option>)}
          </select>
          <p className="mt-1 text-xs text-slate-500">Así ve su nómina, sus notas públicas y su horario.{isMe && ' (Tu propio expediente lo liga otro director.)'}</p>
        </div>
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}

      {fullAccess ? <p className="rounded-lg bg-indigo-50 p-3 text-sm text-indigo-900">Los directores tienen acceso total; cada uno pausa sus propias funciones en "Mis funciones como director".</p> : <>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">Permisos</p>
          <label className="ml-auto text-xs">Aplican en
            <select className={`${field} ml-1`} value={scope} onChange={e => setScope(e.target.value)}>
              <option value="">Todas las sucursales</option>{companies.map(c => <option key={c.id} value={c.id}>Solo {c.trade_name}</option>)}</select></label>
        </div>
        {!isDirector && <p className="text-xs text-slate-500">Solo puedes dar permisos que tú tienes; nadie se da permisos a sí mismo.</p>}
        <div className="grid gap-3 lg:grid-cols-2">{groups.map(gr => (
          <div key={gr} className="rounded-lg border p-3">
            <p className="mb-1 text-xs font-semibold uppercase text-slate-500">{gr}</p>
            <table className="w-full text-sm"><tbody>{PERM_MODULES.filter(m => m.group === gr).map(m => {
              const blocked = m.economic && u.role === 'rrhh';
              return (
                <tr key={m.key} className="border-t first:border-0">
                  <td className={`py-1 pr-2 ${blocked ? 'text-slate-400' : ''}`}>{m.label}</td>
                  <td className="py-1 text-right">{m.actions.map(a => {
                    const on = !!has(m.key, a), all = covered(m.key, a);
                    return <label key={a} className={`ml-2 inline-flex items-center gap-1 text-xs ${blocked || (!iHave(m.key, a) && !on) ? 'text-slate-300' : ''}`}
                      title={all ? 'Ya lo tiene en todas las sucursales' : blocked ? 'Recursos Humanos no recibe permisos económicos' : ''}>
                      <input type="checkbox" checked={on || all} disabled={isMe || blocked || all || !canConfigure || (!iHave(m.key, a) && !on)} onChange={() => toggle(m.key, a)} />{ACTION_LABEL[a]}</label>;
                  })}</td>
                </tr>);
            })}</tbody></table>
          </div>))}</div>
        {other.length > 0 && <div className="rounded-lg border p-3 text-xs">
          <p className="mb-1 font-semibold text-slate-500">Otros permisos (por departamento, grupo, empleado o por ser Head Coach)</p>
          {other.map(g => <p key={g.id}>{PERM_MODULES.find(m => m.key === g.module)?.label ?? g.module} · {ACTION_LABEL[g.action] ?? g.action} · {coName(g.company_id)}
            {g.source === 'head_coach' ? <span className="text-slate-400"> (por ser Head Coach: se cambia en su expediente)</span>
              : canConfigure && !isMe && <button className="ml-2 text-red-700" onClick={() => revoke(g)}>Quitar</button>}</p>)}
        </div>}
      </>}
    </Modal>
  );
}
