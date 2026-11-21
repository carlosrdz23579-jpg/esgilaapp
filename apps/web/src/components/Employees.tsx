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
interface Rate { id: number; hourly_rate_cents: number; previous_rate_cents: number | null; effective_from: string; created_at: string }

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
  const { companies, companyId, can } = useAuth();
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
    const res = emp
      ? await supabase.from('employees').update(payload).eq('id', emp.id).select('id')
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
          <label className="sm:col-span-2 text-xs">Nombre completo<input required className={field} value={f.full_name} onChange={e => set('full_name', e.target.value)} /></label>
          <label className="text-xs">Empresa
            <select required disabled={!!emp} className={field} value={f.company_id} onChange={e => { set('company_id', e.target.value); set('department_id', ''); set('group_id', ''); }}>
              <option value="" disabled>Selecciona…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}
            </select></label>
          <label className="text-xs">Departamento
            <select required className={field} value={f.department_id} onChange={e => { set('department_id', e.target.value); set('group_id', ''); }}>
              <option value="" disabled>Selecciona…</option>{myDepts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></label>
          <label className="text-xs">Grupo
            <select className={field} value={f.group_id} onChange={e => set('group_id', e.target.value)}>
              <option value="">Sin grupo</option>{myGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select></label>
          {isCoachDept && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={head} onChange={e => setHead(e.target.checked)} />Es Head Coach</label>}
          <fieldset className="sm:col-span-2 text-xs">
            <legend>Días que trabaja (si el día de pago no es uno de ellos, se le paga su día laborable anterior)</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'].map((d, i) => (
                <label key={i} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={workDays.includes(i)}
                  onChange={e => setWorkDays(w => e.target.checked ? [...w, i] : w.filter(x => x !== i))} />{d}</label>))}
            </div>
          </fieldset>
          <label className="text-xs">Puesto<input className={field} value={f.job_title} onChange={e => set('job_title', e.target.value)} /></label>
          <label className="text-xs">Fecha de ingreso<input type="date" className={field} value={f.hire_date} onChange={e => set('hire_date', e.target.value)} /></label>
          <label className="text-xs">Tipo de contratación<input className={field} value={f.contract_type} onChange={e => set('contract_type', e.target.value)} /></label>
          <label className="text-xs">Teléfono<input className={field} value={f.phone} onChange={e => set('phone', e.target.value)} /></label>
          <label className="text-xs">Correo<input type="email" className={field} value={f.email} onChange={e => set('email', e.target.value)} /></label>
          <label className="text-xs">CURP<input maxLength={18} className={field} value={f.curp} onChange={e => set('curp', e.target.value)} /></label>
          <label className="text-xs">RFC<input maxLength={13} className={field} value={f.rfc} onChange={e => set('rfc', e.target.value)} /></label>
          <label className="text-xs">Fecha de nacimiento<input type="date" className={field} value={f.birth_date} onChange={e => set('birth_date', e.target.value)} /></label>
          <label className="sm:col-span-2 text-xs">Domicilio<input className={field} value={f.address} onChange={e => set('address', e.target.value)} /></label>
          {msg && <p className="sm:col-span-2 rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
          <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
            <button disabled={busy} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{emp ? 'Guardar cambios' : 'Crear empleado'}</button>
            {emp && <span className={`rounded-full px-2 py-0.5 text-xs ${badge[state]}`}>{state}</span>}
            {emp && state === 'activo' && <button type="button" onClick={() => changeState('suspendido')} className="text-sm text-amber-700">Suspender</button>}
            {emp && state === 'activo' && <button type="button" onClick={() => changeState('baja')} className="text-sm text-red-700">Dar de baja</button>}
            {emp && state !== 'activo' && <button type="button" onClick={() => changeState('activo')} className="text-sm text-green-700">Reactivar</button>}
          </div>
        </form>
        {emp && can('salary') && <SalaryPanel emp={emp} />}
      </div>
    </div>
  );
}

function SalaryPanel({ emp }: { emp: Emp }) {
  const { can } = useAuth();
  const [rates, setRates] = useState<Rate[]>([]);
  const [amount, setAmount] = useState(''); const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('employee_compensation_history')
      .select('id,hourly_rate_cents,previous_rate_cents,effective_from,created_at').eq('employee_id', emp.id).order('effective_from', { ascending: false });
    if (error) setMsg(error.message); else setRates((data as Rate[]) ?? []);
  }, [emp.id]);
  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const cents = pesosToCents(amount);
    if (cents === null) return setMsg('Importe inválido. Usa números, por ejemplo 120 o 120.50');
    if (!window.confirm(`¿Registrar pago por hora de ${formatMXN(cents)} a partir del ${from}? Este registro no se puede borrar ni editar.`)) return;
    const { error } = await supabase.from('employee_compensation_history')
      .insert({ employee_id: emp.id, company_id: emp.company_id, hourly_rate_cents: cents, effective_from: from });
    if (error) return setMsg(error.message.includes('duplicate') ? 'Ya existe un registro con esa fecha de vigencia.' : error.message);
    setAmount(''); load();
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <h4 className="text-sm font-semibold">Pago por hora (confidencial)</h4>
      <p className="text-sm">Vigente: <b>{rates[0] ? formatMXN(rates[0].hourly_rate_cents) : 'Sin registrar'}</b></p>
      {can('salary', 'edit') && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <label className="text-xs">Nuevo pago por hora ($)<input className={`${field} w-36`} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required /></label>
          <label className="text-xs">Vigente desde<input type="date" className={`${field} w-40`} value={from} onChange={e => setFrom(e.target.value)} required /></label>
          <button className="rounded-lg border border-brand px-3 py-2 text-sm text-brand">Registrar</button>
        </form>)}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {rates.length > 0 && (
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500"><tr><th>Vigente desde</th><th>Importe</th><th>Anterior</th><th>Registrado</th></tr></thead>
          <tbody>{rates.map(r => (<tr key={r.id} className="border-t">
            <td className="py-1">{r.effective_from}</td><td>{formatMXN(r.hourly_rate_cents)}</td>
            <td>{r.previous_rate_cents === null ? '—' : formatMXN(r.previous_rate_cents)}</td><td>{r.created_at.slice(0, 16).replace('T', ' ')}</td></tr>))}</tbody>
        </table>)}
    </div>
  );
}
