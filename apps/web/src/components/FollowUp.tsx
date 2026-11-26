import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { usePersisted } from '../lib/usePersisted';
import { Modal } from './ui';

interface Ind { id: string; company_id: string; name: string; description: string | null; kind: 'si_no' | 'escala';
  department_id: string | null; sort: number; is_active: boolean }
interface Emp { id: string; full_name: string; company_id: string; department_id: string; work_days: number[] | null }
interface Mark { employee_id: string; indicator_id: string; date: string; value: number | null; author_name: string | null; created_at: string }
interface Note { id: string; employee_id: string; date: string; visibility: 'publica' | 'privada'; body: string; author_name: string | null;
  created_by: string; created_at: string; deleted_at: string | null }
interface Dept { id: string; company_id: string; name: string }

const field = 'rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const TZ = 'America/Mexico_City';
const todayMx = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const monthRange = (m: string) => [m + '-01', new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10)] as const;
const fmtDate = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
const applies = (i: Ind, e: Emp) => i.is_active && i.company_id === e.company_id && (!i.department_id || i.department_id === e.department_id);

/** Resumen de un indicador en un conjunto de marcas: sí/no → "8/10 (80 %)", escala → promedio. */
function summarize(i: Ind, ms: Mark[]) {
  const v = ms.filter(m => m.indicator_id === i.id && m.value !== null).map(m => m.value!);
  if (!v.length) return { text: '—', tone: '' };
  if (i.kind === 'escala') {
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    return { text: `${avg.toFixed(1)} / 5`, tone: avg >= 4 ? 'text-green-700' : avg >= 3 ? 'text-amber-700' : 'text-red-700' };
  }
  const ok = v.filter(x => x === 1).length, pct = Math.round((ok / v.length) * 100);
  return { text: `${ok}/${v.length} · ${pct} %`, tone: pct >= 90 ? 'text-green-700' : pct >= 70 ? 'text-amber-700' : 'text-red-700' };
}

