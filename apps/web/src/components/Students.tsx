import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { usePersisted } from '../lib/usePersisted';
import { Modal } from './ui';
import { parseEvoSheet, type EvoReport } from '@domain/evo';
import StudentPlans from './StudentPlans';

interface Cls { id: string; company_id: string; activity: string; start_time: string; end_time: string; duration_override_min: number | null;
  detected_min: number; duration_min: number; is_active: boolean }
interface Stu { id: string; company_id: string; evo_id: string | null; full_name: string; phone: string | null; birth_date: string | null;
  enrolled_on: string | null; is_active: boolean }
interface Enr { student_id: string; class_id: string; month: string; weekdays: number[]; plan?: { start: string; end: string | null } }
interface Att { student_id: string; class_id: string; date: string; arrival: string | null; extra: boolean; annulled: boolean; created_at: string }
interface Note { id: string; student_id: string; body: string; author_name: string | null; created_by: string; created_at: string; deleted_at: string | null }

const field = 'rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const WD = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const TZ = 'America/Mexico_City';
export const todayMx = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
export const nowMx = () => new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dow = (iso: string) => new Date(iso + 'T12:00:00Z').getUTCDay();
const monthOf = (iso: string) => iso.slice(0, 7) + '-01';
const durLabel = (m: number) => (m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);
const age = (b: string | null) => {
  if (!b) return '—'; const t = new Date(), d = new Date(b + 'T12:00:00');
  let y = t.getFullYear() - d.getFullYear(); let m = t.getMonth() - d.getMonth(); if (t.getDate() < d.getDate()) m--; if (m < 0) { y--; m += 12; }
  return y < 3 ? `${y * 12 + m} meses` : `${y} años`;
};

/** Inscripción vigente de cada clase en una fecha: el mes importado más reciente que no sea posterior. */
function rosterFor(enr: Enr[], classId: string, date: string) {
  const mo = monthOf(date);
  const mine = enr.filter(e => !e.plan && e.class_id === classId && e.month <= mo);
  const m = mine.reduce((a, e) => (e.month > a ? e.month : a), '');
  const out = new Map(mine.filter(e => e.month === m).map(e => [e.student_id, { ...e }]));
  // + quienes tienen un plan asignado en Cobranza con este grupo (alumnas dadas de alta aquí, no en EVO)
  for (const e of enr) if (e.plan && e.class_id === classId && e.plan.start <= mo && (!e.plan.end || e.plan.end >= mo)) {
    const cur = out.get(e.student_id);
    out.set(e.student_id, cur ? { ...cur, weekdays: [...new Set([...cur.weekdays, ...e.weekdays])].sort() } : { ...e, month: mo });
  }
  return [...out.values()];
}

