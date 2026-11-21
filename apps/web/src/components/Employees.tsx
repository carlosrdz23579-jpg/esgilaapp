import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { formatMXN, pesosToCents } from '../lib/money';

type EState = 'activo' | 'suspendido' | 'baja';
interface Dept { id: string; company_id: string; name: string; is_active: boolean }
interface Group { id: string; company_id: string; department_id: string; name: string; is_active: boolean }
interface Emp {
  id: string; company_id: string; full_name: string; department_id: string; group_id: string | null;
  job_title: string | null; state: EState; hire_date: string | null; phone: string | null; email: string | null;
  curp: string | null; rfc: string | null; birth_date: string | null; address: string | null; contract_type: string | null;
  is_head_coach: boolean; work_days: number[];
}

const COLS = 'id,company_id,full_name,department_id,group_id,job_title,state,hire_date,phone,email,curp,rfc,birth_date,address,contract_type,is_head_coach,work_days';
const EMPTY = { full_name: '', company_id: '', department_id: '', group_id: '', job_title: '', hire_date: '', phone: '', email: '',
  curp: '', rfc: '', birth_date: '', address: '', contract_type: '' };
const field = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const badge: Record<EState, string> = { activo: 'bg-green-100 text-green-700', suspendido: 'bg-amber-100 text-amber-700', baja: 'bg-slate-200 text-slate-600' };