export default function FollowUp() {
  const { companyId, can, user } = useAuth();
  const canEdit = can('followup', 'edit'), canView = canEdit || can('followup', 'view'), canCfg = can('indicators', 'configure');
  const [me, setMe] = useState<Emp | null>(null);
  useEffect(() => {
    if (!user) return;
    supabase.from('employees').select('id,full_name,company_id,department_id,work_days').eq('user_id', user.id).limit(1)
      .then(r => setMe(((r.data as Emp[]) ?? [])[0] ?? null));
  }, [user]);
  const tabs = ([canEdit && ['dia', 'Calificar el día'], canView && ['mes', 'Resumen del mes'], canCfg && ['catalogo', 'Indicadores'],
    me && ['mio', 'Mi seguimiento']].filter(Boolean)) as [string, string][];
  const [tab, setTab] = usePersisted<string>('seguimiento.tab', 'dia');
  const current = tabs.some(t => t[0] === tab) ? tab : tabs[0]?.[0];

  const [inds, setInds] = useState<Ind[]>([]); const [emps, setEmps] = useState<Emp[]>([]); const [depts, setDepts] = useState<Dept[]>([]);
  const [error, setError] = useState<string | null>(null); const [open, setOpen] = useState<Emp | null>(null);
  const load = useCallback(async () => {
    setError(null);
    let i = supabase.from('indicators').select('*').order('sort').order('name');
    let e = supabase.from('employees').select('id,full_name,company_id,department_id,work_days').eq('state', 'activo').order('full_name');
    let d = supabase.from('departments').select('id,company_id,name').order('name');
    if (companyId !== 'all') { i = i.eq('company_id', companyId); e = e.eq('company_id', companyId); d = d.eq('company_id', companyId); }
    const [ri, re, rd] = await Promise.all([i, e, d]);
    setError(ri.error?.message ?? re.error?.message ?? rd.error?.message ?? null);
    setInds((ri.data as Ind[]) ?? []); setEmps(((re.data as Emp[]) ?? []).filter(x => x.id !== me?.id)); setDepts((rd.data as Dept[]) ?? []);
  }, [companyId, me?.id]);
  useEffect(() => { load(); }, [load]);

  if (!current) return <p className="rounded-xl border border-dashed bg-white p-4 text-sm text-slate-500">No tienes seguimiento asignado.</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b">
        {tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${current === k ? 'border-brand font-semibold text-brand' : 'border-transparent text-slate-500'}`}>{l}</button>)}
      </div>
      {error && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {current === 'dia' && <DayGrid inds={inds} emps={emps} depts={depts} onOpen={setOpen} />}
      {current === 'mes' && <MonthSummary inds={inds} emps={emps} depts={depts} onOpen={setOpen} />}
      {current === 'catalogo' && <Catalog inds={inds} depts={depts} onChanged={load} />}
      {current === 'mio' && me && <PersonFollowUp emp={me} inds={inds} own />}
      {open && <Modal title={`Seguimiento · ${open.full_name}`} onClose={() => setOpen(null)} wide>
        <PersonFollowUp emp={open} inds={inds} canWrite={canEdit} /></Modal>}
    </div>
  );
}

// ---------------------------------------------------------------- Calificar el día
function DayGrid({ inds, emps, depts, onOpen }: { inds: Ind[]; emps: Emp[]; depts: Dept[]; onOpen: (e: Emp) => void }) {
  const [date, setDate] = useState(todayMx()); const [fDept, setFDept] = usePersisted('seguimiento.depto', '');
  const [onlyWorking, setOnlyWorking] = useState(true);
  const [marks, setMarks] = useState<Mark[]>([]); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState('');
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  const list = emps.filter(e => (!fDept || e.department_id === fDept) && (!onlyWorking || !e.work_days?.length || e.work_days.includes(wd)));
  const cols = useMemo(() => inds.filter(i => i.is_active && list.some(e => applies(i, e))), [inds, list]);
  const load = useCallback(async () => {
    if (!list.length) return setMarks([]);
    const { data, error } = await supabase.from('indicator_marks_latest').select('employee_id,indicator_id,date,value,author_name,created_at')
      .eq('date', date).in('employee_id', list.map(e => e.id));
    if (error) setMsg(error.message); setMarks((data as Mark[]) ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, list.map(e => e.id).join()]);
  useEffect(() => { load(); }, [load]);

  const val = (e: string, i: string) => marks.find(m => m.employee_id === e && m.indicator_id === i)?.value ?? null;
  async function set(e: Emp, i: Ind, value: number | null) {
    setBusy(e.id + i.id); setMsg(null);
    const { error } = await supabase.from('indicator_marks').insert({ company_id: e.company_id, employee_id: e.id, indicator_id: i.id, date, value });
    setBusy(''); if (error) return setMsg(error.message);
    setMarks(ms => [...ms.filter(m => !(m.employee_id === e.id && m.indicator_id === i.id)),
      { employee_id: e.id, indicator_id: i.id, date, value, author_name: null, created_at: new Date().toISOString() }]);
  }
  async function allYes(i: Ind) {
    const pending = list.filter(e => applies(i, e) && val(e.id, i.id) === null);
    if (!pending.length) return;
    setBusy('all'); setMsg(null);
    const { error } = await supabase.from('indicator_marks').insert(pending.map(e => ({ company_id: e.company_id, employee_id: e.id, indicator_id: i.id, date, value: 1 })));
    setBusy(''); if (error) setMsg(error.message); else load();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">Día<input type="date" className={`${field} block`} value={date} max={todayMx()} onChange={e => setDate(e.target.value)} /></label>
        <label className="text-xs">Departamento<select className={`${field} block`} value={fDept} onChange={e => setFDept(e.target.value)}>
          <option value="">Todos</option>{depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="flex items-center gap-1 pb-2 text-sm"><input type="checkbox" checked={onlyWorking} onChange={e => setOnlyWorking(e.target.checked)} />Sólo quien trabaja ese día</label>
      </div>
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="px-3 py-2 uppercase">Persona</th>
            {cols.map(i => <th key={i.id} className="px-2 py-2 text-center" title={i.description ?? ''}>
              <div className="font-semibold uppercase">{i.name}</div>
              {i.kind === 'si_no' && <button disabled={busy === 'all'} className="text-[11px] font-normal text-brand" onClick={() => allYes(i)}>✓ a los que faltan</button>}</th>)}
            <th className="px-2 py-2"></th></tr></thead>
          <tbody>{list.map(e => (
            <tr key={e.id} className="border-t">
              <td className="px-3 py-2"><button className="text-left font-medium hover:text-brand" onClick={() => onOpen(e)}>{e.full_name}</button></td>
              {cols.map(i => {
                if (!applies(i, e)) return <td key={i.id} className="text-center text-slate-300">·</td>;
                const v = val(e.id, i.id); const b = busy === e.id + i.id;
                return <td key={i.id} className="px-2 py-1 text-center">{i.kind === 'si_no' ? (
                  <div className="inline-flex overflow-hidden rounded-lg border">
                    <button disabled={b} onClick={() => set(e, i, v === 1 ? null : 1)} className={`px-2 py-1 ${v === 1 ? 'bg-green-600 text-white' : 'text-slate-400 hover:bg-green-50'}`}>✓</button>
                    <button disabled={b} onClick={() => set(e, i, v === 0 ? null : 0)} className={`border-l px-2 py-1 ${v === 0 ? 'bg-red-600 text-white' : 'text-slate-400 hover:bg-red-50'}`}>✗</button>
                  </div>) : (
                  <select disabled={b} className={`rounded border px-1 py-1 ${v ? (v >= 4 ? 'bg-green-50' : v >= 3 ? 'bg-amber-50' : 'bg-red-50') : ''}`} value={v ?? ''}
                    onChange={ev => set(e, i, ev.target.value ? +ev.target.value : null)}>
                    <option value="">—</option>{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}</select>)}</td>;
              })}
              <td className="px-2 py-1 text-right"><button className="text-xs text-brand" onClick={() => onOpen(e)}>Notas</button></td>
            </tr>))}
            {!list.length && <tr><td colSpan={cols.length + 2} className="px-3 py-6 text-center text-slate-400">Nadie que mostrar.</td></tr>}
          </tbody>
        </table>
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <p className="text-xs text-slate-500">Toca ✓ o ✗; tocar otra vez la misma opción la quita. Lo que no marques no cuenta en el resumen. Queda guardado quién marcó y cuándo.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Resumen del mes
function MonthSummary({ inds, emps, depts, onOpen }: { inds: Ind[]; emps: Emp[]; depts: Dept[]; onOpen: (e: Emp) => void }) {
  const [month, setMonth] = useState(todayMx().slice(0, 7)); const [fDept, setFDept] = usePersisted('seguimiento.depto', '');
  const [marks, setMarks] = useState<Mark[]>([]); const [notes, setNotes] = useState<Note[]>([]);
  const list = emps.filter(e => !fDept || e.department_id === fDept);
  useEffect(() => {
    const [a, b] = monthRange(month); const ids = list.map(e => e.id); if (!ids.length) return;
    Promise.all([
      supabase.from('indicator_marks_latest').select('employee_id,indicator_id,date,value,author_name,created_at').gte('date', a).lte('date', b).in('employee_id', ids),
      supabase.from('employee_notes').select('id,employee_id,date,visibility,deleted_at').gte('date', a).lte('date', b).in('employee_id', ids).is('deleted_at', null),
    ]).then(([m, n]) => { setMarks((m.data as Mark[]) ?? []); setNotes((n.data as Note[]) ?? []); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, list.map(e => e.id).join()]);
  const cols = inds.filter(i => i.is_active && list.some(e => applies(i, e)));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 print:hidden">
        <label className="text-xs">Mes<input type="month" className={`${field} block`} value={month} onChange={e => setMonth(e.target.value)} /></label>
        <label className="text-xs">Departamento<select className={`${field} block`} value={fDept} onChange={e => setFDept(e.target.value)}>
          <option value="">Todos</option>{depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <button className="ml-auto rounded-lg border px-3 py-2 text-sm" onClick={() => window.print()}>Imprimir</button>
      </div>
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Persona</th>
            {cols.map(i => <th key={i.id} className="px-2 py-2 text-center">{i.name}</th>)}<th className="px-2 py-2 text-center">Notas</th></tr></thead>
          <tbody>{list.map(e => {
            const ms = marks.filter(m => m.employee_id === e.id); const ns = notes.filter(n => n.employee_id === e.id);
            return (
              <tr key={e.id} className="cursor-pointer border-t hover:bg-slate-50" onClick={() => onOpen(e)}>
                <td className="px-3 py-2 font-medium">{e.full_name}</td>
                {cols.map(i => { if (!applies(i, e)) return <td key={i.id} className="text-center text-slate-300">·</td>;
                  const s = summarize(i, ms); return <td key={i.id} className={`px-2 py-2 text-center ${s.tone}`}>{s.text}</td>; })}
                <td className="px-2 py-2 text-center">{ns.length ? `${ns.length}${ns.some(n => n.visibility === 'privada') ? ` (${ns.filter(n => n.visibility === 'privada').length} priv.)` : ''}` : '—'}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">Sí/no: veces que cumplió entre veces calificadas. Escala: promedio. Verde ≥ 90 % (o ≥ 4), ámbar ≥ 70 % (o ≥ 3), rojo abajo.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Catálogo de indicadores
function Catalog({ inds, depts, onChanged }: { inds: Ind[]; depts: Dept[]; onChanged: () => void }) {
  const { companies, companyId } = useAuth();
  const [form, setForm] = useState({ name: '', description: '', kind: 'si_no', department_id: '', company_id: companyId !== 'all' ? companyId : '' });
  const [msg, setMsg] = useState<string | null>(null);
  async function add(ev: React.FormEvent) {
    ev.preventDefault(); setMsg(null);
    const { error } = await supabase.from('indicators').insert({ ...form, name: form.name.trim(), description: form.description.trim() || null,
      department_id: form.department_id || null, sort: inds.length + 1 });
    if (error) return setMsg(error.message.includes('unique') ? 'Ya existe un indicador con ese nombre.' : error.message);
    setForm({ ...form, name: '', description: '' }); onChanged();
  }
  async function patch(i: Ind, p: Partial<Ind>) {
    const { error } = await supabase.from('indicators').update(p).eq('id', i.id); if (error) setMsg(error.message); else onChanged();
  }
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Indicador</th><th className="px-3 py-2">Tipo</th>
            <th className="px-3 py-2">Aplica a</th>{companyId === 'all' && <th className="px-3 py-2">Sucursal</th>}<th className="px-3 py-2">Activo</th></tr></thead>
          <tbody>{inds.map(i => (
            <tr key={i.id} className="border-t">
              <td className="px-3 py-2"><input className="w-full rounded border px-2 py-1 font-medium" defaultValue={i.name} onBlur={e => e.target.value.trim() && e.target.value !== i.name && patch(i, { name: e.target.value.trim() })} />
                <input className="mt-1 w-full rounded border px-2 py-1 text-xs text-slate-500" placeholder="Descripción" defaultValue={i.description ?? ''} onBlur={e => e.target.value !== (i.description ?? '') && patch(i, { description: e.target.value || null })} /></td>
              <td className="px-3 py-2">{i.kind === 'si_no' ? 'Sí / No' : 'Escala 1–5'}</td>
              <td className="px-3 py-2"><select className="rounded border px-2 py-1" value={i.department_id ?? ''} onChange={e => patch(i, { department_id: e.target.value || null })}>
                <option value="">Todos</option>{depts.filter(d => d.company_id === i.company_id).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></td>
              {companyId === 'all' && <td className="px-3 py-2">{companies.find(c => c.id === i.company_id)?.trade_name}</td>}
              <td className="px-3 py-2"><input type="checkbox" checked={i.is_active} onChange={e => patch(i, { is_active: e.target.checked })} /></td>
            </tr>))}</tbody>
        </table>
      </div>
      <form onSubmit={add} className="flex flex-wrap items-end gap-2 rounded-xl bg-white p-4 shadow-sm">
        <label className="text-xs">Nuevo indicador<input required className={`${field} block`} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        <label className="grow text-xs">Descripción<input className={`${field} block w-full`} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
        <label className="text-xs">Tipo<select className={`${field} block`} value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>
          <option value="si_no">Sí / No</option><option value="escala">Escala 1–5</option></select></label>
        {companyId === 'all' && <label className="text-xs">Sucursal<select required className={`${field} block`} value={form.company_id} onChange={e => setForm({ ...form, company_id: e.target.value })}>
          <option value="">Elige…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</select></label>}
        <label className="text-xs">Aplica a<select className={`${field} block`} value={form.department_id} onChange={e => setForm({ ...form, department_id: e.target.value })}>
          <option value="">Todos</option>{depts.filter(d => d.company_id === form.company_id).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <button className="rounded-lg bg-brand px-4 py-2 text-sm text-white">Agregar</button>
      </form>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <p className="text-xs text-slate-500">Desactivar un indicador lo quita de la captura pero conserva lo ya calificado.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Seguimiento de una persona
export function PersonFollowUp({ emp, inds, canWrite, own }: { emp: Emp | { id: string; company_id: string; department_id: string; full_name: string; work_days?: number[] | null };
  inds?: Ind[]; canWrite?: boolean; own?: boolean }) {
  const { user } = useAuth();
  const [month, setMonth] = useState(todayMx().slice(0, 7));
  const [allInds, setAllInds] = useState<Ind[]>(inds ?? []);
  const [marks, setMarks] = useState<Mark[]>([]); const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState(''); const [vis, setVis] = useState<'publica' | 'privada'>('privada'); const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (!inds) supabase.from('indicators').select('*').eq('company_id', emp.company_id).order('sort').then(r => setAllInds((r.data as Ind[]) ?? [])); else setAllInds(inds); }, [inds, emp.company_id]);
  const load = useCallback(async () => {
    const [a, b] = monthRange(month);
    const [m, n] = await Promise.all([
      supabase.from('indicator_marks_latest').select('employee_id,indicator_id,date,value,author_name,created_at').eq('employee_id', emp.id).gte('date', a).lte('date', b).order('date'),
      supabase.from('employee_notes').select('*').eq('employee_id', emp.id).order('date', { ascending: false }).order('created_at', { ascending: false }).limit(200)]);
    setMarks(((m.data as Mark[]) ?? []).filter(x => x.value !== null)); setNotes((n.data as Note[]) ?? []);
  }, [emp.id, month]);
  useEffect(() => { load(); }, [load]);
  const e = { work_days: null, ...emp } as Emp;
  const cols = allInds.filter(i => applies(i, e) || marks.some(m => m.indicator_id === i.id));
  const misses = marks.filter(m => { const i = allInds.find(x => x.id === m.indicator_id); return i && (i.kind === 'si_no' ? m.value === 0 : (m.value ?? 5) <= 2); });

  async function add() {
    setMsg(null);
    const { error } = await supabase.from('employee_notes').insert({ company_id: emp.company_id, employee_id: emp.id, visibility: vis, body: body.trim() });
    if (error) return setMsg(error.message); setBody(''); load();
  }
  async function del(n: Note) {
    if (!confirm('¿Borrar esta nota? Dirección la seguirá viendo.')) return;
    const { error } = await supabase.from('employee_notes').update({ deleted_at: new Date().toISOString() }).eq('id', n.id);
    if (error) setMsg(error.message); else load();
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3"><h4 className="text-sm font-semibold">Indicadores</h4>
        <input type="month" className="rounded border px-2 py-1 text-sm" value={month} onChange={ev => setMonth(ev.target.value)} /></div>
      <div className="flex flex-wrap gap-2">{cols.map(i => { const s = summarize(i, marks); return (
        <div key={i.id} className="rounded-lg border px-3 py-2 text-sm"><div className="text-xs text-slate-500">{i.name}</div><div className={`font-semibold ${s.tone}`}>{s.text}</div></div>); })}
        {!cols.length && <span className="text-sm text-slate-400">Sin indicadores.</span>}</div>
      {misses.length > 0 && <div className="text-xs text-slate-600"><span className="font-medium">Días a revisar:</span> {misses.map(m => (
        <span key={m.indicator_id + m.date} className="mr-2 inline-block rounded bg-red-50 px-2 py-0.5 text-red-700">{fmtDate(m.date)} · {allInds.find(i => i.id === m.indicator_id)?.name}{m.value ? ` ${m.value}` : ''}</span>))}</div>}

      <div className="space-y-2 border-t pt-3">
        <h4 className="text-sm font-semibold">Notas {own && <span className="font-normal text-slate-500">(las que dirección comparte contigo)</span>}</h4>
        {canWrite && !own && <div className="space-y-2 rounded-lg border p-2">
          <textarea className={`${field} w-full`} rows={2} value={body} onChange={ev => setBody(ev.target.value)} placeholder="Qué pasó, qué se platicó, qué se acordó…" />
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-1"><input type="radio" checked={vis === 'privada'} onChange={() => setVis('privada')} />Privada <span className="text-xs text-slate-500">(no la ve la persona)</span></label>
            <label className="flex items-center gap-1"><input type="radio" checked={vis === 'publica'} onChange={() => setVis('publica')} />Pública <span className="text-xs text-slate-500">(la ve en Mi seguimiento)</span></label>
            <button disabled={!body.trim()} className="ml-auto rounded-lg bg-brand px-3 py-1.5 text-white disabled:opacity-50" onClick={add}>Guardar</button></div>
        </div>}
        {notes.map(n => (
          <div key={n.id} className={`rounded-lg border p-2 text-sm ${n.deleted_at ? 'border-dashed bg-slate-50 text-slate-400' : n.visibility === 'privada' ? 'border-amber-200 bg-amber-50/40' : ''}`}>
            <p className="whitespace-pre-wrap">{n.body}</p>
            <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-slate-500">{fmtDate(n.date)} · {n.author_name ?? '—'}
              {!own && <span className={n.visibility === 'privada' ? 'text-amber-700' : 'text-green-700'}>{n.visibility === 'privada' ? 'privada' : 'pública'}</span>}
              {n.deleted_at && <span>· borrada {new Date(n.deleted_at).toLocaleDateString('es-MX')}</span>}
              {!own && !n.deleted_at && (n.created_by === user?.id || user?.role === 'director') && <button className="ml-auto text-red-600" onClick={() => del(n)}>Borrar</button>}</p>
          </div>))}
        {!notes.length && <p className="text-sm text-slate-400">Sin notas.</p>}
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
    </div>
  );
}
