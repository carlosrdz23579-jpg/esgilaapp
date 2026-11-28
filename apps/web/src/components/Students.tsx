import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { usePersisted } from '../lib/usePersisted';
import { Modal } from './ui';
import { parseEvoSheet, type EvoReport } from '@domain/evo';
import StudentPlans from './StudentPlans';
import StudentProfile, { Photo, uploadPhoto, GENDERS, SOURCES, type StuFull } from './StudentProfile';
import StudentAccount, { studentBalance, type Balance } from './StudentAccount';
import { goTo } from '../lib/nav';
import { formatMXN } from '../lib/money';
import { monthName, computeOwed } from '../lib/owed';
import { useGroupLoads, loadLabel, dayFull } from '../lib/groupLoad';
import { ModuleTabs } from './ui';

interface Cls { id: string; company_id: string; activity: string; start_time: string; end_time: string; duration_override_min: number | null;
  detected_min: number; duration_min: number; is_active: boolean }
type Stu = StuFull;
interface Trial { student_id: string; class_id: string | null; date: string; attended: boolean | null; id: string }
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
  const settings: [string, string][] = [['clases', 'Clases y duración'], ...(canCfg ? [['importar', 'Importar de EVO'] as [string, string]] : [])];
  const tabs = [canList && ['lista', 'Pase de lista'], ['semana', 'Asistencia semanal'], ['alumnas', 'Alumnas'], ...settings]
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
      <ModuleTabs id="alumnas" tabs={tabs.filter(t => !settings.some(x => x[0] === t[0]))} settings={settings} value={current} onChange={setTab} />
      {error && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {current === 'lista' && <RollCall classes={classes} students={students} enr={enr} onOpen={setOpen} />}
      {current === 'semana' && <WeekView classes={classes} students={students} enr={enr} onOpen={setOpen} />}
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
  const [trials, setTrials] = useState<Trial[]>([]);
  useEffect(() => { supabase.from('trial_classes').select('id,student_id,class_id,date,attended').eq('date', date).is('cancelled_at', null).then(r => setTrials((r.data as Trial[]) ?? [])); }, [date]);
  const [times, setTimes] = useState<Record<string, string>>({}); const [adding, setAdding] = useState(''); const [busy, setBusy] = useState(false);
  const [addTime, setAddTime] = useState('');
  const wd = dow(date);
  // Clases con alumnas ese día de la semana, la más cercana a la hora actual primero.
  const dayClasses = useMemo(() => classes.filter(c => c.is_active && (rosterFor(enr, c.id, date).some(e => e.weekdays.includes(wd)) || trials.some(t => t.class_id === c.id))), [classes, enr, date, wd, trials]);
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
  const trialIds = cls ? trials.filter(t => t.class_id === cls.id).map(t => t.student_id) : [];
  const due = [...new Set([...roster.filter(e => e.weekdays.includes(wd)).map(e => e.student_id), ...trialIds])];
  const extras = att.filter(a => !a.annulled && !due.includes(a.student_id)).map(a => a.student_id);
  const list = [...due, ...extras].map(id => sById.get(id)).filter(Boolean).sort((a, b) => a!.full_name.localeCompare(b!.full_name)) as Stu[];
  const rec = (id: string) => att.find(a => a.student_id === id && !a.annulled);
  const defTime = date === todayMx() ? nowMx() : (cls?.start_time ?? '00:00');

  async function mark(ids: string[], arrival: (id: string) => string | null, annulled = false) {
    if (!cls || !ids.length) return; setBusy(true); setMsg(null);
    const { error } = await supabase.from('student_attendance').insert(ids.map(id => ({
      company_id: cls.company_id, student_id: id, class_id: cls.id, date, arrival: annulled ? null : arrival(id),
      extra: !due.includes(id) || trialIds.includes(id), annulled })));
    for (const id of ids) { const t = trials.find(x => x.student_id === id && x.class_id === cls.id); if (t && !annulled) await supabase.from('trial_classes').update({ attended: !!arrival(id) }).eq('id', t.id); }
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
                      {trialIds.includes(s.id) ? <span className="ml-2 rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700">clase muestra</span>
                        : !due.includes(s.id) && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">no le tocaba</span>}</td>
                    <td className="px-3 py-2"><input type="time" className="rounded border px-2 py-1" value={t} onChange={e => setTimes({ ...times, [s.id]: e.target.value })} /></td>
                    <td className="px-3 py-2">{!r ? <span className="text-slate-400">sin marcar</span> : r.arrival
                      ? <span className="text-green-700">✓ llegó {r.arrival}{r.arrival > cls.start_time ? <span className="ml-1 text-amber-700">(tarde)</span> : null}
                          {(() => { const reg = new Date(r.created_at).toLocaleTimeString('en-GB', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit' });
                            return reg !== r.arrival ? <span className="block text-[11px] text-slate-400">registrado {date === todayMx() ? '' : `${new Date(r.created_at).toLocaleDateString('es-MX')} `}a las {reg}</span> : null; })()}</span>
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
          {adding && <><label className="flex items-center gap-1 text-sm">llegó a las<input type="time" className="rounded border px-2 py-1.5" value={addTime || defTime} onChange={e => setAddTime(e.target.value)} /></label>
            <button disabled={busy} className="rounded-lg bg-brand px-3 py-2 text-sm text-white" onClick={() => { const t = addTime || defTime; mark([adding], () => t); setAdding(''); setAddTime(''); }}>Agregar</button></>}
        </div>)}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <p className="text-xs text-slate-500">La hora sale con la hora actual de México; cámbiala antes de marcar si llegó a otra hora. Si te equivocas, vuelve a marcar: queda la última.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Asistencia semanal
const mondayOf = (iso: string) => { const d = new Date(iso + 'T12:00:00Z'); const k = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - k); return d.toISOString().slice(0, 10); };
const plusDays = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function WeekView({ classes, students, enr, onOpen }: { classes: Cls[]; students: Stu[]; enr: Enr[]; onOpen: (s: Stu) => void }) {
  const [mon, setMon] = useState(mondayOf(todayMx())); const [fClass, setFClass] = usePersisted('alumnas.semana.clase', '');
  const [mode, setMode] = usePersisted<'clases' | 'faltas'>('alumnas.semana.modo', 'faltas');
  const [att, setAtt] = useState<Att[]>([]); const [trials, setTrials] = useState<Trial[]>([]);
  const days = Array.from({ length: 6 }, (_, i) => plusDays(mon, i));
  useEffect(() => {
    Promise.all([supabase.from('student_attendance_latest').select('*').gte('date', days[0]).lte('date', days[5]),
      supabase.from('trial_classes').select('id,student_id,class_id,date,attended').gte('date', days[0]).lte('date', days[5]).is('cancelled_at', null)])
      .then(([a, t]) => { setAtt(((a.data as Att[]) ?? []).filter(x => !x.annulled)); setTrials((t.data as Trial[]) ?? []); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mon]);
  const sById = new Map(students.map(x => [x.id, x]));
  const shown = classes.filter(c => c.is_active && (!fClass || c.id === fClass)).map(c => {
    const due = (d: string) => new Set([...rosterFor(enr, c.id, d).filter(e => e.weekdays.includes(dow(d))).map(e => e.student_id), ...trials.filter(t => t.class_id === c.id && t.date === d).map(t => t.student_id)]);
    const ids = new Set<string>(); days.forEach(d => { due(d).forEach(x => ids.add(x)); att.filter(a => a.class_id === c.id && a.date === d).forEach(a => ids.add(a.student_id)); });
    return { c, due, list: [...ids].map(id => sById.get(id)).filter(Boolean).sort((a, b) => a!.full_name.localeCompare(b!.full_name)) as Stu[] };
  }).filter(x => x.list.length);
  const today = todayMx();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className="rounded border bg-white px-2 py-1" onClick={() => setMon(plusDays(mon, -7))}>‹</button>
        <b className="w-56 text-center">Semana del {new Date(mon + 'T12:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })} al {new Date(days[5] + 'T12:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}</b>
        <button className="rounded border bg-white px-2 py-1" onClick={() => setMon(plusDays(mon, 7))}>›</button>
        <button className="text-sm text-brand" onClick={() => setMon(mondayOf(today))}>Esta semana</button>
        <select className={field} value={fClass} onChange={e => setFClass(e.target.value)}><option value="">Todas las clases</option>
          {classes.filter(c => c.is_active).map(c => <option key={c.id} value={c.id}>{c.activity} · {c.start_time}</option>)}</select>
        <div className="inline-flex overflow-hidden rounded-lg border bg-white text-sm">{([['faltas', 'Reporte de faltas'], ['clases', 'Por clase']] as const).map(([k, l]) =>
          <button key={k} onClick={() => setMode(k)} className={`px-3 py-2 ${mode === k ? 'bg-brand text-white' : ''}`}>{l}</button>)}</div>
        <button className="ml-auto rounded-lg border bg-white px-3 py-2 text-sm print:hidden" onClick={() => window.print()}>Imprimir</button>
      </div>
      {mode === 'faltas' && <AbsenceReport mon={mon} days={days} shown={shown} att={att} />}
      {mode === 'clases' && shown.map(({ c, due, list }) => (
        <div key={c.id} className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2 text-left text-sm text-slate-800">{c.activity} · {c.start_time}–{c.end_time}</th>
              {days.map(d => <th key={d} className={`px-2 py-2 ${d === today ? 'text-brand' : ''}`}>{WD[dow(d)]} {+d.slice(8)}</th>)}<th className="px-2 py-2">Vino</th></tr></thead>
            <tbody>{list.map(s => { let came = 0, exp = 0; return (
              <tr key={s.id} className="border-t">
                <td className="px-3 py-1.5"><button className="text-left hover:text-brand" onClick={() => onOpen(s)}>{s.full_name}</button>
                  {s.kind === 'prospecto' && <span className="ml-1 text-[10px] text-purple-700">muestra</span>}</td>
                {days.map(d => { const a = att.find(x => x.student_id === s.id && x.class_id === c.id && x.date === d); const toca = due(d).has(s.id);
                  if (toca) exp++; if (a?.arrival) came++;
                  return <td key={d} className="px-2 py-1.5 text-center text-xs">{a ? (a.arrival ? <span className={`rounded px-1 ${toca ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`} title={toca ? '' : 'no le tocaba'}>✓ {a.arrival}</span>
                    : <span className="rounded bg-red-100 px-1 text-red-700">✗</span>) : toca ? <span className="text-slate-300" title={d > today ? 'le toca' : 'sin marcar'}>{d > today ? '○' : '·'}</span> : ''}</td>; })}
                <td className="px-2 py-1.5 text-center text-xs">{came}/{exp}</td>
              </tr>); })}
              <tr className="border-t bg-slate-50 text-xs"><td className="px-3 py-1">Llegaron / les tocaba</td>{days.map(d => { const ds = due(d);
                return <td key={d} className="px-2 py-1 text-center">{att.filter(a => a.class_id === c.id && a.date === d && a.arrival).length}/{ds.size}</td>; })}<td /></tr>
            </tbody>
          </table>
        </div>))}
      {!shown.length && <p className="rounded-xl border border-dashed bg-white p-4 text-sm text-slate-500">No hay clases con alumnas esa semana.</p>}
      {mode === 'clases' && <p className="text-xs text-slate-500">✓ verde: vino · ✓ ámbar: vino un día que no le tocaba · ✗: faltó · punto gris: le tocaba y no se marcó · círculo: le toca (día que aún no llega).</p>}
    </div>
  );
}

/** Quién faltó en la semana (sólo días que ya pasaron), con su teléfono y mensaje de WhatsApp listo. */
function AbsenceReport({ mon, days, shown, att }: { mon: string; days: string[]; shown: { c: Cls; due: (d: string) => Set<string>; list: Stu[] }[]; att: Att[] }) {
  const today = todayMx();
  const [filter, setFilter] = usePersisted<'ninguna' | 'alguna' | 'todas'>('alumnas.faltas.filtro', 'alguna');
  const [tpl, setTpl] = usePersisted('alumnas.faltas.mensaje', 'Hola {tutor}, te saludamos de ESGILA. Esta semana extrañamos a {alumna} en su clase de {clase} ({dias}). ¿Todo bien? Aquí la esperamos 🤸');
  const [editTpl, setEditTpl] = useState(false);
  const [contacts, setContacts] = useState<{ student_id: string; author_name: string | null; created_at: string }[]>([]);
  const loadC = useCallback(async () => {
    const r = await supabase.from('absence_contacts').select('student_id,author_name,created_at').eq('week_start', mon); setContacts(r.data ?? []);
  }, [mon]);
  useEffect(() => { loadC(); }, [loadC]);
  // juntar por alumna todas sus clases de la semana
  const byStudent = new Map<string, { s: Stu; expected: number; came: number; missed: { d: string; c: Cls }[]; classes: Set<string> }>();
  for (const { c, due, list } of shown) for (const st of list) for (const d of days) {
    if (d > today) continue;
    const toca = due(d).has(st.id); if (!toca) continue;
    const a = att.find(x => x.student_id === st.id && x.class_id === c.id && x.date === d);
    const e = byStudent.get(st.id) ?? { s: st, expected: 0, came: 0, missed: [], classes: new Set<string>() };
    e.expected++; e.classes.add(c.activity); if (a?.arrival) e.came++; else e.missed.push({ d, c });
    byStudent.set(st.id, e);
  }
  const rows = [...byStudent.values()].filter(r => filter === 'todas' || (filter === 'ninguna' ? r.came === 0 : r.missed.length > 0))
    .sort((a, b) => a.came / a.expected - b.came / b.expected || a.s.full_name.localeCompare(b.s.full_name));
  const phoneOf = (s: Stu) => { const d = (s.guardian_phone || s.phone || '').replace(/\D/g, ''); return d.length === 10 ? `52${d}` : d.length >= 12 ? d : ''; };
  const msgOf = (r: (typeof rows)[number]) => tpl.replace('{tutor}', r.s.guardian_name?.split(' ')[0] || '').replace('{alumna}', r.s.nickname || r.s.full_name.split(' ')[0])
    .replace('{clase}', [...r.classes].join(' y ')).replace('{dias}', r.missed.map(m => `${WD[dow(m.d)].toLowerCase()} ${+m.d.slice(8)}`).join(', ')).replace(/\s+,/g, ',').replace('Hola ,', 'Hola,');
  async function markSent(s: Stu) {
    await supabase.from('absence_contacts').insert({ company_id: s.company_id, student_id: s.id, week_start: mon }); loadC();
  }
  const sent = (id: string) => contacts.find(c => c.student_id === id);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div className="inline-flex overflow-hidden rounded-lg border bg-white">{([['alguna', 'Faltaron al menos una vez'], ['ninguna', 'No vinieron en toda la semana'], ['todas', 'Todas']] as const).map(([k, l]) =>
          <button key={k} onClick={() => setFilter(k)} className={`px-3 py-1.5 ${filter === k ? 'bg-slate-800 text-white' : ''}`}>{l}</button>)}</div>
        <span className="text-slate-500">{rows.length} alumnas · {rows.filter(r => sent(r.s.id)).length} ya avisadas</span>
        <button className="ml-auto text-brand print:hidden" onClick={() => setEditTpl(!editTpl)}>{editTpl ? 'Listo' : 'Editar mensaje'}</button>
      </div>
      {editTpl && <div className="rounded-xl bg-white p-3 text-xs shadow-sm"><textarea rows={3} className={`${field} w-full`} value={tpl} onChange={e => setTpl(e.target.value)} />
        <p className="mt-1 text-slate-500">Se reemplazan solos: {'{tutor}'} (nombre de mamá/papá), {'{alumna}'}, {'{clase}'} y {'{dias}'} (los días que faltó).</p></div>}
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Alumna</th><th className="px-3 py-2">Vino</th><th className="px-3 py-2">Faltó</th>
            <th className="px-3 py-2">Tutor / teléfono</th><th className="px-3 py-2 print:hidden"></th></tr></thead>
          <tbody>{rows.map(r => { const ph = phoneOf(r.s); const done = sent(r.s.id); return (
            <tr key={r.s.id} className={`border-t align-top ${done ? 'bg-green-50/50' : ''}`}>
              <td className="px-3 py-2 font-medium">{r.s.full_name}<span className="block text-xs font-normal text-slate-500">{[...r.classes].join(', ')}</span></td>
              <td className={`px-3 py-2 ${r.came === 0 ? 'font-semibold text-red-700' : ''}`}>{r.came} de {r.expected}</td>
              <td className="px-3 py-2 text-xs">{r.missed.map(m => `${WD[dow(m.d)]} ${+m.d.slice(8)}`).join(', ') || '—'}</td>
              <td className="px-3 py-2 text-xs">{r.s.guardian_name ?? '—'}<span className="block">{r.s.guardian_phone || r.s.phone || <span className="text-red-600">sin teléfono</span>}</span></td>
              <td className="space-y-1 whitespace-nowrap px-3 py-2 text-right text-xs print:hidden">
                {ph && r.missed.length > 0 && <a className="inline-block rounded-lg bg-green-600 px-3 py-1 text-white" href={`https://wa.me/${ph}?text=${encodeURIComponent(msgOf(r))}`} target="_blank" rel="noreferrer"
                  onClick={() => !done && markSent(r.s)}>WhatsApp</a>}
                {done ? <span className="block text-green-700">✓ avisada · {done.author_name} {new Date(done.created_at).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' })}</span>
                  : r.missed.length > 0 && <button className="block w-full text-right text-slate-500" onClick={() => markSent(r.s)}>Marcar avisada</button>}
              </td>
            </tr>); })}
            {!rows.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-green-700">Nadie en esta vista. 🎉</td></tr>}</tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">Cuenta sólo los días que ya pasaron y en los que le tocaba clase. El botón WhatsApp abre el chat con el mensaje listo (usa el teléfono del tutor, o el de la alumna si no hay) y la marca como avisada.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Lista de alumnas
function NewStudent({ onCreated }: { onCreated: (s: Stu) => void }) {
  const { companies, companyId } = useAuth();
  const [f, setF] = useState({ company_id: companyId !== 'all' ? companyId : '', full_name: '', birth_date: '', phone: '', enrolled_on: todayMx(),
    email: '', gender: '', curp: '', guardian_name: '', guardian_phone: '', source: '', notes: '' });
  const [kind, setKind] = useState<'alumna' | 'prospecto'>('alumna'); const [photo, setPhoto] = useState<File | null>(null);
  const [trialDate, setTrialDate] = useState(todayMx());
  const [disc, setDisc] = useState(''); const [planId, setPlanId] = useState(''); const [classId, setClassId] = useState(''); const [days, setDays] = useState<number[]>([]);
  const [plans, setPlans] = useState<{ id: string; discipline: string; name: string; price_cents: number | null; kind: string }[]>([]);
  const [groups, setGroups] = useState<{ id: string; activity: string; start_time: string; end_time: string; capacity: number | null; discipline: string | null }[]>([]);
  const [combos, setCombos] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!f.company_id) return;
    Promise.all([
      supabase.from('plans_v').select('id,discipline,name,price_cents,kind').eq('company_id', f.company_id).eq('is_active', true).order('discipline').order('hours_per_week'),
      supabase.from('class_groups').select('id,activity,start_time,end_time,capacity,discipline').eq('company_id', f.company_id).eq('is_active', true).order('activity').order('start_time'),
      supabase.from('discipline_rules').select('discipline').eq('company_id', f.company_id).eq('is_combo', true)]).then(([p, g, r]) => {
      setPlans(p.data ?? []); setGroups(g.data ?? []); setCombos((r.data ?? []).map(x => x.discipline));
    });
  }, [f.company_id]);
  const loads = useGroupLoads(groups.map(g => g.id), (f.enrolled_on || todayMx()).slice(0, 7));
  const selG = groups.find(g => g.id === classId);
  const discs = [...new Set(plans.filter(p => p.kind !== 'familiar' && !combos.includes(p.discipline)).map(p => p.discipline))];
  const gList = groups.filter(g => !disc || !groups.some(x => x.discipline === disc) || g.discipline === disc);
  const DAYS: [number, string][] = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb']];

  async function save(ev: React.FormEvent) {
    ev.preventDefault(); setMsg(null);
    if (kind === 'alumna' && (!planId || !classId || !days.length)) return setMsg('Elige plan, grupo y los días que viene.');
    if (kind === 'prospecto' && !classId) return setMsg('Elige el grupo de su clase muestra.');
    setBusy(true);
    const { data, error } = await supabase.from('students').insert({ company_id: f.company_id, full_name: f.full_name.trim().replace(/\s+/g, ' '),
      birth_date: f.birth_date || null, phone: f.phone.trim() || null, enrolled_on: kind === 'alumna' ? f.enrolled_on || null : null, kind,
      email: f.email.trim() || null, gender: f.gender || null, curp: f.curp.trim().toUpperCase() || null, guardian_name: f.guardian_name.trim() || null,
      guardian_phone: f.guardian_phone.trim() || null, source: f.source || null, notes: f.notes.trim() || null }).select('*').single();
    if (error) { setBusy(false); return setMsg(`No se pudo dar de alta: ${error.message.includes('email') ? 'el correo no es válido' : error.message.includes('curp') ? 'la CURP debe tener 18 caracteres' : error.message}`); }
    const st = data as Stu;
    if (photo) { const e = await uploadPhoto(st, photo); if (e) setMsg(`Se dio de alta, pero no se subió la foto: ${e}`); }
    if (kind === 'prospecto') {
      const t = await supabase.from('trial_classes').insert({ company_id: f.company_id, student_id: st.id, class_id: classId, date: trialDate });
      setBusy(false); if (t.error) setMsg(`Se dio de alta, pero no se agendó la clase muestra: ${t.error.message}`);
      return onCreated(st);
    }
    const sub = await supabase.from('subscriptions').insert({ company_id: f.company_id, plan_id: planId, student_id: st.id,
      start_month: `${(f.enrolled_on || todayMx()).slice(0, 7)}-01` }).select('id').single();
    if (sub.error) { setBusy(false); setMsg(`Se dio de alta, pero no se asignó el plan: ${sub.error.message}`); return onCreated(st); }
    const m = await supabase.from('subscription_members').insert({ subscription_id: sub.data.id, student_id: st.id, class_id: classId, weekdays: days });
    setBusy(false);
    if (m.error) { await supabase.from('subscriptions').update({ cancelled_at: new Date().toISOString() }).eq('id', sub.data.id); setMsg(`Se dio de alta, pero no se asignó el grupo: ${m.error.message}`); }
    onCreated(st);
  }
  return (
    <form onSubmit={save} className="space-y-3 rounded-xl border-2 border-brand/30 bg-white p-4 text-sm shadow-sm">
      <div className="inline-flex overflow-hidden rounded-lg border">{(['alumna', 'prospecto'] as const).map(k =>
        <button type="button" key={k} onClick={() => setKind(k)} className={`px-3 py-1.5 ${kind === k ? 'bg-brand text-white' : ''}`}>{k === 'alumna' ? 'Alumna inscrita' : 'Prospecto (clase muestra)'}</button>)}</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">Sucursal<select required className={`${field} block`} value={f.company_id} onChange={e => { setF({ ...f, company_id: e.target.value }); setDisc(''); setPlanId(''); setClassId(''); }}>
          <option value="">Elige…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</select></label>
        <label className="text-xs">Nombre completo<input required autoFocus className={`${field} block w-64`} value={f.full_name} onChange={e => setF({ ...f, full_name: e.target.value })} /></label>
        <label className="text-xs">Nacimiento<input type="date" className={`${field} block`} value={f.birth_date} onChange={e => setF({ ...f, birth_date: e.target.value })} /></label>
        <label className="text-xs">Teléfono<input className={`${field} block w-36`} value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></label>
        {kind === 'alumna' && <label className="text-xs">Inscripción<input type="date" className={`${field} block`} value={f.enrolled_on} onChange={e => setF({ ...f, enrolled_on: e.target.value })} /></label>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">Correo<input type="email" className={`${field} block w-56`} value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></label>
        <label className="text-xs">Género<select className={`${field} block`} value={f.gender} onChange={e => setF({ ...f, gender: e.target.value })}>
          <option value="">—</option>{GENDERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="text-xs">CURP<input maxLength={18} className={`${field} block w-48 uppercase`} value={f.curp} onChange={e => setF({ ...f, curp: e.target.value })} /></label>
        <label className="text-xs">Mamá/papá o tutor<input className={`${field} block w-48`} value={f.guardian_name} onChange={e => setF({ ...f, guardian_name: e.target.value })} /></label>
        <label className="text-xs">Teléfono del tutor<input className={`${field} block w-36`} value={f.guardian_phone} onChange={e => setF({ ...f, guardian_phone: e.target.value })} /></label>
        <label className="text-xs">Cómo nos conoció<select className={`${field} block`} value={f.source} onChange={e => setF({ ...f, source: e.target.value })}>
          <option value="">—</option>{SOURCES.map(x => <option key={x}>{x}</option>)}</select></label>
        <label className="text-xs">Foto<input type="file" accept="image/*" capture="environment" className="block text-xs" onChange={e => setPhoto(e.target.files?.[0] ?? null)} /></label>
      </div>
      <label className="block text-xs">Observaciones<textarea rows={2} className={`${field} block w-full`} value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">Disciplina<select required className={`${field} block`} value={disc} onChange={e => { setDisc(e.target.value); setPlanId(''); setClassId(''); }}>
          <option value="">Elige…</option>{discs.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
        {kind === 'alumna' && <label className="text-xs">Plan<select required disabled={!disc} className={`${field} block`} value={planId} onChange={e => setPlanId(e.target.value)}>
          <option value="">Elige…</option>{plans.filter(p => p.discipline === disc && p.kind !== 'familiar').map(p =>
            <option key={p.id} value={p.id}>{p.name} · {p.price_cents != null ? `$${(p.price_cents / 100).toLocaleString('es-MX')}` : 'sin precio'}</option>)}</select></label>}
        <label className="text-xs">Grupo<select required disabled={!disc} className={`${field} block`} value={classId} onChange={e => setClassId(e.target.value)}>
          <option value="">Elige…</option>{gList.map(g => <option key={g.id} value={g.id}>{g.activity} {g.start_time}–{g.end_time}{g.capacity ? ` · cupo ${g.capacity} por día` : ''}</option>)}</select></label>
        {kind === 'prospecto' && <label className="text-xs">Fecha de la clase muestra<input type="date" className={`${field} block`} value={trialDate} onChange={e => setTrialDate(e.target.value)} /></label>}
        {kind === 'alumna' && <div className="text-xs"><span className="block">Días que viene</span><div className="flex gap-2 py-2">{DAYS.map(([d, l]) => {
          const full = !!selG && dayFull(loads[selG.id], selG.capacity, d) && !days.includes(d);
          return <label key={d} className={`flex items-center gap-1 ${full ? 'text-red-400 line-through' : ''}`} title={full ? 'Lleno ese día' : ''}>
            <input type="checkbox" disabled={full} checked={days.includes(d)} onChange={e => setDays(e.target.checked ? [...days, d].sort() : days.filter(x => x !== d))} />{l}
            {selG?.capacity ? <span className="text-[10px] text-slate-400">{loads[selG.id]?.[d] ?? 0}/{selG.capacity}</span> : null}</label>; })}</div></div>}
      </div>
      {f.company_id && !discs.length && <p className="text-xs text-amber-700">Esta sucursal aún no tiene planes: créalos en Cobranza → Planes por disciplina.</p>}
      <div className="flex items-center gap-3"><button disabled={busy} className="rounded-lg bg-brand px-4 py-2 text-white disabled:opacity-50">{busy ? 'Guardando…' : kind === 'alumna' ? 'Dar de alta' : 'Registrar prospecto'}</button>
        <span className="text-xs text-slate-500">Para doble disciplina o hermanas, termínalo en su ficha (se abre al guardar).</span></div>
      {msg && <p className="rounded bg-red-50 p-2 text-red-700">{msg}</p>}
    </form>
  );
}

type ListKind = 'activas' | 'deudoras' | 'cumplidoras' | 'inactivas' | 'prospectos';
function StudentList({ classes, students, enr, onOpen }: { classes: Cls[]; students: Stu[]; enr: Enr[]; onOpen: (s: Stu) => void }) {
  const { can } = useAuth(); const canAdd = can('students', 'configure') || can('billing', 'edit');
  const canMoney = ['view', 'edit', 'configure'].some(x => can('billing', x)) || ['view', 'edit'].some(x => can('cashbox', x));
  const [adding, setAdding] = useState(false); const [kind, setKind] = usePersisted<ListKind>('alumnas.lista', 'activas');
  const [q, setQ] = useState(''); const [fClass, setFClass] = useState('');
  const [debts, setDebts] = useState<Record<string, number> | null>(null); const [loadingDebts, setLoadingDebts] = useState(false);
  const [plans, setPlans] = useState<Record<string, string>>({});
  const today = todayMx();
  const cur = useMemo(() => classes.flatMap(c => rosterFor(enr, c.id, today).map(e => ({ ...e, c }))), [classes, enr, today]);
  const active = students.filter(s => s.is_active && (s.kind ?? 'alumna') === 'alumna');
  // plan vigente de cada alumna (para "cumplidoras": al corriente y con plan)
  useEffect(() => {
    supabase.from('subscriptions').select('student_id,start_month,end_month,plans(discipline,name)').is('cancelled_at', null).not('student_id', 'is', null).then(r => {
      const ym = today.slice(0, 7); const m: Record<string, string> = {};
      for (const x of (r.data ?? []) as unknown as { student_id: string; start_month: string; end_month: string | null; plans: { discipline: string; name: string } | null }[])
        if (x.start_month.slice(0, 7) <= ym && (!x.end_month || x.end_month.slice(0, 7) >= ym)) m[x.student_id] = x.plans ? `${x.plans.discipline} · ${x.plans.name}` : 'Plan';
      setPlans(m);
    });
  }, [students, today]);
  // adeudos: se calculan al abrir Deudoras o Cumplidoras (con recargos del día)
  useEffect(() => {
    if (!canMoney || debts || !['deudoras', 'cumplidoras'].includes(kind) || !active.length) return;
    setLoadingDebts(true);
    (async () => {
      const out: Record<string, number> = {};
      for (const co of [...new Set(active.map(s => s.company_id))]) {
        const ids = active.filter(s => s.company_id === co).map(s => s.id);
        const r = await computeOwed({ company: co, studentIds: ids });
        for (const it of r.items) out[it.studentId] = (out[it.studentId] ?? 0) + it.amount;
      }
      const b = await supabase.from('sale_balances').select('student_id,balance_cents').gt('balance_cents', 0);
      for (const x of b.data ?? []) if (x.student_id) out[x.student_id] = (out[x.student_id] ?? 0) + Number(x.balance_cents);
      setDebts(out); setLoadingDebts(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, canMoney, students]);
  const owes = (id: string) => (debts?.[id] ?? 0) > 0;
  const base = kind === 'inactivas' ? students.filter(s => !s.is_active && (s.kind ?? 'alumna') === 'alumna')
    : kind === 'prospectos' ? students.filter(s => s.kind === 'prospecto' && s.is_active)
    : kind === 'deudoras' ? active.filter(s => owes(s.id))
    : kind === 'cumplidoras' ? active.filter(s => plans[s.id] && debts && !owes(s.id)) : active;
  const rows = base.filter(s => (!q || s.full_name.toLowerCase().includes(q.toLowerCase()) || s.evo_id === q) && (!fClass || cur.some(e => e.student_id === s.id && e.class_id === fClass)))
    .sort((a, b) => kind === 'deudoras' ? (debts?.[b.id] ?? 0) - (debts?.[a.id] ?? 0) : a.full_name.localeCompare(b.full_name));
  const lists: [ListKind, string, number | null][] = [['activas', 'Activas', active.length],
    ...(canMoney ? [['deudoras', 'Deudoras', debts ? active.filter(s => owes(s.id)).length : null] as [ListKind, string, number | null],
      ['cumplidoras', 'Al corriente', debts ? active.filter(s => plans[s.id] && !owes(s.id)).length : null] as [ListKind, string, number | null]] : []),
    ['inactivas', 'Bajas', students.filter(s => !s.is_active && (s.kind ?? 'alumna') === 'alumna').length], ['prospectos', 'Prospectos', students.filter(s => s.kind === 'prospecto' && s.is_active).length]];
  const total = rows.reduce((n, s) => n + (debts?.[s.id] ?? 0), 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-2xl bg-slate-100 p-1 text-sm">{lists.map(([k, l, n]) =>
          <button key={k} onClick={() => setKind(k)} className={`rounded-xl px-3 py-1.5 ${kind === k ? `bg-white font-semibold shadow-sm ${k === 'deudoras' ? 'text-red-700' : k === 'cumplidoras' ? 'text-green-700' : 'text-brand'}` : 'text-slate-600'}`}>
            {l}{n !== null && <span className="ml-1 text-xs opacity-70">{n}</span>}</button>)}</div>
        {canAdd && !adding && <button className="ml-auto rounded-xl bg-brand px-3 py-2 text-sm font-medium text-white shadow-sm" onClick={() => setAdding(true)}>+ Nueva alumna</button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${field} w-64`} placeholder="Buscar por nombre o ID de EVO" value={q} onChange={e => setQ(e.target.value)} />
        <select className={field} value={fClass} onChange={e => setFClass(e.target.value)}><option value="">Todas las clases</option>
          {classes.map(c => <option key={c.id} value={c.id}>{c.activity} · {c.start_time}</option>)}</select>
        <span className="text-sm text-slate-500">{rows.length} {kind === 'prospectos' ? 'prospectos' : 'alumnas'}{kind === 'deudoras' && debts ? ` · deben ${formatMXN(total)} hoy` : ''}</span>
        {['deudoras', 'cumplidoras'].includes(kind) && <button className="ml-auto text-xs text-brand" onClick={() => setDebts(null)}>Recalcular</button>}
      </div>
      {adding && <NewStudent onCreated={st => { setAdding(false); onOpen(st); }} />}
      {loadingDebts && <p className="text-sm text-slate-400">Calculando adeudos de cada alumna…</p>}
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Nombre</th><th className="px-3 py-2">Edad</th>
            <th className="px-3 py-2">{kind === 'inactivas' ? 'Baja' : 'Plan y clases'}</th><th className="px-3 py-2">Teléfono</th>
            {['deudoras', 'cumplidoras', 'activas'].includes(kind) && debts && <th className="px-3 py-2 text-right">Debe hoy</th>}</tr></thead>
          <tbody>{rows.map(s => (
            <tr key={s.id} className="cursor-pointer border-t hover:bg-slate-50" onClick={() => onOpen(s)}>
              <td className="px-3 py-2 font-medium"><span className="flex items-center gap-2"><Photo path={s.photo_path} size={30} />{s.full_name}</span></td>
              <td className="px-3 py-2">{age(s.birth_date)}</td>
              <td className="px-3 py-2 text-xs">{kind === 'inactivas' ? <span>{s.withdrawn_on ?? '—'}{s.withdrawal_reason ? ` · ${s.withdrawal_reason}` : ''}</span>
                : <>{plans[s.id] && <span className="block font-medium text-slate-700">{plans[s.id]}</span>}
                  {cur.filter(e => e.student_id === s.id).map(e => `${e.c.activity} ${e.c.start_time} (${e.weekdays.map(w => WD[w]).join(', ')})`).join(' · ') || (plans[s.id] ? '' : <span className="text-slate-400">sin plan</span>)}</>}</td>
              <td className="px-3 py-2 text-xs">{s.guardian_phone || s.phone || '—'}</td>
              {['deudoras', 'cumplidoras', 'activas'].includes(kind) && debts && <td className={`px-3 py-2 text-right ${owes(s.id) ? 'font-semibold text-red-700' : 'text-green-700'}`}>{owes(s.id) ? formatMXN(debts[s.id]) : '✓'}</td>}
            </tr>))}
            {!rows.length && !loadingDebts && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">{kind === 'deudoras' ? 'Nadie debe. 🎉' : 'Nadie en esta lista.'}</td></tr>}
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
const REASONS = ['Cambio de domicilio', 'Motivos económicos', 'Horarios', 'Cambió de actividad o deporte', 'Lesión o salud', 'Insatisfacción con el servicio', 'Vacaciones / temporada', 'Sin respuesta (dejó de venir)', 'Otro'];
const daysSince = (iso: string | null | undefined) => iso ? Math.max(0, Math.round((Date.parse(todayMx()) - Date.parse(iso.slice(0, 10))) / 864e5)) : null;

function StudentCard({ s: s0, classes, enr, canNotes, canCfg, onClose, onChanged }:
  { s: Stu; classes: Cls[]; enr: Enr[]; canNotes: boolean; canCfg: boolean; onClose: () => void; onChanged: () => void }) {
  const { user, can } = useAuth();
  const [s, setS] = useState<Stu>(s0);
  const [tab, setTab] = usePersisted('ficha.tab', 'perfil');
  const [month, setMonth] = useState(todayMx().slice(0, 7));
  const [att, setAtt] = useState<Att[]>([]); const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState(''); const [msg, setMsg] = useState<string | null>(null);
  const [bal, setBal] = useState<Balance | null>(null); const [log, setLog] = useState<{ action: string; reason: string | null; note: string | null; author_name: string | null; created_at: string; last_month: string | null }[]>([]);
  const [plan, setPlan] = useState<string>(''); const [withdraw, setWithdraw] = useState(false);
  const canBill = ['view', 'edit', 'configure'].some(x => can('billing', x)) || ['view', 'edit'].some(x => can('cashbox', x));
  const canManage = canCfg || can('billing', 'edit');
  const reloadMe = useCallback(async () => { const r = await supabase.from('students').select('*').eq('id', s0.id).single(); if (r.data) setS(r.data as Stu); }, [s0.id]);
  const load = useCallback(async () => {
    const end = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
    const [a, n, l, sub] = await Promise.all([
      supabase.from('student_attendance_latest').select('*').eq('student_id', s.id).gte('date', month + '-01').lte('date', end).order('date'),
      supabase.from('student_notes').select('*').eq('student_id', s.id).order('created_at', { ascending: false }),
      supabase.from('student_status_log').select('action,reason,note,author_name,created_at,last_month').eq('student_id', s.id).order('created_at', { ascending: false }),
      supabase.from('subscriptions').select('plan_id,start_month,end_month,plans(discipline,name)').eq('student_id', s.id).is('cancelled_at', null).order('start_month', { ascending: false })]);
    setAtt(((a.data as Att[]) ?? []).filter(x => !x.annulled)); setNotes((n.data as Note[]) ?? []); setLog(l.data ?? []);
    const cur = ((sub.data ?? []) as unknown as { start_month: string; end_month: string | null; plans: { discipline: string; name: string } | null }[])
      .find(x => x.start_month.slice(0, 7) <= todayMx().slice(0, 7) && (!x.end_month || x.end_month.slice(0, 7) >= todayMx().slice(0, 7)));
    setPlan(cur?.plans ? `${cur.plans.discipline} · ${cur.plans.name}` : '');
  }, [s.id, month]);
  useEffect(() => { load(); }, [load]);
  const loadBal = useCallback(() => { if (canBill && s.kind !== 'prospecto') studentBalance(s).then(setBal); }, [s, canBill]);
  useEffect(() => { loadBal(); }, [loadBal]);
  const changed = () => { reloadMe(); load(); loadBal(); onChanged(); };

  const mine = classes.flatMap(c => rosterFor(enr, c.id, month + '-01').filter(e => e.student_id === s.id).map(e => ({ ...e, c })));
  const today = todayMx(); const daysInMonth = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  const expected = mine.flatMap(e => Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
    .filter(d => d <= today && e.weekdays.includes(dow(d))).map(d => ({ d, c: e.c })));
  const came = att.filter(a => a.arrival).length, missed = att.filter(a => !a.arrival).length, extra = att.filter(a => a.extra && a.arrival).length;
  const unmarked = expected.filter(x => !att.some(a => a.date === x.d && a.class_id === x.c.id)).length;
  const net = bal ? bal.owed + bal.pendingReceipts - bal.credit : 0;
  const since = daysSince(s.enrolled_on ?? s.became_student_on ?? null);

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
  async function reactivate() {
    if (!confirm(`¿Reactivar a ${s.full_name}? Después asígnale su plan en la pestaña Plan y clases.`)) return;
    const { error } = await supabase.rpc('reactivate_student', { p_student: s.id }); if (error) setMsg(error.message); else { setTab('plan'); changed(); }
  }

  const status = s.kind === 'prospecto' ? { l: 'Prospecto', c: 'bg-amber-100 text-amber-800' } : !s.is_active ? { l: 'Baja', c: 'bg-slate-200 text-slate-600' }
    : net > 0 ? { l: 'Debe', c: 'bg-red-100 text-red-700' } : plan ? { l: 'Al corriente', c: 'bg-green-100 text-green-700' } : { l: 'Sin plan', c: 'bg-sky-100 text-sky-700' };
  const tabs: [string, string][] = [['perfil', 'Perfil'], ...(s.kind !== 'prospecto' ? [['plan', 'Plan y clases'] as [string, string]] : []),
    ...(canBill && s.kind !== 'prospecto' ? [['cuenta', 'Estado de cuenta'] as [string, string]] : []), ['asistencia', 'Asistencia'],
    ...(canNotes || notes.length ? [['notas', `Notas${notes.filter(n => !n.deleted_at).length ? ` (${notes.filter(n => !n.deleted_at).length})` : ''}`] as [string, string]] : []), ['historial', 'Historial']];
  const cur = tabs.some(t => t[0] === tab) ? tab : 'perfil';

  return (
    <Modal title={<span className="flex items-center gap-3"><Photo path={s.photo_path} size={44} /><span>{s.full_name}
      <span className="block text-xs font-normal text-slate-500">{age(s.birth_date)}{since !== null && s.is_active && s.kind !== 'prospecto' ? ` · alumna desde hace ${since} días` : ''}{plan ? ` · ${plan}` : ''}</span></span></span>} onClose={onClose} wide>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status.c}`}>{status.l}</span>
        {bal && s.kind !== 'prospecto' && <span className={`rounded-full px-3 py-1 text-xs font-semibold ${net > 0 ? 'bg-red-50 text-red-700' : net < 0 ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-600'}`}>
          {net > 0 ? `Debe ${formatMXN(net)}` : net < 0 ? `${formatMXN(-net)} a favor` : 'Sin adeudos'}</span>}
        {!s.is_active && s.withdrawal_reason && <span className="text-xs text-slate-500">Baja {s.withdrawn_on}: {s.withdrawal_reason}</span>}
        <span className="ml-auto flex gap-2">
          {can('cashbox', 'edit') && s.is_active && <button className="rounded-xl bg-green-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:brightness-110"
            onClick={() => { goTo('caja', { 'caja.preselect': s.id, 'caja.sucursal': JSON.stringify(s.company_id), 'caja.tab': JSON.stringify('cobrar') }); onClose(); }}>🛒 Nueva venta</button>}
          {canManage && s.kind !== 'prospecto' && (s.is_active
            ? <button className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50" onClick={() => setWithdraw(true)}>Dar de baja</button>
            : <button className="rounded-xl border border-green-300 px-3 py-1.5 text-sm text-green-700 hover:bg-green-50" onClick={reactivate}>Reactivar</button>)}
        </span>
      </div>
      {withdraw && <Withdraw s={s} onDone={() => { setWithdraw(false); changed(); }} onCancel={() => setWithdraw(false)} />}
      <ModuleTabs id="ficha" tabs={tabs} value={cur} onChange={setTab} />

      {cur === 'perfil' && <StudentProfile s={s} onChanged={changed} />}
      {cur === 'plan' && <><div className="text-sm">{mine.length ? mine.map(e => <span key={e.class_id} className="mr-2 inline-block rounded-full bg-slate-100 px-2 py-1">{e.c.activity} {e.c.start_time} · {e.weekdays.map(w => WD[w]).join(', ')}</span>)
        : <span className="text-slate-400">Sin clases este mes</span>}</div><StudentPlans s={s} onChanged={changed} /></>}
      {cur === 'cuenta' && <StudentAccount s={s} balance={bal} />}
      {cur === 'asistencia' && <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3"><input type="month" className="rounded-lg border px-2 py-1 text-sm" value={month} onChange={e => setMonth(e.target.value)} />
          <span className="text-sm"><span className="text-green-700">{came} vino</span> · <span className="text-red-700">{missed} faltó</span>
            {extra > 0 && <> · <span className="text-amber-700">{extra} en día que no le tocaba</span></>} · {unmarked} sin registro · le tocaban {expected.length}</span></div>
        <div className="flex flex-wrap gap-1 text-xs">{att.map(a => (
          <span key={a.date + a.class_id} className={`rounded-lg px-2 py-1 ${a.arrival ? (a.extra ? 'bg-amber-100' : 'bg-green-100') : 'bg-red-100'}`}>
            {+a.date.slice(8)} {WD[dow(a.date)]} {a.arrival ?? 'faltó'}</span>))}{!att.length && <span className="text-slate-400">Sin registros este mes.</span>}</div>
      </div>}
      {cur === 'notas' && <div className="space-y-2">
        <p className="text-xs text-slate-500">Notas internas: sólo maestros y dirección.</p>
        {canNotes && <div className="flex gap-2"><textarea className={`${field} flex-1`} rows={2} value={body} onChange={e => setBody(e.target.value)} placeholder="Qué observaste, en qué va, qué trabajar…" />
          <button disabled={!body.trim()} className="self-end rounded-lg bg-brand px-3 py-2 text-sm text-white disabled:opacity-50" onClick={addNote}>Guardar</button></div>}
        {notes.map(n => (
          <div key={n.id} className={`rounded-xl border p-3 text-sm ${n.deleted_at ? 'border-dashed bg-slate-50 text-slate-400' : 'bg-white'}`}>
            <p className="whitespace-pre-wrap">{n.body}</p>
            <p className="mt-1 flex text-xs text-slate-500">{n.author_name ?? '—'} · {new Date(n.created_at).toLocaleString('es-MX')}
              {n.deleted_at && <span className="ml-2">· borrada {new Date(n.deleted_at).toLocaleDateString('es-MX')}</span>}
              {!n.deleted_at && (n.created_by === user?.id || user?.role === 'director') && <button className="ml-auto text-red-600" onClick={() => delNote(n)}>Borrar</button>}</p>
          </div>))}
        {!notes.length && <p className="text-sm text-slate-400">Sin notas.</p>}
      </div>}
      {cur === 'historial' && <div className="space-y-1 text-sm">
        {log.map((x, i) => <p key={i} className="rounded-lg bg-slate-50 px-3 py-2"><b className={x.action === 'baja' ? 'text-red-700' : 'text-green-700'}>{x.action === 'baja' ? 'Baja' : x.action === 'reactivacion' ? 'Reactivación' : 'Inscripción'}</b>
          {x.reason ? ` · ${x.reason}` : ''}{x.last_month ? ` · último mes ${monthName(x.last_month.slice(0, 7))}` : ''}{x.note ? ` · "${x.note}"` : ''}
          <span className="block text-xs text-slate-500">{new Date(x.created_at).toLocaleString('es-MX')} · {x.author_name}</span></p>)}
        {s.enrolled_on && <p className="rounded-lg bg-slate-50 px-3 py-2"><b className="text-green-700">Inscripción</b> · {s.enrolled_on}</p>}
        {!log.length && !s.enrolled_on && <p className="text-slate-400">Sin movimientos.</p>}
        <p className="text-xs text-slate-500">Los cambios de plan, pagos y becas están en sus pestañas.</p>
      </div>}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
    </Modal>
  );
}

function Withdraw({ s, onDone, onCancel }: { s: Stu; onDone: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState(''); const [other, setOther] = useState(''); const [note, setNote] = useState(''); const [last, setLast] = useState(todayMx().slice(0, 7));
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setMsg(null);
    const { error } = await supabase.rpc('withdraw_student', { p_student: s.id, p_reason: reason === 'Otro' ? other.trim() || 'Otro' : reason, p_note: note, p_last_month: `${last}-01` });
    setBusy(false); if (error) setMsg(error.message); else onDone();
  }
  return (
    <div className="space-y-2 rounded-xl border-2 border-red-200 bg-red-50/40 p-3 text-sm">
      <h4 className="font-semibold">Dar de baja a {s.full_name}</h4>
      <div className="flex flex-wrap gap-1.5">{REASONS.map(r => <button key={r} onClick={() => setReason(r)}
        className={`rounded-full border px-3 py-1 text-xs ${reason === r ? 'border-red-400 bg-red-100 font-semibold text-red-800' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>{r}</button>)}</div>
      {reason === 'Otro' && <input className={`${field} w-full`} placeholder="¿Cuál?" value={other} onChange={e => setOther(e.target.value)} />}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">Último mes que viene<input type="month" className={`${field} block`} value={last} onChange={e => setLast(e.target.value)} /></label>
        <label className="grow text-xs">Comentario<input className={`${field} block w-full`} placeholder="Qué dijo la mamá, si regresa…" value={note} onChange={e => setNote(e.target.value)} /></label>
      </div>
      <p className="text-xs text-slate-600">Sus planes terminan en ese mes (ya no se le cobra después) y pasa a la lista de inactivas. Lo que deba hasta ese mes se conserva.</p>
      <div className="flex gap-2"><button disabled={!reason || busy} className="rounded-lg bg-red-600 px-3 py-1.5 text-white disabled:opacity-50" onClick={save}>Dar de baja</button>
        <button className="text-slate-500" onClick={onCancel}>Cancelar</button></div>
      {msg && <p className="text-red-700">{msg}</p>}
    </div>
  );
}