export default function Employees() {
  const { companies, companyId, can } = useAuth();
  const [rows, setRows] = useState<Emp[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [q, setQ] = useState(''); const [fDept, setFDept] = useState(''); const [fGroup, setFGroup] = useState('');
  const [fState, setFState] = useState<EState | ''>('activo');
  const [fHead, setFHead] = useState(false);
  const [editing, setEditing] = useState<Emp | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    let query = supabase.from('employees').select(COLS).order('full_name').limit(500);
    if (companyId !== 'all') query = query.eq('company_id', companyId);
    if (fDept) query = query.eq('department_id', fDept);
    if (fGroup) query = query.eq('group_id', fGroup);
    if (fState) query = query.eq('state', fState);
    if (fHead) query = query.eq('is_head_coach', true);
    if (q.trim()) query = query.ilike('full_name', `%${q.trim()}%`);
    const [e, d, g] = await Promise.all([
      query,
      supabase.from('departments').select('id,company_id,name,is_active').order('name'),
      supabase.from('groups').select('id,company_id,department_id,name,is_active').order('name'),
    ]);
    if (e.error) setError(e.error.message);
    setRows((e.data as Emp[]) ?? []); setDepts((d.data as Dept[]) ?? []); setGroups((g.data as Group[]) ?? []);
  }, [companyId, fDept, fGroup, fState, fHead, q]);

  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => { setFDept(''); setFGroup(''); }, [companyId]);

  const deptName = (id: string) => depts.find(d => d.id === id)?.name ?? '—';
  const groupName = (id: string | null) => groups.find(g => g.id === id)?.name ?? '—';
  const companyName = (id: string) => companies.find(c => c.id === id)?.trade_name ?? '—';
  const visDepts = depts.filter(d => d.is_active && (companyId === 'all' || d.company_id === companyId));
  const visGroups = groups.filter(g => g.is_active && (!fDept || g.department_id === fDept) && (companyId === 'all' || g.company_id === companyId));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <input className={`${field} max-w-xs`} placeholder="Buscar por nombre…" value={q} onChange={e => setQ(e.target.value)} />
        <select className={`${field} max-w-[11rem]`} value={fDept} onChange={e => { setFDept(e.target.value); setFGroup(''); }}>
          <option value="">Todos los departamentos</option>
          {visDepts.map(d => <option key={d.id} value={d.id}>{d.name}{companyId === 'all' ? ` · ${companyName(d.company_id)}` : ''}</option>)}
        </select>
        <select className={`${field} max-w-[10rem]`} value={fGroup} onChange={e => setFGroup(e.target.value)}>
          <option value="">Todos los grupos</option>
          {visGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select className={`${field} max-w-[9rem]`} value={fState} onChange={e => setFState(e.target.value as EState | '')}>
          <option value="">Todos los estados</option><option value="activo">Activos</option>
          <option value="suspendido">Suspendidos</option><option value="baja">Bajas</option>
        </select>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={fHead} onChange={e => setFHead(e.target.checked)} />Solo Head Coach</label>
        {can('employees', 'create') && (
          <button onClick={() => setEditing('new')} className="ml-auto rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white">+ Nuevo empleado</button>)}
      </div>
      {error && <p className="rounded bg-red-50 p-2 text-sm text-red-700">Error: {error}</p>}
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-100 text-xs uppercase text-slate-500">
            <tr><th className="px-3 py-2">Nombre</th><th className="px-3 py-2">Empresa</th><th className="px-3 py-2">Departamento</th>
              <th className="px-3 py-2">Grupo</th><th className="px-3 py-2">Puesto</th><th className="px-3 py-2">Estado</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} onClick={() => setEditing(r)} className="cursor-pointer border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-medium">{r.full_name}{r.is_head_coach && <span className="ml-2 rounded-full bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700">Head Coach</span>}</td><td className="px-3 py-2">{companyName(r.company_id)}</td>
                <td className="px-3 py-2">{deptName(r.department_id)}</td><td className="px-3 py-2">{groupName(r.group_id)}</td>
                <td className="px-3 py-2">{r.job_title ?? '—'}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs ${badge[r.state]}`}>{r.state}</span></td>
              </tr>))}
            {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Sin empleados con estos filtros.</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <EmployeeForm emp={editing === 'new' ? null : editing} depts={depts} groups={groups}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} onChanged={load} />}
    </div>
  );
}

function EmployeeForm({ emp, depts, groups, onClose, onSaved, onChanged }:
  { emp: Emp | null; depts: Dept[]; groups: Group[]; onClose: () => void; onSaved: () => void; onChanged: () => void }) {
  const { companies, companyId, can, user } = useAuth();
  // Quien no tiene permiso de editar expedientes y llega aquí es Head Coach: solo grupo, puesto, contacto y días.
  const full = !emp || can('employees', 'edit');
  const lock = !full;
  const initialCompany = emp?.company_id ?? (companyId !== 'all' ? companyId : companies[0]?.id ?? '');
  const [f, setF] = useState({ ...EMPTY, ...(emp ? Object.fromEntries(Object.entries(emp).map(([k, v]) => [k, v ?? ''])) : {}), company_id: initialCompany } as typeof EMPTY);
  const [state, setState] = useState<EState>(emp?.state ?? 'activo');
  const [head, setHead] = useState<boolean>(emp?.is_head_coach ?? false);
  const [workDays, setWorkDays] = useState<number[]>(emp?.work_days ?? [1, 2, 3, 4, 5, 6]);
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof EMPTY, v: string) => setF(p => ({ ...p, [k]: v }));
  const myDepts = useMemo(() => depts.filter(d => d.company_id === f.company_id && (d.is_active || d.id === f.department_id)), [depts, f.company_id, f.department_id]);
  const myGroups = useMemo(() => groups.filter(g => g.department_id === f.department_id && (g.is_active || g.id === f.group_id)), [groups, f.department_id, f.group_id]);

  const isCoachDept = depts.find(d => d.id === f.department_id)?.name.trim().toLowerCase() === 'coach';

  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    if (workDays.length === 0) return setMsg('Marca al menos un día laborable.');
    setBusy(true);
    const nz = (s: string) => (s.trim() === '' ? null : s.trim());
    const payload = { full_name: f.full_name.trim(), department_id: f.department_id, group_id: nz(f.group_id), job_title: nz(f.job_title),
      hire_date: nz(f.hire_date), phone: nz(f.phone), email: nz(f.email), curp: nz(f.curp?.toUpperCase?.() ?? ''), rfc: nz(f.rfc?.toUpperCase?.() ?? ''),
      birth_date: nz(f.birth_date), address: nz(f.address), contract_type: nz(f.contract_type), is_head_coach: isCoachDept ? head : false, work_days: [...workDays].sort((a, b) => a - b) };
    const limited = { group_id: payload.group_id, job_title: payload.job_title, phone: payload.phone, email: payload.email,
      address: payload.address, work_days: payload.work_days };
    const res = emp
      ? await supabase.from('employees').update(lock ? limited : payload).eq('id', emp.id).select('id')
      : await supabase.from('employees').insert({ ...payload, company_id: f.company_id }).select('id');
    setBusy(false);
    if (res.error) return setMsg(res.error.message);
    if (!res.data || res.data.length === 0) return setMsg('No se guardó: no tienes permiso para esta operación.');
    onSaved();
  }

  async function changeState(next: EState) {
    if (!emp) return;
    const label = { activo: 'reactivar', suspendido: 'suspender', baja: 'dar de baja' }[next];
    if (!window.confirm(`¿Seguro que quieres ${label} a ${emp.full_name}? Quedará registrado en su historial.`)) return;
    const { data, error } = await supabase.from('employees').update({ state: next }).eq('id', emp.id).select('id');
    if (error) return setMsg(error.message);
    if (!data || data.length === 0) return setMsg('No se aplicó: no tienes permiso para esta operación.');
    setState(next); onChanged();
  }

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="w-full max-w-2xl space-y-4 rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">{emp ? emp.full_name : 'Nuevo empleado'}</h3>
          <button onClick={onClose} aria-label="Cerrar" className="text-xl">×</button>
        </div>
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          {lock && <p className="sm:col-span-2 rounded bg-indigo-50 p-2 text-xs text-indigo-800">Como Head Coach puedes cambiar grupo, puesto, teléfono, correo, domicilio y días laborables.</p>}
          <label className="sm:col-span-2 text-xs">Nombre completo<input required disabled={lock} className={field} value={f.full_name} onChange={e => set('full_name', e.target.value)} /></label>
          <label className="text-xs">Empresa
            <select required disabled={!!emp} className={field} value={f.company_id} onChange={e => { set('company_id', e.target.value); set('department_id', ''); set('group_id', ''); }}>
              <option value="" disabled>Selecciona…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}
            </select></label>
          <label className="text-xs">Departamento
            <select required disabled={lock} className={field} value={f.department_id} onChange={e => { set('department_id', e.target.value); set('group_id', ''); }}>
              <option value="" disabled>Selecciona…</option>{myDepts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></label>
          <label className="text-xs">Grupo
            <select className={field} value={f.group_id} onChange={e => set('group_id', e.target.value)}>
              <option value="">Sin grupo</option>{myGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select></label>
          {isCoachDept && full && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={head} onChange={e => setHead(e.target.checked)} />Es Head Coach</label>}
          <fieldset className="sm:col-span-2 text-xs">
            <legend>Días que trabaja (si el día de pago no es uno de ellos, se le paga su día laborable anterior)</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'].map((d, i) => (
                <label key={i} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={workDays.includes(i)}
                  onChange={e => setWorkDays(w => e.target.checked ? [...w, i] : w.filter(x => x !== i))} />{d}</label>))}
            </div>
          </fieldset>
          <label className="text-xs">Puesto<input className={field} value={f.job_title} onChange={e => set('job_title', e.target.value)} /></label>
          <label className="text-xs">Fecha de ingreso<input type="date" disabled={lock} className={field} value={f.hire_date} onChange={e => set('hire_date', e.target.value)} /></label>
          <label className="text-xs">Tipo de contratación<input disabled={lock} className={field} value={f.contract_type} onChange={e => set('contract_type', e.target.value)} /></label>
          <label className="text-xs">Teléfono<input className={field} value={f.phone} onChange={e => set('phone', e.target.value)} /></label>
          <label className="text-xs">Correo<input type="email" className={field} value={f.email} onChange={e => set('email', e.target.value)} /></label>
          <label className="text-xs">CURP<input maxLength={18} disabled={lock} className={field} value={f.curp} onChange={e => set('curp', e.target.value)} /></label>
          <label className="text-xs">RFC<input maxLength={13} disabled={lock} className={field} value={f.rfc} onChange={e => set('rfc', e.target.value)} /></label>
          <label className="text-xs">Fecha de nacimiento<input type="date" disabled={lock} className={field} value={f.birth_date} onChange={e => set('birth_date', e.target.value)} /></label>
          <label className="sm:col-span-2 text-xs">Domicilio<input className={field} value={f.address} onChange={e => set('address', e.target.value)} /></label>
          {msg && <p className="sm:col-span-2 rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
          <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
            <button disabled={busy} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{emp ? 'Guardar cambios' : 'Crear empleado'}</button>
            {emp && <span className={`rounded-full px-2 py-0.5 text-xs ${badge[state]}`}>{state}</span>}
            {emp && full && state === 'activo' && <button type="button" onClick={() => changeState('suspendido')} className="text-sm text-amber-700">Suspender</button>}
            {emp && full && state === 'activo' && <button type="button" onClick={() => changeState('baja')} className="text-sm text-red-700">Dar de baja</button>}
            {emp && full && state !== 'activo' && <button type="button" onClick={() => changeState('activo')} className="text-sm text-green-700">Reactivar</button>}
          </div>
        </form>
        {emp && emp.is_head_coach && user && ['director', 'admin', 'rrhh'].includes(user.role) && <HeadCoachPanel emp={emp} />}
        {emp && can('salary') && <SalaryPanel emp={emp} />}
      </div>
    </div>
  );
}

type Kind = 'por_hora' | 'por_dia' | 'fijo';
interface ConceptRow { id: string; concept_key: string; label: string; kind: Kind; amount_cents: number; weekdays: number[];
  active: boolean; effective_from: string; reason: string; created_at: string }
const KIND_LABEL: Record<Kind, string> = { por_hora: 'por hora', por_dia: 'por día', fijo: 'fijo por periodo' };
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const slug = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'concepto';

/** Conceptos de pago: por hora, por día y/o fijo; varios a la vez. Solo-agregar: cada cambio es una fila nueva. */
function SalaryPanel({ emp }: { emp: Emp }) {
  const { can } = useAuth();
  const [rows, setRows] = useState<ConceptRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [edit, setEdit] = useState<ConceptRow | 'new' | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('compensation_concepts')
      .select('id,concept_key,label,kind,amount_cents,weekdays,active,effective_from,reason,created_at')
      .eq('employee_id', emp.id).order('effective_from', { ascending: false }).order('created_at', { ascending: false });
    if (error) setMsg(error.message); else setRows((data as ConceptRow[]) ?? []);
  }, [emp.id]);
  useEffect(() => { load(); }, [load]);

  const today = new Date().toLocaleDateString('en-CA');
  const current = Object.values(rows.filter(r => r.effective_from <= today)
    .reduce<Record<string, ConceptRow>>((m, r) => (m[r.concept_key] ? m : { ...m, [r.concept_key]: r }), {})).filter(r => r.active);
  const scheduled = rows.filter(r => r.effective_from > today);

  async function end(r: ConceptRow) {
    const from = window.prompt(`Terminar "${r.label}". ¿Desde qué fecha deja de pagarse? (AAAA-MM-DD)`, today);
    if (!from) return;
    const reason = window.prompt('Motivo:'); if (!reason?.trim()) return setMsg('El motivo es obligatorio.');
    const { error } = await supabase.from('compensation_concepts').insert({ company_id: emp.company_id, employee_id: emp.id,
      concept_key: r.concept_key, label: r.label, kind: r.kind, amount_cents: r.amount_cents, weekdays: r.weekdays,
      active: false, effective_from: from, reason: reason.trim() });
    if (error) setMsg(error.message.includes('duplicate') ? 'Ya hay un cambio de este concepto con esa fecha.' : error.message); else load();
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex items-center"><h4 className="text-sm font-semibold">Pago (confidencial)</h4>
        {can('salary', 'edit') && <button className="ml-auto text-sm text-brand" onClick={() => setEdit('new')}>+ Agregar concepto</button>}</div>
      {current.length === 0 && <p className="text-sm text-slate-500">Sin conceptos de pago vigentes.</p>}
      {current.map(r => (
        <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <b>{r.label}</b><span>{formatMXN(r.amount_cents)} {KIND_LABEL[r.kind]}</span>
          {r.kind !== 'fijo' && <span className="text-xs text-slate-500">{r.weekdays.length === 7 ? 'todos los días' : r.weekdays.map(d => DAYS[d]).join(', ')}</span>}
          <span className="text-xs text-slate-400">desde {r.effective_from}</span>
          {can('salary', 'edit') && <span className="ml-auto space-x-3 text-xs">
            <button className="text-brand" onClick={() => setEdit(r)}>Cambiar</button>
            <button className="text-red-700" onClick={() => end(r)}>Terminar</button></span>}
        </div>))}
      {scheduled.length > 0 && <p className="text-xs text-slate-500">Programados: {scheduled.map(r => `${r.label} ${r.active ? formatMXN(r.amount_cents) : '(termina)'} desde ${r.effective_from}`).join(' · ')}</p>}
      {edit && <ConceptForm emp={emp} base={edit === 'new' ? null : edit} onDone={() => { setEdit(null); load(); }} onCancel={() => setEdit(null)} />}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {rows.length > 0 && <details className="text-xs"><summary className="cursor-pointer text-slate-500">Historial completo</summary>
        <table className="mt-1 w-full text-left"><thead className="text-slate-500"><tr><th>Vigente desde</th><th>Concepto</th><th>Importe</th><th>Motivo</th><th>Registrado</th></tr></thead>
          <tbody>{rows.map(r => <tr key={r.id} className="border-t"><td className="py-1">{r.effective_from}</td><td>{r.label}{!r.active && ' (terminado)'}</td>
            <td>{formatMXN(r.amount_cents)} {KIND_LABEL[r.kind]}</td><td>{r.reason}</td><td>{r.created_at.slice(0, 16).replace('T', ' ')}</td></tr>)}</tbody></table></details>}
    </div>
  );
}

function ConceptForm({ emp, base, onDone, onCancel }: { emp: Emp; base: ConceptRow | null; onDone: () => void; onCancel: () => void }) {
  const [label, setLabel] = useState(base?.label ?? ''); const [kind, setKind] = useState<Kind>(base?.kind ?? 'por_hora');
  const [amount, setAmount] = useState(base ? String(base.amount_cents / 100) : '');
  const [days, setDays] = useState<number[]>(base?.weekdays ?? [0, 1, 2, 3, 4, 5, 6]);
  const [from, setFrom] = useState(new Date().toLocaleDateString('en-CA')); const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const cents = pesosToCents(amount);
    if (cents === null) return setMsg('Importe inválido. Usa números, por ejemplo 120 o 120.50');
    if (kind !== 'fijo' && days.length === 0) return setMsg('Marca al menos un día.');
    if (!window.confirm(`¿Registrar "${label}" de ${formatMXN(cents)} ${KIND_LABEL[kind]} desde el ${from}? No se puede borrar después; para corregir se registra otro cambio.`)) return;
    const { error } = await supabase.from('compensation_concepts').insert({ company_id: emp.company_id, employee_id: emp.id,
      concept_key: base?.concept_key ?? slug(label), label: label.trim(), kind, amount_cents: cents,
      weekdays: kind === 'fijo' ? [0, 1, 2, 3, 4, 5, 6] : [...days].sort((a, b) => a - b), effective_from: from, reason: reason.trim() });
    if (error) return setMsg(error.message.includes('duplicate') ? 'Ya existe un concepto con ese nombre y fecha. Usa otro nombre o fecha.' : error.message);
    onDone();
  }
  return (
    <form onSubmit={save} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
      <label className="text-xs">Concepto<input required disabled={!!base} className={field} placeholder="Ej. Portero, Limpieza, Clases" value={label} onChange={e => setLabel(e.target.value)} /></label>
      <label className="text-xs">Tipo<select className={field} value={kind} onChange={e => setKind(e.target.value as Kind)}>
        <option value="por_hora">Por hora trabajada</option><option value="por_dia">Por día asistido</option><option value="fijo">Fijo por periodo (semana o quincena)</option></select></label>
      <label className="text-xs">Importe ($){kind === 'por_hora' ? ' por hora' : kind === 'por_dia' ? ' por día' : ' por periodo'}
        <input required inputMode="decimal" className={field} value={amount} onChange={e => setAmount(e.target.value)} /></label>
      <label className="text-xs">Vigente desde<input type="date" required className={field} value={from} onChange={e => setFrom(e.target.value)} /></label>
      {kind !== 'fijo' && <fieldset className="text-xs sm:col-span-2"><legend>Días en que aplica</legend><div className="mt-1 flex flex-wrap gap-3">
        {DAYS.map((d, i) => <label key={i} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={days.includes(i)}
          onChange={e => setDays(w => e.target.checked ? [...w, i] : w.filter(x => x !== i))} />{d}</label>)}</div></fieldset>}
      <label className="text-xs sm:col-span-2">Motivo<input required className={field} value={reason} onChange={e => setReason(e.target.value)} /></label>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700 sm:col-span-2">{msg}</p>}
      <div className="flex gap-2 sm:col-span-2"><button className="rounded-lg border border-brand px-3 py-2 text-sm text-brand">Guardar</button>
        <button type="button" className="text-sm" onClick={onCancel}>Cancelar</button></div>
    </form>
  );
}

interface Resp { key: string; label: string; economic: boolean; active: boolean }

function HeadCoachPanel({ emp }: { emp: Emp }) {
  const { user } = useAuth();
  const [items, setItems] = useState<Resp[]>([]);
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('head_coach_responsibilities', { p_employee: emp.id });
    if (error) setMsg(error.message); else setItems((data as Resp[]) ?? []);
  }, [emp.id]);
  useEffect(() => { load(); }, [load]);

  async function toggle(r: Resp) {
    setBusy(r.key); setMsg(null);
    const { error } = await supabase.rpc('set_head_coach_responsibility', { p_employee: emp.id, p_key: r.key, p_on: !r.active });
    setBusy(null);
    if (error) setMsg(error.message); else load();
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <h4 className="text-sm font-semibold">Responsabilidades de Head Coach</h4>
      <p className="text-xs text-slate-500">Siempre puede mover coaches de grupo y editar su información, solo en el departamento Coach de esta sucursal y sin ver salarios. Aquí se agregan tareas extra; cada cambio queda registrado. Necesita tener su cuenta vinculada.</p>
      <div className="grid gap-1 sm:grid-cols-2">
        {items.map(r => {
          const blocked = r.economic && user?.role === 'rrhh';
          return (
            <label key={r.key} className={`flex items-center gap-2 text-sm ${blocked ? 'text-slate-400' : ''}`}>
              <input type="checkbox" checked={r.active} disabled={blocked || busy === r.key} onChange={() => toggle(r)} />
              {r.label}{r.economic && <span className="text-xs text-slate-400">(solo director o administrador)</span>}
            </label>);
        })}
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
    </div>
  );
}
