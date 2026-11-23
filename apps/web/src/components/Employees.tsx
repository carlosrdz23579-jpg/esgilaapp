import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { formatMXN, pesosToCents } from '../lib/money';
import WorkSchedulePanel from './WorkSchedule';
import { ImportEmployees, exportEmployees } from './EmployeesIO';

type EState = 'activo' | 'suspendido' | 'baja';
interface Dept { id: string; company_id: string; name: string; is_active: boolean }
interface Group { id: string; company_id: string; department_id: string; name: string; is_active: boolean }
interface Emp {
  id: string; company_id: string; full_name: string; department_id: string; group_id: string | null;
  job_title: string | null; state: EState; hire_date: string | null; phone: string | null; email: string | null;
  curp: string | null; rfc: string | null; birth_date: string | null; address: string | null; contract_type: string | null;
  is_head_coach: boolean; work_days: number[]; pay_method: string;
}

const COLS = 'id,company_id,full_name,department_id,group_id,job_title,state,hire_date,phone,email,curp,rfc,birth_date,address,contract_type,is_head_coach,work_days,pay_method';
const EMPTY = { full_name: '', company_id: '', department_id: '', group_id: '', job_title: '', hire_date: '', phone: '', email: '',
  curp: '', rfc: '', birth_date: '', address: '', contract_type: '', pay_method: 'efectivo' };
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
  const [importing, setImporting] = useState(false);

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
        {can('employees', 'create') && <button onClick={() => setImporting(true)} className="rounded-lg border px-3 py-2 text-sm">Importar Excel</button>}
        {can('employees', 'view') && <button className="rounded-lg border px-3 py-2 text-sm"
          onClick={() => exportEmployees(companyId, can('salary', 'view'), can('payroll_hours', 'view')).catch(e => setError((e as Error).message))}>Exportar Excel</button>}
        {importing && <ImportEmployees onClose={() => setImporting(false)} onDone={load} />}
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
      birth_date: nz(f.birth_date), address: nz(f.address), contract_type: nz(f.contract_type), pay_method: f.pay_method || 'efectivo', is_head_coach: isCoachDept ? head : false, work_days: [...workDays].sort((a, b) => a - b) };
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
          <label className="text-xs">Forma de pago<select disabled={lock} className={field} value={f.pay_method} onChange={e => set('pay_method', e.target.value)}>
            <option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select></label>
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
        {emp && can('payroll_hours') && <WorkSchedulePanel employeeId={emp.id} companyId={emp.company_id} />}
        {emp && can('salary') && <SalaryPanel emp={emp} />}
        {emp && can('payroll') && <LoansPanel emp={emp} />}
        {emp && can('payroll') && <AdjustmentsPanel emp={emp} table="extra_earnings" title="Ingresos extra" newLabel="+ Nuevo ingreso extra"
          placeholder="Ej. Bono por competencia" help="Bonos, premios o pagos adicionales, para cualquier tipo de sueldo (incluido el fijo). Solo se pagan los autorizados; quien lo captura no puede autorizarlo (salvo el director)." />}
        {emp && can('payroll') && <AdjustmentsPanel emp={emp} table="deductions" title="Descuentos" newLabel="+ Nuevo descuento"
          placeholder="Ej. Uniforme" help="Solo se aplican los autorizados. Quien captura un descuento no puede autorizarlo (salvo el director). No incluye préstamos ni la rebaja por retardo." />}
      </div>
    </div>
  );
}

type Kind = 'por_hora' | 'por_dia' | 'fijo' | 'tarifa_retardo';
interface ConceptRow { id: string; concept_key: string; label: string; kind: Kind; amount_cents: number; weekdays: number[];
  active: boolean; effective_from: string; reason: string; created_at: string }