export default function Students() {
  const { companies, companyId, can } = useAuth();
  const canList = can('students', 'edit'), canNotes = can('students', 'create'), canCfg = can('students', 'configure');
  const tabs = [canList && ['lista', 'Pase de lista'], ['alumnas', 'Alumnas'], ['clases', 'Clases'], canCfg && ['importar', 'Importar de EVO']]
    .filter(Boolean) as [string, string][];
  const [tab, setTab] = usePersisted<string>('alumnas.tab', tabs[0][0]);
  const [classes, setClasses] = useState<Cls[]>([]); const [students, setStudents] = useState<Stu[]>([]);
  const [enr, setEnr] = useState<Enr[]>([]); const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Stu | null>(null);

  const load = useCallback(async () => {
    setError(null);
    let c = supabase.from('class_groups_v').select('*').order('activity').order('start_time');
    let s = supabase.from('students').select('*').order('full_name').limit(2000);
    let e = supabase.from('student_enrollments').select('student_id,class_id,month,weekdays').limit(10000);
    if (companyId !== 'all') { c = c.eq('company_id', companyId); s = s.eq('company_id', companyId); e = e.eq('company_id', companyId); }
    let pm = supabase.from('subscription_members').select('student_id,class_id,weekdays,subscriptions!inner(start_month,end_month,cancelled_at,company_id)')
      .not('class_id', 'is', null).is('subscriptions.cancelled_at', null).limit(10000);
    if (companyId !== 'all') pm = pm.eq('subscriptions.company_id', companyId);
    const [rc, rs, re, rp] = await Promise.all([c, s, e, pm]);
    setError(rc.error?.message ?? rs.error?.message ?? re.error?.message ?? null);
    type PMRow = { student_id: string; class_id: string; weekdays: number[]; subscriptions: { start_month: string; end_month: string | null } };
    const planEnr: Enr[] = ((rp.data as unknown as PMRow[]) ?? []).map(x => ({ student_id: x.student_id, class_id: x.class_id, month: '', weekdays: x.weekdays,
      plan: { start: x.subscriptions.start_month, end: x.subscriptions.end_month } }));
    setClasses((rc.data as Cls[]) ?? []); setStudents((rs.data as Stu[]) ?? []); setEnr([...((re.data as Enr[]) ?? []), ...planEnr]);
  }, [companyId]);
  useEffect(() => { load(); }, [load]);
  const current = tabs.some(t => t[0] === tab) ? tab : tabs[0][0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b">
        {tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${current === k ? 'border-brand font-semibold text-brand' : 'border-transparent text-slate-500'}`}>{l}</button>)}
      </div>
      {error && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {current === 'lista' && <RollCall classes={classes} students={students} enr={enr} onOpen={setOpen} />}
      {current === 'alumnas' && <StudentList classes={classes} students={students} enr={enr} onOpen={st => { setOpen(st); if (!students.some(x => x.id === st.id)) load(); }} />}
      {current === 'clases' && <ClassList classes={classes} enr={enr} canCfg={canCfg} onChanged={load} companies={companies} />}
      {current === 'importar' && <EvoImport onDone={() => { load(); setTab('alumnas'); }} />}
      {open && <StudentCard s={open} classes={classes} enr={enr} canNotes={canNotes} canCfg={canCfg} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

// ---------------------------------------------------------------- Pase de lista
function RollCall({ classes, students, enr, onOpen }: { classes: Cls[]; students: Stu[]; enr: Enr[]; onOpen: (s: Stu) => void }) {
  const [date, setDate] = useState(todayMx());
  const [att, setAtt] = useState<Att[]>([]); const [msg, setMsg] = useState<string | null>(null);
  const [times, setTimes] = useState<Record<string, string>>({}); const [adding, setAdding] = useState(''); const [busy, setBusy] = useState(false);
  const wd = dow(date);
  // Clases con alumnas ese día de la semana, la más cercana a la hora actual primero.
  const dayClasses = useMemo(() => classes.filter(c => c.is_active && rosterFor(enr, c.id, date).some(e => e.weekdays.includes(wd))), [classes, enr, date, wd]);
  const [classId, setClassId] = useState('');
  useEffect(() => {
    if (dayClasses.some(c => c.id === classId)) return;
    const now = nowMx(); const next = dayClasses.find(c => c.end_time > now) ?? dayClasses[0];
    setClassId(next?.id ?? '');
  }, [dayClasses, classId]);
  const cls = classes.find(c => c.id === classId);

  const loadAtt = useCallback(async () => {
    if (!classId) return setAtt([]);
    const { data, error } = await supabase.from('student_attendance_latest').select('*').eq('class_id', classId).eq('date', date);
    if (error) setMsg(error.message); setAtt((data as Att[]) ?? []);
  }, [classId, date]);
  useEffect(() => { loadAtt(); }, [loadAtt]);

  const sById = useMemo(() => new Map(students.map(s => [s.id, s])), [students]);
  const roster = cls ? rosterFor(enr, cls.id, date) : [];
  const due = roster.filter(e => e.weekdays.includes(wd)).map(e => e.student_id);
  const extras = att.filter(a => !a.annulled && !due.includes(a.student_id)).map(a => a.student_id);
  const list = [...due, ...extras].map(id => sById.get(id)).filter(Boolean).sort((a, b) => a!.full_name.localeCompare(b!.full_name)) as Stu[];
  const rec = (id: string) => att.find(a => a.student_id === id && !a.annulled);
  const defTime = date === todayMx() ? nowMx() : (cls?.start_time ?? '00:00');

  async function mark(ids: string[], arrival: (id: string) => string | null, annulled = false) {
    if (!cls || !ids.length) return; setBusy(true); setMsg(null);
    const { error } = await supabase.from('student_attendance').insert(ids.map(id => ({
      company_id: cls.company_id, student_id: id, class_id: cls.id, date, arrival: annulled ? null : arrival(id),
      extra: !due.includes(id), annulled })));
    setBusy(false); if (error) setMsg(error.message); else loadAtt();
  }
  const pending = list.filter(s => !rec(s.id)).map(s => s.id);
  const present = list.filter(s => rec(s.id)?.arrival).length, absent = list.filter(s => rec(s.id) && !rec(s.id)!.arrival).length;
  const others = students.filter(s => s.is_active && s.company_id === cls?.company_id && !list.some(l => l.id === s.id));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">Día<input type="date" className={`${field} block`} value={date} max={todayMx()} onChange={e => setDate(e.target.value)} /></label>
        <label className="text-xs">Clase<select className={`${field} block`} value={classId} onChange={e => setClassId(e.target.value)}>
          {!dayClasses.length && <option value="">No hay clases este día</option>}
          {dayClasses.map(c => <option key={c.id} value={c.id}>{c.start_time}–{c.end_time} · {c.activity}</option>)}</select></label>
        {cls && <p className="pb-2 text-sm text-slate-500">{WD[wd]} · {list.length} alumnas · <span className="text-green-700">{present} llegaron</span> · <span className="text-red-700">{absent} faltaron</span> · {pending.length} sin marcar</p>}
      </div>
      {cls && (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
              <th className="px-3 py-2">Alumna</th><th className="px-3 py-2">Hora de llegada</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2"></th></tr></thead>
            <tbody>
              {list.map(s => {
                const r = rec(s.id); const t = times[s.id] ?? r?.arrival ?? defTime;
                return (
                  <tr key={s.id} className="border-t">
                    <td className="px-3 py-2"><button className="text-left hover:text-brand" onClick={() => onOpen(s)}>{s.full_name}</button>
                      {!due.includes(s.id) && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">no le tocaba</span>}</td>
                    <td className="px-3 py-2"><input type="time" className="rounded border px-2 py-1" value={t} onChange={e => setTimes({ ...times, [s.id]: e.target.value })} /></td>
                    <td className="px-3 py-2">{!r ? <span className="text-slate-400">sin marcar</span> : r.arrival
                      ? <span className="text-green-700">✓ llegó {r.arrival}{r.arrival > cls.start_time ? <span className="ml-1 text-amber-700">(tarde)</span> : null}</span>
                      : <span className="text-red-700">✗ faltó</span>}</td>
                    <td className="space-x-2 whitespace-nowrap px-3 py-2 text-right">
                      <button disabled={busy} className="rounded-lg bg-green-600 px-3 py-1 text-white disabled:opacity-50" onClick={() => mark([s.id], () => t)}>Llegó</button>
                      <button disabled={busy} className="rounded-lg border border-red-300 px-3 py-1 text-red-700 disabled:opacity-50" onClick={() => mark([s.id], () => null)}>Faltó</button>
                      {r && !due.includes(s.id) && <button disabled={busy} className="text-xs text-slate-500" onClick={() => mark([s.id], () => null, true)}>Quitar</button>}
                    </td>
                  </tr>);
              })}
              {!list.length && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Nadie tiene esta clase este día</td></tr>}
            </tbody>
          </table>
        </div>)}
      {cls && (
        <div className="flex flex-wrap items-center gap-2">
          {pending.length > 0 && <button disabled={busy} className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700" onClick={() => mark(pending, () => null)}>Marcar falta a las {pending.length} sin marcar</button>}
          <select className={field} value={adding} onChange={e => setAdding(e.target.value)}>
            <option value="">+ Llegó alguien que no le tocaba…</option>
            {others.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}</select>
          {adding && <button disabled={busy} className="rounded-lg bg-brand px-3 py-2 text-sm text-white" onClick={() => { mark([adding], () => defTime); setAdding(''); }}>Agregar a las {defTime}</button>}
        </div>)}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <p className="text-xs text-slate-500">La hora sale con la hora actual de México; cámbiala antes de marcar si llegó a otra hora. Si te equivocas, vuelve a marcar: queda la última.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Lista de alumnas
function NewStudent({ onCreated }: { onCreated: (s: Stu) => void }) {
  const { companies, companyId } = useAuth();
  const [f, setF] = useState({ company_id: companyId !== 'all' ? companyId : '', full_name: '', birth_date: '', phone: '', enrolled_on: todayMx() });
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function save(ev: React.FormEvent) {
    ev.preventDefault(); setBusy(true); setMsg(null);
    const { data, error } = await supabase.from('students').insert({ company_id: f.company_id, full_name: f.full_name.trim().replace(/\s+/g, ' '),
      birth_date: f.birth_date || null, phone: f.phone.trim() || null, enrolled_on: f.enrolled_on || null }).select('*').single();
    setBusy(false); if (error) return setMsg(error.message); onCreated(data as Stu);
  }
  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-2 rounded-xl border-2 border-brand/30 bg-white p-4 text-sm shadow-sm">
      <label className="text-xs">Sucursal<select required className={`${field} block`} value={f.company_id} onChange={e => setF({ ...f, company_id: e.target.value })}>
        <option value="">Elige…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</select></label>
      <label className="text-xs">Nombre completo<input required autoFocus className={`${field} block w-64`} value={f.full_name} onChange={e => setF({ ...f, full_name: e.target.value })} /></label>
      <label className="text-xs">Nacimiento<input type="date" className={`${field} block`} value={f.birth_date} onChange={e => setF({ ...f, birth_date: e.target.value })} /></label>
      <label className="text-xs">Teléfono<input className={`${field} block w-36`} value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></label>
      <label className="text-xs">Inscripción<input type="date" className={`${field} block`} value={f.enrolled_on} onChange={e => setF({ ...f, enrolled_on: e.target.value })} /></label>
      <button disabled={busy} className="rounded-lg bg-brand px-4 py-2 text-white disabled:opacity-50">Guardar y abrir ficha</button>
      {msg && <p className="w-full rounded bg-red-50 p-2 text-red-700">{msg}</p>}
      <p className="w-full text-xs text-slate-500">En la ficha le asignas plan, grupo y días (Cobranza) y la ligas a su familia. Con eso ya aparece en el pase de lista de su grupo.</p>
    </form>
  );
}

function StudentList({ classes, students, enr, onOpen }: { classes: Cls[]; students: Stu[]; enr: Enr[]; onOpen: (s: Stu) => void }) {
  const { can } = useAuth(); const canAdd = can('students', 'configure') || can('billing', 'edit');
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState(''); const [fClass, setFClass] = useState(''); const [onlyActive, setOnlyActive] = useState(true);
  const today = todayMx();
  const cur = useMemo(() => classes.flatMap(c => rosterFor(enr, c.id, today).map(e => ({ ...e, c }))), [classes, enr, today]);
  const rows = students.filter(s => (!onlyActive || s.is_active) && (!q || s.full_name.toLowerCase().includes(q.toLowerCase()) || s.evo_id === q)
    && (!fClass || cur.some(e => e.student_id === s.id && e.class_id === fClass)));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className={field} placeholder="Buscar por nombre o ID de EVO" value={q} onChange={e => setQ(e.target.value)} />
        <select className={field} value={fClass} onChange={e => setFClass(e.target.value)}><option value="">Todas las clases</option>
          {classes.map(c => <option key={c.id} value={c.id}>{c.activity} · {c.start_time}</option>)}</select>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)} />Sólo activas</label>
        {canAdd && !adding && <button className="ml-auto rounded-lg bg-brand px-3 py-2 text-sm text-white" onClick={() => setAdding(true)}>+ Nueva alumna</button>}
        <span className="text-sm text-slate-500">{rows.length} alumnas</span>
      </div>
      {adding && <NewStudent onCreated={st => { setAdding(false); onOpen(st); }} />}
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Nombre</th><th className="px-3 py-2">Edad</th>
            <th className="px-3 py-2">Clases</th><th className="px-3 py-2">Teléfono</th><th className="px-3 py-2">ID EVO</th></tr></thead>
          <tbody>{rows.map(s => (
            <tr key={s.id} className="cursor-pointer border-t hover:bg-slate-50" onClick={() => onOpen(s)}>
              <td className="px-3 py-2 font-medium">{s.full_name}{!s.is_active && <span className="ml-2 text-xs text-slate-400">inactiva</span>}</td>
              <td className="px-3 py-2">{age(s.birth_date)}</td>
              <td className="px-3 py-2">{cur.filter(e => e.student_id === s.id).map(e => `${e.c.activity} ${e.c.start_time} (${e.weekdays.map(w => WD[w]).join(', ')})`).join(' · ') || '—'}</td>
              <td className="px-3 py-2">{s.phone ?? '—'}</td><td className="px-3 py-2 text-slate-500">{s.evo_id ?? '—'}</td>
            </tr>))}
            {!rows.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">Sin alumnas. Impórtalas desde EVO.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Clases
function ClassList({ classes, enr, canCfg, onChanged, companies }:
  { classes: Cls[]; enr: Enr[]; canCfg: boolean; onChanged: () => void; companies: { id: string; trade_name: string }[] }) {
  const [msg, setMsg] = useState<string | null>(null); const today = todayMx();
  async function patch(c: Cls, p: Partial<Cls>) {
    const { error } = await supabase.from('class_groups').update(p).eq('id', c.id);
    if (error) setMsg(error.message); else onChanged();
  }
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Clase</th><th className="px-3 py-2">Sucursal</th>
            <th className="px-3 py-2">Horario</th><th className="px-3 py-2">Días</th><th className="px-3 py-2">Alumnas</th><th className="px-3 py-2">Duración</th><th className="px-3 py-2">Activa</th></tr></thead>
          <tbody>{classes.map(c => {
            const r = rosterFor(enr, c.id, today); const days = [...new Set(r.flatMap(e => e.weekdays))].sort();
            return (
              <tr key={c.id} className="border-t">
                <td className="px-3 py-2 font-medium">{c.activity}</td>
                <td className="px-3 py-2">{companies.find(x => x.id === c.company_id)?.trade_name ?? ''}</td>
                <td className="px-3 py-2">{c.start_time}–{c.end_time}</td>
                <td className="px-3 py-2">{days.map(w => WD[w]).join(', ') || '—'}</td>
                <td className="px-3 py-2">{r.length}</td>
                <td className="px-3 py-2">{canCfg ? (
                  <select className="rounded border px-2 py-1" value={c.duration_override_min ?? ''}
                    onChange={e => patch(c, { duration_override_min: e.target.value ? +e.target.value : null })}>
                    <option value="">{durLabel(c.detected_min)} (de EVO)</option>
                    {[45, 60, 90, 120, 150, 180].filter(m => m !== c.detected_min).map(m => <option key={m} value={m}>{durLabel(m)} (excepción)</option>)}
                  </select>) : <>{durLabel(c.duration_min)}{c.duration_override_min ? ' (excepción)' : ''}</>}</td>
                <td className="px-3 py-2"><input type="checkbox" disabled={!canCfg} checked={c.is_active} onChange={e => patch(c, { is_active: e.target.checked })} /></td>
              </tr>);
          })}
            {!classes.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Las clases se crean solas al importar de EVO.</td></tr>}
          </tbody>
        </table>
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <p className="text-xs text-slate-500">La duración se toma del horario de EVO (inicio a fin). Si una clase dura distinto en la realidad, ponle una excepción; al volver a importar se respeta.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Importar
function EvoImport({ onDone }: { onDone: () => void }) {
  const { companies, companyId } = useAuth();
  const [rep, setRep] = useState<EvoReport | null>(null); const [file, setFile] = useState('');
  const [co, setCo] = useState(companyId !== 'all' ? companyId : ''); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ id: string; company_id: string; month: string; file_name: string; students: number; classes: number; created_at: string }[]>([]);
  useEffect(() => { supabase.from('evo_imports').select('*').order('created_at', { ascending: false }).limit(20).then(r => setHistory(r.data ?? [])); }, [busy]);

  async function read(f: File) {
    setMsg(null); setRep(null); setFile(f.name);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await f.arrayBuffer());
      const merged: EvoReport = { month: 0, year: 0, classes: [], warnings: [] };
      for (const name of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: null });
        const r = parseEvoSheet(rows);
        if (r.month) { merged.month = r.month; merged.year = r.year; }
        merged.classes.push(...r.classes); merged.warnings.push(...r.warnings.filter(w => !r.classes.length || !w.startsWith('No se encontró el mes')));
      }
      if (!merged.classes.length) return setMsg('No encontré alumnas en el archivo. Debe ser el reporte de EVO "Asistencia Mensual por Instructor".');
      setRep(merged);
    } catch (e) { setMsg(`No se pudo leer el archivo: ${(e as Error).message}`); }
  }
  async function save() {
    if (!rep || !co) return; setBusy(true); setMsg(null);
    const rows = rep.classes.flatMap(c => c.students.map(s => ({ evo_id: s.evoId, name: s.name, phone: s.phone, birth: s.birth, enrolled: s.enrolled,
      activity: c.activity, start: c.start, end: c.end, weekdays: s.weekdays })));
    const month = `${rep.year}-${String(rep.month).padStart(2, '0')}-01`;
    const { error } = await supabase.rpc('import_evo', { p_company: co, p_month: month, p_file: file, p_rows: rows });
    setBusy(false); if (error) return setMsg(error.message);
    setRep(null); onDone();
  }
  const n = rep?.classes.reduce((a, c) => a + c.students.length, 0) ?? 0;
  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-xl bg-white p-4 shadow-sm">
        <p className="text-sm text-slate-600">En EVO: <b>Actividades → Lista de asistencia mensual</b> y exporta a Excel. Puedes subir uno por clase o uno con varias; las alumnas se reconocen por su ID de EVO y no se duplican. Al volver a subir el mismo mes, esa clase se reemplaza con lo nuevo.</p>
        <input type="file" accept=".xls,.xlsx,.csv" onChange={e => e.target.files?.[0] && read(e.target.files[0])} />
      </div>
      {rep && (
        <div className="space-y-3 rounded-xl bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-end gap-3">
            <p className="text-sm"><b>{n} alumnas</b> en {rep.classes.length} clase(s) · mes {String(rep.month).padStart(2, '0')}/{rep.year}</p>
            <label className="text-xs">Sucursal<select className={`${field} block`} value={co} onChange={e => setCo(e.target.value)}>
              <option value="">Elige…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</select></label>
            <button disabled={!co || busy} className="rounded-lg bg-brand px-4 py-2 text-sm text-white disabled:opacity-50" onClick={save}>{busy ? 'Importando…' : 'Importar'}</button>
          </div>
          {rep.classes.map(c => (
            <details key={c.activity + c.start} open={rep.classes.length === 1}>
              <summary className="cursor-pointer text-sm font-medium">{c.activity} · {c.start}–{c.end} · {c.students.length} alumnas</summary>
              <table className="mt-2 w-full text-sm"><tbody>{c.students.map(s => (
                <tr key={s.evoId} className="border-t"><td className="py-1">{s.name}</td><td className="text-slate-500">ID {s.evoId}</td>
                  <td>{s.weekdays.map(w => WD[w]).join(', ')}</td><td className="text-slate-500">{s.birth ? age(s.birth) : ''}</td></tr>))}</tbody></table>
            </details>))}
          {rep.warnings.length > 0 && <ul className="list-disc pl-5 text-sm text-amber-700">{rep.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        </div>)}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {history.length > 0 && (
        <div className="rounded-xl bg-white p-4 text-sm shadow-sm"><h4 className="mb-2 font-semibold">Importaciones recientes</h4>
          {history.map(h => <p key={h.id} className="text-slate-600">{new Date(h.created_at).toLocaleString('es-MX')} · {companies.find(c => c.id === h.company_id)?.trade_name} · mes {h.month.slice(0, 7)} · {h.students} alumnas, {h.classes} clase(s) · {h.file_name}</p>)}
        </div>)}
    </div>
  );
}

// ---------------------------------------------------------------- Ficha
function StudentCard({ s, classes, enr, canNotes, canCfg, onClose, onChanged }:
  { s: Stu; classes: Cls[]; enr: Enr[]; canNotes: boolean; canCfg: boolean; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const [month, setMonth] = useState(todayMx().slice(0, 7));
  const [att, setAtt] = useState<Att[]>([]); const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState(''); const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const end = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
    const [a, n] = await Promise.all([
      supabase.from('student_attendance_latest').select('*').eq('student_id', s.id).gte('date', month + '-01').lte('date', end).order('date'),
      supabase.from('student_notes').select('*').eq('student_id', s.id).order('created_at', { ascending: false })]);
    setAtt(((a.data as Att[]) ?? []).filter(x => !x.annulled)); setNotes((n.data as Note[]) ?? []);
  }, [s.id, month]);
  useEffect(() => { load(); }, [load]);

  const mine = classes.flatMap(c => rosterFor(enr, c.id, month + '-01').filter(e => e.student_id === s.id).map(e => ({ ...e, c })));
  // Días que le tocaban en el mes (hasta hoy) vs. lo registrado
  const today = todayMx(); const daysInMonth = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  const expected = mine.flatMap(e => Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
    .filter(d => d <= today && e.weekdays.includes(dow(d))).map(d => ({ d, c: e.c })));
  const came = att.filter(a => a.arrival).length, missed = att.filter(a => !a.arrival).length, extra = att.filter(a => a.extra && a.arrival).length;
  const unmarked = expected.filter(x => !att.some(a => a.date === x.d && a.class_id === x.c.id)).length;

  async function addNote() {
    setMsg(null);
    const { error } = await supabase.from('student_notes').insert({ company_id: s.company_id, student_id: s.id, body: body.trim() });
    if (error) return setMsg(error.message); setBody(''); load();
  }
  async function delNote(n: Note) {
    if (!confirm('¿Borrar esta nota? Dirección la seguirá viendo.')) return;
    const { error } = await supabase.from('student_notes').update({ deleted_at: new Date().toISOString() }).eq('id', n.id);
    if (error) setMsg(error.message); else load();
  }
  async function toggleActive() {
    const { error } = await supabase.from('students').update({ is_active: !s.is_active }).eq('id', s.id);
    if (error) setMsg(error.message); else { onChanged(); onClose(); }
  }

  return (
    <Modal title={s.full_name} onClose={onClose} wide>
      <div className="grid gap-2 text-sm sm:grid-cols-4">
        <p><span className="text-slate-500">Edad:</span> {age(s.birth_date)}</p>
        <p><span className="text-slate-500">Teléfono:</span> {s.phone ?? '—'}</p>
        <p><span className="text-slate-500">Inscripción:</span> {s.enrolled_on ?? '—'}</p>
        <p><span className="text-slate-500">ID EVO:</span> {s.evo_id ?? '—'}</p>
      </div>
      <div className="text-sm">{mine.length ? mine.map(e => <span key={e.class_id} className="mr-2 rounded-full bg-slate-100 px-2 py-1">{e.c.activity} {e.c.start_time} · {e.weekdays.map(w => WD[w]).join(', ')}</span>)
        : <span className="text-slate-400">Sin clases ese mes</span>}</div>

      <StudentPlans s={s} onChanged={onChanged} />

      <div className="space-y-2 border-t pt-3">
        <div className="flex flex-wrap items-center gap-3"><h4 className="text-sm font-semibold">Asistencia</h4>
          <input type="month" className="rounded border px-2 py-1 text-sm" value={month} onChange={e => setMonth(e.target.value)} />
          <span className="text-sm"><span className="text-green-700">{came} vino</span> · <span className="text-red-700">{missed} faltó</span>
            {extra > 0 && <> · <span className="text-amber-700">{extra} en día que no le tocaba</span></>} · {unmarked} sin registro · le tocaban {expected.length}</span></div>
        <div className="flex flex-wrap gap-1 text-xs">{att.map(a => (
          <span key={a.date + a.class_id} className={`rounded px-2 py-1 ${a.arrival ? (a.extra ? 'bg-amber-100' : 'bg-green-100') : 'bg-red-100'}`}>
            {a.date.slice(8)} {WD[dow(a.date)]} {a.arrival ?? 'faltó'}</span>))}</div>
      </div>

      {(canNotes || notes.length > 0) && (
        <div className="space-y-2 border-t pt-3">
          <h4 className="text-sm font-semibold">Notas internas <span className="font-normal text-slate-500">(sólo maestros y dirección)</span></h4>
          {canNotes && <div className="flex gap-2"><textarea className={`${field} flex-1`} rows={2} value={body} onChange={e => setBody(e.target.value)} placeholder="Qué observaste, en qué va, qué trabajar…" />
            <button disabled={!body.trim()} className="self-end rounded-lg bg-brand px-3 py-2 text-sm text-white disabled:opacity-50" onClick={addNote}>Guardar</button></div>}
          {notes.map(n => (
            <div key={n.id} className={`rounded-lg border p-2 text-sm ${n.deleted_at ? 'border-dashed bg-slate-50 text-slate-400' : ''}`}>
              <p className="whitespace-pre-wrap">{n.body}</p>
              <p className="mt-1 flex text-xs text-slate-500">{n.author_name ?? '—'} · {new Date(n.created_at).toLocaleString('es-MX')}
                {n.deleted_at && <span className="ml-2">· borrada {new Date(n.deleted_at).toLocaleDateString('es-MX')}</span>}
                {!n.deleted_at && (n.created_by === user?.id || user?.role === 'director') && <button className="ml-auto text-red-600" onClick={() => delNote(n)}>Borrar</button>}</p>
            </div>))}
        </div>)}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {canCfg && <div className="border-t pt-3 text-right"><button className="text-sm text-slate-600" onClick={toggleActive}>{s.is_active ? 'Marcar como inactiva' : 'Reactivar'}</button></div>}
    </Modal>
  );
}