const KIND_LABEL: Record<Kind, string> = { por_hora: 'por hora', por_dia: 'por día', fijo: 'fijo por periodo', tarifa_retardo: 'por hora, solo como base de la rebaja por retardo (no se paga)' };
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
          {<span className="text-xs text-slate-500">{r.weekdays.length === 7 ? 'todos los días' : r.weekdays.map(d => DAYS[d]).join(', ')}</span>}
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
    if (days.length === 0) return setMsg('Marca al menos un día.');
    if (!window.confirm(`¿Registrar "${label}" de ${formatMXN(cents)} ${KIND_LABEL[kind]} desde el ${from}? No se puede borrar después; para corregir se registra otro cambio.`)) return;
    const { error } = await supabase.from('compensation_concepts').insert({ company_id: emp.company_id, employee_id: emp.id,
      concept_key: base?.concept_key ?? slug(label), label: label.trim(), kind, amount_cents: cents,
      weekdays: [...days].sort((a, b) => a - b), effective_from: from, reason: reason.trim() });
    if (error) return setMsg(error.message.includes('duplicate') ? 'Ya existe un concepto con ese nombre y fecha. Usa otro nombre o fecha.' : error.message);
    onDone();
  }
  return (
    <form onSubmit={save} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
      <label className="text-xs">Concepto<input required disabled={!!base} className={field} placeholder="Ej. Portero, Limpieza, Clases" value={label} onChange={e => setLabel(e.target.value)} /></label>
      <label className="text-xs">Tipo<select className={field} value={kind} onChange={e => { const k = e.target.value as Kind; setKind(k); if (k === 'fijo' && !base) setDays([1, 2, 3, 4, 5, 6]); }}>
        <option value="por_hora">Por hora trabajada</option><option value="por_dia">Por día asistido</option><option value="fijo">Fijo por periodo (semana o quincena)</option><option value="tarifa_retardo">Tarifa base para rebaja por retardo (no se paga)</option></select></label>
      <label className="text-xs">Importe ($){kind === 'por_hora' || kind === 'tarifa_retardo' ? ' por hora' : kind === 'por_dia' ? ' por día' : ' por periodo'}
        <input required inputMode="decimal" className={field} value={amount} onChange={e => setAmount(e.target.value)} /></label>
      <label className="text-xs">Vigente desde<input type="date" required className={field} value={from} onChange={e => setFrom(e.target.value)} /></label>
      {kind !== 'tarifa_retardo' && <fieldset className="text-xs sm:col-span-2"><legend>{kind === 'fijo' ? 'Días que cubre (cada falta injustificada en estos días descuenta la parte proporcional)' : 'Días en que aplica'}</legend><div className="mt-1 flex flex-wrap gap-3">
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

type DStatus = 'pendiente' | 'autorizado' | 'rechazado' | 'cancelado';
interface DRow { id: string; label: string; amount_cents: number; kind: 'unico' | 'recurrente'; start_date: string; end_date: string | null;
  reason: string; status: DStatus; created_by: string; created_at: string; decision_note: string | null }
const DBADGE: Record<DStatus, string> = { pendiente: 'bg-amber-100 text-amber-700', autorizado: 'bg-green-100 text-green-700',
  rechazado: 'bg-slate-200 text-slate-600', cancelado: 'bg-slate-200 text-slate-600' };

/** Descuentos o ingresos extra: se capturan pendientes y otra persona con permiso de autorizar los aprueba (el director puede ambos). */
function AdjustmentsPanel({ emp, table, title, newLabel, placeholder, help }:
  { emp: Emp; table: 'deductions' | 'extra_earnings'; title: string; newLabel: string; placeholder: string; help: string }) {
  const { can, user } = useAuth();
  const [rows, setRows] = useState<DRow[]>([]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ label: '', amount: '', kind: 'unico' as 'unico' | 'recurrente', start: new Date().toLocaleDateString('en-CA'), end: '', reason: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from(table).select('id,label,amount_cents,kind,start_date,end_date,reason,status,created_by,created_at,decision_note')
      .eq('employee_id', emp.id).order('created_at', { ascending: false });
    if (error) setMsg(error.message); else setRows((data as DRow[]) ?? []);
  }, [emp.id, table]);
  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const cents = pesosToCents(f.amount);
    if (cents === null || cents === 0) return setMsg('Importe inválido.');
    const { error } = await supabase.from(table).insert({ company_id: emp.company_id, employee_id: emp.id, label: f.label.trim(),
      amount_cents: cents, kind: f.kind, start_date: f.start, end_date: f.kind === 'recurrente' && f.end ? f.end : null, reason: f.reason.trim() });
    if (error) return setMsg(error.message);
    setOpen(false); setF({ ...f, label: '', amount: '', reason: '' }); load();
  }
  async function decide(r: DRow, status: DStatus) {
    const verb = { autorizado: 'autorizar', rechazado: 'rechazar', cancelado: 'cancelar', pendiente: '' }[status];
    const note = window.prompt(`¿${verb[0].toUpperCase() + verb.slice(1)} "${r.label}" de ${formatMXN(r.amount_cents)}? Nota (opcional):`);
    if (note === null) return;
    const { data, error } = await supabase.from(table).update({ status, decision_note: note.trim() || null }).eq('id', r.id).select('id');
    if (error) return setMsg(error.message);
    if (!data?.length) return setMsg('No se aplicó: no tienes permiso para esta operación.');
    load();
  }
  const canAuth = can('payroll', 'authorize');

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex items-center"><h4 className="text-sm font-semibold">{title}</h4>
        {can('payroll', 'edit') && <button className="ml-auto text-sm text-brand" onClick={() => setOpen(!open)}>{newLabel}</button>}</div>
      <p className="text-xs text-slate-500">{help}</p>
      {open && (
        <form onSubmit={add} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
          <label className="text-xs">Concepto<input required className={field} placeholder={placeholder} value={f.label} onChange={e => setF({ ...f, label: e.target.value })} /></label>
          <label className="text-xs">Importe ($)<input required inputMode="decimal" className={field} value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></label>
          <label className="text-xs">Tipo<select className={field} value={f.kind} onChange={e => setF({ ...f, kind: e.target.value as 'unico' | 'recurrente' })}>
            <option value="unico">Una sola vez</option><option value="recurrente">Cada periodo de pago</option></select></label>
          <label className="text-xs">{f.kind === 'unico' ? 'Se aplica en el periodo que incluye' : 'Desde'}<input type="date" required className={field} value={f.start} onChange={e => setF({ ...f, start: e.target.value })} /></label>
          {f.kind === 'recurrente' && <label className="text-xs">Hasta (opcional)<input type="date" min={f.start} className={field} value={f.end} onChange={e => setF({ ...f, end: e.target.value })} /></label>}
          <label className="text-xs sm:col-span-2">Motivo<input required className={field} value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} /></label>
          <div className="sm:col-span-2"><button className="rounded-lg border border-brand px-3 py-2 text-sm text-brand">Capturar (queda pendiente)</button></div>
        </form>)}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {rows.map(r => (
        <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <b>{r.label}</b><span>{formatMXN(r.amount_cents)}</span>
          <span className="text-xs text-slate-500">{r.kind === 'unico' ? `una vez (${r.start_date})` : `cada periodo desde ${r.start_date}${r.end_date ? ` hasta ${r.end_date}` : ''}`}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs ${DBADGE[r.status]}`}>{r.status}</span>
          <span className="text-xs text-slate-400">{r.reason}{r.decision_note ? ` · ${r.decision_note}` : ''}</span>
          <span className="ml-auto space-x-3 text-xs">
            {r.status === 'pendiente' && canAuth && (r.created_by !== user?.id || user?.role === 'director') && <>
              <button className="text-green-700" onClick={() => decide(r, 'autorizado')}>Autorizar</button>
              <button className="text-red-700" onClick={() => decide(r, 'rechazado')}>Rechazar</button></>}
            {r.status === 'autorizado' && (can('payroll', 'edit') || canAuth) && <button className="text-red-700" onClick={() => decide(r, 'cancelado')}>Cancelar</button>}
          </span>
        </div>))}
    </div>
  );
}

interface LoanRow { id: string; lender: 'empresa' | 'director'; principal_cents: number; interest_cents: number; installment_cents: number; start_date: string;
  reason: string; status: 'pendiente' | 'activo' | 'rechazado' | 'liquidado' | 'cancelado'; created_by: string; decision_note: string | null; created_at: string }
interface SkipRow { id: string; loan_id: string; skip_date: string; reason: string; status: 'pendiente' | 'autorizado' | 'rechazado' }
const LSTAT: Record<LoanRow['status'], string> = { pendiente: 'bg-amber-100 text-amber-700', activo: 'bg-blue-100 text-blue-700',
  liquidado: 'bg-green-100 text-green-700', rechazado: 'bg-slate-200 text-slate-600', cancelado: 'bg-slate-200 text-slate-600' };

/** Préstamos: de la empresa (sin interés) o personales del director (con interés). Saldo automático con cada nómina autorizada. */
function LoansPanel({ emp }: { emp: Emp }) {
  const { can, user } = useAuth();
  const [rows, setRows] = useState<LoanRow[]>([]); const [paid, setPaid] = useState<Record<string, number>>({}); const [skips, setSkips] = useState<SkipRow[]>([]);
  const [open, setOpen] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [f, setF] = useState({ lender: 'empresa' as 'empresa' | 'director', principal: '', interest: '', installment: '', start: new Date().toLocaleDateString('en-CA'), reason: '' });
  const isDirector = user?.role === 'director';

  const load = useCallback(async () => {
    const l = await supabase.from('loans').select('id,lender,principal_cents,interest_cents,installment_cents,start_date,reason,status,created_by,decision_note,created_at')
      .eq('employee_id', emp.id).order('created_at', { ascending: false });
    if (l.error) return setMsg(l.error.message);
    const list = (l.data as LoanRow[]) ?? []; setRows(list);
    if (!list.length) { setPaid({}); setSkips([]); return; }
    const ids = list.map(x => x.id);
    const [p, s] = await Promise.all([supabase.from('loan_payments').select('loan_id,amount_cents').in('loan_id', ids),
      supabase.from('loan_skips').select('id,loan_id,skip_date,reason,status').in('loan_id', ids).order('skip_date', { ascending: false })]);
    const m: Record<string, number> = {}; for (const x of (p.data as { loan_id: string; amount_cents: number }[]) ?? []) m[x.loan_id] = (m[x.loan_id] ?? 0) + x.amount_cents;
    setPaid(m); setSkips((s.data as SkipRow[]) ?? []);
  }, [emp.id]);
  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const p = pesosToCents(f.principal), inst = pesosToCents(f.installment), int = f.lender === 'director' ? pesosToCents(f.interest || '0') : 0;
    if (!p || !inst || int === null) return setMsg('Revisa los importes.');
    const total = p + int;
    if (!window.confirm(`${f.lender === 'director' ? 'Préstamo PERSONAL DEL DIRECTOR' : 'Préstamo de la empresa'}: ${formatMXN(p)}${int ? ` + ${formatMXN(int)} de interés` : ''} = ${formatMXN(total)}, pagando ${formatMXN(inst)} por periodo (unos ${Math.ceil(total / inst)} pagos). Queda pendiente de autorizar. ¿Registrar?`)) return;
    const { error } = await supabase.from('loans').insert({ company_id: emp.company_id, employee_id: emp.id, lender: f.lender, principal_cents: p,
      interest_cents: int, installment_cents: inst, start_date: f.start, reason: f.reason.trim() });
    if (error) return setMsg(error.message);
    setOpen(false); load();
  }
  async function setStatus(l: LoanRow, status: 'activo' | 'rechazado' | 'cancelado') {
    const note = window.prompt(`¿${{ activo: 'Autorizar', rechazado: 'Rechazar', cancelado: 'Cancelar' }[status]} este préstamo? Nota (opcional):`);
    if (note === null) return;
    const { data, error } = await supabase.from('loans').update({ status, decision_note: note.trim() || null }).eq('id', l.id).select('id');
    if (error) return setMsg(error.message); if (!data?.length) return setMsg('No se aplicó: sin permiso.'); load();
  }
  async function abono(l: LoanRow) {
    const v = window.prompt('Abono fuera de nómina (p. ej. pagó en efectivo). Importe $:'); if (!v) return;
    const c = pesosToCents(v); if (!c) return setMsg('Importe inválido.');
    const note = window.prompt('Motivo / referencia:'); if (!note?.trim()) return;
    const { error } = await supabase.from('loan_payments').insert({ loan_id: l.id, amount_cents: c, source: 'manual', note: note.trim() });
    if (error) setMsg(error.message); else load();
  }
  async function skip(l: LoanRow) {
    const d = window.prompt('¿Qué periodo se salta? Escribe una fecha dentro de ese periodo (AAAA-MM-DD):', new Date().toLocaleDateString('en-CA'));
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    const reason = window.prompt('Motivo (lo pidió el empleado porque…):'); if (!reason?.trim()) return;
    const { error } = await supabase.from('loan_skips').insert({ loan_id: l.id, skip_date: d, reason: reason.trim() });
    if (error) setMsg(error.message); else load();
  }
  async function decideSkip(s: SkipRow, status: 'autorizado' | 'rechazado') {
    const { error } = await supabase.from('loan_skips').update({ status }).eq('id', s.id);
    if (error) setMsg(error.message); else load();
  }
  const canEdit = can('payroll', 'edit'), canAuth = can('payroll', 'authorize');

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex items-center"><h4 className="text-sm font-semibold">Préstamos</h4>
        {canEdit && <button className="ml-auto text-sm text-brand" onClick={() => setOpen(!open)}>+ Nuevo préstamo</button>}</div>
      {open && (
        <form onSubmit={add} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
          <label className="text-xs">Quién presta<select className={field} value={f.lender} onChange={e => setF({ ...f, lender: e.target.value as 'empresa' | 'director', interest: '' })}>
            <option value="empresa">La empresa (sin interés)</option><option value="director">El director, de su dinero personal</option></select></label>
          <label className="text-xs">Monto prestado ($)<input required inputMode="decimal" className={field} value={f.principal} onChange={e => setF({ ...f, principal: e.target.value })} /></label>
          {f.lender === 'director'
            ? <label className="text-xs">Interés total acordado ($)<input inputMode="decimal" className={field} value={f.interest} onChange={e => setF({ ...f, interest: e.target.value })} /></label>
            : <p className="self-end text-xs text-slate-500">Los préstamos de la empresa no generan interés (art. 111 LFT).</p>}
          <label className="text-xs">Pago por periodo ($)<input required inputMode="decimal" className={field} value={f.installment} onChange={e => setF({ ...f, installment: e.target.value })} /></label>
          <label className="text-xs">Empieza a descontarse en el periodo que incluye<input type="date" required className={field} value={f.start} onChange={e => setF({ ...f, start: e.target.value })} /></label>
          <label className="text-xs">Motivo<input required className={field} value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} /></label>
          <div className="sm:col-span-2"><button className="rounded-lg border border-brand px-3 py-2 text-sm text-brand">Registrar (queda pendiente de autorizar)</button></div>
        </form>)}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {rows.map(l => {
        const total = l.principal_cents + l.interest_cents; const balance = total - (paid[l.id] ?? 0);
        const mine = skips.filter(s => s.loan_id === l.id);
        return (
          <div key={l.id} className="space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <b>{l.lender === 'director' ? 'Préstamo personal del director' : 'Préstamo de la empresa'}</b>
              <span>{formatMXN(l.principal_cents)}{l.interest_cents ? ` + ${formatMXN(l.interest_cents)} interés` : ''}</span>
              <span className="text-xs text-slate-500">{formatMXN(l.installment_cents)} por periodo desde {l.start_date}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${LSTAT[l.status]}`}>{l.status}</span>
              {(l.status === 'activo' || l.status === 'liquidado') && <span className="ml-auto font-semibold">Saldo {formatMXN(balance)}</span>}
            </div>
            <p className="text-xs text-slate-400">{l.reason}{l.decision_note ? ` · ${l.decision_note}` : ''}</p>
            {mine.map(s => <p key={s.id} className="text-xs">Saltar periodo del {s.skip_date}: <b>{s.status}</b> <span className="text-slate-400">({s.reason})</span>
              {s.status === 'pendiente' && isDirector && <> · <button className="text-green-700" onClick={() => decideSkip(s, 'autorizado')}>Autorizar</button> · <button className="text-red-700" onClick={() => decideSkip(s, 'rechazado')}>Rechazar</button></>}</p>)}
            <div className="space-x-3 text-xs">
              {l.status === 'pendiente' && canAuth && (l.created_by !== user?.id || isDirector) && (l.lender === 'empresa' || isDirector) && <>
                <button className="text-green-700" onClick={() => setStatus(l, 'activo')}>Autorizar</button>
                <button className="text-red-700" onClick={() => setStatus(l, 'rechazado')}>Rechazar</button></>}
              {l.status === 'activo' && canEdit && <>
                <button className="text-brand" onClick={() => skip(l)}>Solicitar saltar un periodo</button>
                <button className="text-brand" onClick={() => abono(l)}>Registrar abono fuera de nómina</button></>}
              {l.status === 'activo' && (canEdit || canAuth) && <button className="text-red-700" onClick={() => setStatus(l, 'cancelado')}>Cancelar</button>}
            </div>
          </div>);
      })}
    </div>
  );
}
