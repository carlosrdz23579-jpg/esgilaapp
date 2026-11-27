import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { usePersisted } from '../lib/usePersisted';
import { Modal, TimeSelect } from './ui';
import Warmup from './Warmup';

const field = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const btn = 'rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60';
const WD = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const todayMx = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const nowHHMM = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit' });
const monthLabel = (ym: string) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const addMonth = (ym: string, n: number) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const quarterOf = (iso: string) => { const y = +iso.slice(0, 4), q = Math.floor((+iso.slice(5, 7) - 1) / 3);
  return { start: `${y}-${String(q * 3 + 1).padStart(2, '0')}-01`, end: new Date(Date.UTC(y, q * 3 + 3, 0)).toISOString().slice(0, 10), label: `${['1er', '2º', '3er', '4º'][q]} trimestre ${y}` }; };
/** Periodo de la planeación general / conteo de apuntes según la sucursal. */
const periodOf = (iso: string, mode: string) => {
  if (mode !== 'mensual') return quarterOf(iso);
  const ym = iso.slice(0, 7);
  return { start: `${ym}-01`, end: new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10), label: `mes de ${monthLabel(ym)}` };
};
const deadlineOf = (ym: string, day = 25) => `${addMonth(ym, -1)}-${String(day).padStart(2, '0')}`;
/** Ajustes de la sucursal (Configuración). */
function useCompanyCfg(companyId: string) {
  const [cfg, setCfg] = useState({ planning_deadline_day: 25, planning_max_uploads: 2, planning_period: 'trimestral', planning_parts: 2 });
  useEffect(() => { supabase.from('companies').select('planning_deadline_day,planning_max_uploads,planning_period,planning_parts').eq('id', companyId).single()
    .then(({ data }) => data && setCfg(data as typeof cfg)); }, [companyId]);
  return cfg;
}

interface Emp { id: string; full_name: string; company_id: string; work_days: number[]; department_id: string; user_id: string | null }
interface PFile { id: string; company_id: string; kind: 'general' | 'mensual' | 'apunte'; employee_id: string | null; period_start: string; period_end: string | null;
  part: number | null; title: string | null; note: string | null; storage_path: string | null; file_name: string | null; mime: string | null; created_at: string;
  hidden_at: string | null; reviewed_at: string | null; late: boolean | null; deadline: string | null }

async function openFile(path: string) {
  const { data, error } = await supabase.storage.from('planeaciones').createSignedUrl(path, 300);
  if (error) return alert(error.message);
  window.open(data.signedUrl, '_blank');
}
async function upload(companyId: string, who: string, file: File): Promise<{ path: string } | { error: string }> {
  const safe = file.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_');
  const path = `${companyId}/${who}/${Date.now()}-${safe}`;
  const { error } = await supabase.storage.from('planeaciones').upload(path, file, { contentType: file.type || undefined });
  return error ? { error: error.message } : { path };
}

export default function CoachCalendar() {
  const { companyId, can, companies } = useAuth();
  const [tab, setTab] = usePersisted<'eventos' | 'calendario' | 'calentamiento' | 'planeaciones' | 'revision'>('calendario:tab', 'eventos');
  const [me, setMe] = useState<Emp | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      const r = await supabase.from('employees').select('id,full_name,company_id,work_days,department_id,user_id').eq('user_id', data.user.id).maybeSingle();
      setMe((r.data as Emp) ?? null);
    });
  }, []);
  const co = companyId !== 'all' ? companyId : me?.company_id ?? '';
  if (!co) return <p className="rounded-xl border border-dashed bg-white p-4 text-sm text-slate-500">Elige una sucursal en el selector de arriba.</p>;
  const tabs = [['eventos', 'Eventos'], ['calendario', 'Coaches'], ...(can('warmup') ? [['calentamiento', 'Calentamiento activo']] : []),
    ['planeaciones', 'Planeaciones y mis apuntes'], ...(can('planning', 'view') ? [['revision', 'Revisión de maestros']] : [])] as const;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">{tabs.map(([k, l]) => (
        <button key={k} onClick={() => setTab(k as typeof tab)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === k ? 'bg-brand text-white' : 'bg-white shadow-sm'}`}>{l}</button>))}
        <span className="ml-auto self-center text-sm text-slate-500">{companies.find(c => c.id === co)?.trade_name}</span></div>
      {tab === 'eventos' && <Events companyId={co} />}
      {tab === 'calendario' && <Calendar companyId={co} />}
      {tab === 'calentamiento' && <Warmup />}
      {tab === 'planeaciones' && <Plans companyId={co} me={me && me.company_id === co ? me : null} />}
      {tab === 'revision' && can('planning', 'view') && <ReviewPlans companyId={co} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function useCoaches(companyId: string) {
  const [coaches, setCoaches] = useState<Emp[]>([]);
  useEffect(() => {
    Promise.all([
      supabase.from('employees').select('id,full_name,company_id,work_days,department_id,user_id').eq('company_id', companyId).eq('state', 'activo').order('full_name'),
      supabase.from('departments').select('id,name').eq('company_id', companyId),
    ]).then(([e, d]) => {
      const coach = new Set(((d.data ?? []) as { id: string; name: string }[]).filter(x => x.name.trim().toLowerCase() === 'coach').map(x => x.id));
      setCoaches(((e.data ?? []) as Emp[]).filter(x => coach.has(x.department_id)));
    });
  }, [companyId]);
  return coaches;
}

interface Slot { start: string; end: string; teachers: number }
const slotLabel = (s: Slot) => `${s.start}–${s.end}`;
interface Lead { slot: number; label: string; employeeId: string | null; fromRotation: boolean }

function Calendar({ companyId }: { companyId: string }) {
  const { can } = useAuth();
  const [month, setMonth] = usePersisted('coaches:mes', todayMx().slice(0, 7));
  const coaches = useCoaches(companyId);
  const [schedule, setSchedule] = useState<Record<string, Slot[]>>({});
  const [rotation, setRotation] = useState<Record<string, string | null>>({});
  const [overrides, setOverrides] = useState<Record<string, { mode: string; employee_id: string | null }>>({});
  const [att, setAtt] = useState<Record<string, { arrival: string | null; uniform: boolean | null }>>({});
  const [day, setDay] = useState<string | null>(null); const [rotOpen, setRotOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const canLead = can('warmup', 'configure'), canAtt = can('uniform', 'edit');

  const days = useMemo(() => {
    const n = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
    return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  }, [month]);
  const load = useCallback(async () => {
    const [l, a, c, r] = await Promise.all([
      supabase.from('warmup_leader_latest').select('date,slot,position,mode,employee_id').eq('company_id', companyId).gte('date', days[0]).lte('date', days[days.length - 1]),
      supabase.from('staff_attendance_latest').select('employee_id,date,arrival,uniform').eq('company_id', companyId).gte('date', days[0]).lte('date', days[days.length - 1]),
      supabase.from('companies').select('warmup_schedule').eq('id', companyId).single(),
      supabase.from('warmup_rotation_latest').select('weekday,slot,position,employee_id').eq('company_id', companyId),
    ]);
    const err = l.error ?? c.error ?? r.error; if (err) setMsg(err.message);
    setSchedule(((c.data as { warmup_schedule: Record<string, Slot[]> } | null)?.warmup_schedule) ?? {});
    setRotation(Object.fromEntries(((r.data ?? []) as { weekday: number; slot: number; position: number; employee_id: string | null }[]).map(x => [`${x.weekday}|${x.slot}|${x.position}`, x.employee_id])));
    setOverrides(Object.fromEntries(((l.data ?? []) as { date: string; slot: number; position: number; mode: string; employee_id: string | null }[]).map(x => [`${x.date}|${x.slot}|${x.position}`, x])));
    setAtt(Object.fromEntries(((a.data ?? []) as { employee_id: string; date: string; arrival: string | null; uniform: boolean | null }[]).map(x => [`${x.employee_id}|${x.date}`, x])));
  }, [companyId, days]);
  useEffect(() => { load(); }, [load]);

  const wd = (iso: string) => new Date(iso + 'T12:00:00Z').getUTCDay();
  const slotsFor = (iso: string) => schedule[String(wd(iso))] ?? [];
  const working = (iso: string) => coaches.filter(c => c.work_days.includes(wd(iso)));
  const name = (id: string | null | undefined) => coaches.find(c => c.id === id)?.full_name ?? '';
  const first = (id: string | null | undefined) => name(id).split(' ')[0];
  /** Quién dirige: el cambio del día si lo hay; si no, la rotación semanal. */
  const effective = (iso: string, slot: number, pos: number): { id: string | null; rot: boolean } => {
    const o = overrides[`${iso}|${slot}|${pos}`];
    if (o && o.mode !== 'rotacion') return { id: o.mode === 'asignado' ? o.employee_id : null, rot: false };
    return { id: rotation[`${wd(iso)}|${slot}|${pos}`] ?? null, rot: true };
  };
  const leadsOf = (iso: string): Lead[] => slotsFor(iso).flatMap((sl, k) => Array.from({ length: sl.teachers }, (_, p) => {
    const e = effective(iso, k + 1, p + 1); return { slot: k + 1, label: slotLabel(sl), employeeId: e.id, fromRotation: e.rot };
  }));
  async function setLead(iso: string, slot: number, pos: number, v: string) {
    const row = v === '__rot' ? { mode: 'rotacion' } : v === '__none' ? { mode: 'sin_asignar' } : { mode: 'asignado', employee_id: v };
    const { error } = await supabase.from('warmup_leaders').insert({ company_id: companyId, date: iso, slot, position: pos, ...row });
    if (error) setMsg(error.message); else load();
  }
  const offset = wd(days[0]);
  const multiOf = (iso: string) => { const sl = slotsFor(iso); return sl.length > 1 || sl.some(s => s.teachers > 1); };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 shadow-sm">
        <button className="rounded border px-2" onClick={() => setMonth(addMonth(month, -1))}>‹</button>
        <b className="w-40 text-center capitalize">{monthLabel(month)}</b>
        <button className="rounded border px-2" onClick={() => setMonth(addMonth(month, 1))}>›</button>
        <p className="ml-2 text-xs text-slate-500">🔥 dirigen el calentamiento; el resto ayuda activamente. Días, horas y maestros por calentamiento se cambian en Configuración. Clic en un día para ver{canAtt ? ' y registrar llegada y uniforme' : ' quién trabaja'}.</p>
        {canLead && <button className="ml-auto rounded-lg border px-3 py-1.5 text-sm" onClick={() => setRotOpen(true)}>Rotación semanal</button>}
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <div className="grid grid-cols-7 gap-1 text-xs">
        {WD.map(d => <div key={d} className="py-1 text-center font-semibold text-slate-500">{d}</div>)}
        {Array.from({ length: offset }, (_, i) => <div key={'x' + i} />)}
        {days.map(iso => {
          const w = working(iso); const isToday = iso === todayMx();
          const noUni = w.filter(c => att[`${c.id}|${iso}`]?.uniform === false).length;
          const opts = [...w, ...coaches.filter(c => !w.includes(c))];
          const slots = slotsFor(iso); const multi = multiOf(iso);
          return (
            <div key={iso} onClick={() => setDay(iso)} className={`min-h-[6rem] cursor-pointer rounded-lg border bg-white p-1.5 hover:border-brand ${isToday ? 'border-brand ring-1 ring-brand' : ''} ${w.length === 0 ? 'opacity-50' : ''}`}>
              <div className="flex justify-between"><b>{+iso.slice(8)}</b>{w.length > 0 && <span className="text-slate-400">{w.length}</span>}</div>
              {w.length > 0 && slots.map((sl, k) => (
                <div key={k} className="mt-1">
                  {multi && <p className="text-[10px] font-semibold text-slate-500">🔥 {slotLabel(sl)}</p>}
                  {Array.from({ length: sl.teachers }, (_, p) => {
                    const e = effective(iso, k + 1, p + 1); const o = overrides[`${iso}|${k + 1}|${p + 1}`];
                    const value = !o || o.mode === 'rotacion' ? '__rot' : o.mode === 'sin_asignar' ? '__none' : o.employee_id ?? '__none';
                    return canLead
                      ? <select key={p} onClick={ev => ev.stopPropagation()} className={`mt-0.5 w-full rounded border px-1 py-0.5 text-[11px] ${e.rot ? '' : 'border-amber-400 bg-amber-50'}`} value={value} onChange={ev => setLead(iso, k + 1, p + 1, ev.target.value)}>
                          <option value="__rot">{e.rot ? (first(e.id) || '— sin rotación —') : 'Según rotación'}</option>
                          <option value="__none">— nadie este día —</option>
                          {opts.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select>
                      : <p key={p} className={`truncate ${e.rot ? '' : 'text-amber-700'}`}>{multi ? '' : '🔥 '}{first(e.id) || '—'}</p>;
                  })}
                </div>))}
              {noUni > 0 && <p className="mt-1 text-amber-700">{noUni} sin uniforme</p>}
            </div>);
        })}
      </div>
      {canLead && <p className="text-xs text-slate-500">Lo que viene de la rotación se llena solo cada semana. Si cambias a alguien un día, se marca en ámbar; "Según rotación" lo regresa.</p>}
      {day && <DayPanel iso={day} companyId={companyId} coaches={working(day)} leads={leadsOf(day)} multi={multiOf(day)} att={att} canAtt={canAtt}
        onClose={() => setDay(null)} onChanged={load} />}
      {rotOpen && <RotationEditor companyId={companyId} schedule={schedule} coaches={coaches} rotation={rotation} onClose={() => setRotOpen(false)} onChanged={load} />}
    </div>
  );
}

function RotationEditor({ companyId, schedule, coaches, rotation, onClose, onChanged }:
  { companyId: string; schedule: Record<string, Slot[]>; coaches: Emp[]; rotation: Record<string, string | null>; onClose: () => void; onChanged: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const weekdays = [1, 2, 3, 4, 5, 6, 0].filter(d => (schedule[String(d)] ?? []).length > 0);
  async function set(wdN: number, slot: number, pos: number, v: string) {
    const { error } = await supabase.from('warmup_rotation').insert({ company_id: companyId, weekday: wdN, slot, position: pos, employee_id: v || null });
    if (error) setMsg(error.message); else onChanged();
  }
  return (
    <Modal wide title="Rotación semanal del calentamiento" onClose={onClose}>
      <p className="text-xs text-slate-500">Se repite cada semana. Los cambios de un día concreto se hacen en el calendario.</p>
      {weekdays.length === 0 && <p className="text-sm text-slate-500">No hay días con calentamiento. Agrégalos en Configuración → Calentamiento.</p>}
      <div className="space-y-2">{weekdays.map(d => (
        <div key={d} className="rounded-lg border p-2">
          <p className="mb-1 text-sm font-semibold">{WD[d]}</p>
          {(schedule[String(d)] ?? []).map((s, k) => (
            <div key={k} className="flex flex-wrap items-center gap-2 py-0.5 text-xs">
              <span className="w-28 text-slate-500">🔥 {slotLabel(s)}</span>
              {Array.from({ length: s.teachers }, (_, p) => (
                <select key={p} className="min-w-[12rem] rounded border px-1 py-1" value={rotation[`${d}|${k + 1}|${p + 1}`] ?? ''} onChange={e => set(d, k + 1, p + 1, e.target.value)}>
                  <option value="">— nadie —</option>
                  {[...coaches.filter(c => c.work_days.includes(d)), ...coaches.filter(c => !c.work_days.includes(d))].map(c =>
                    <option key={c.id} value={c.id}>{c.full_name}{c.work_days.includes(d) ? '' : ' (no trabaja ese día)'}</option>)}
                </select>))}
            </div>))}
        </div>))}</div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
    </Modal>
  );
}

function DayPanel({ iso, companyId, coaches, leads, multi, att, canAtt, onClose, onChanged }:
  { iso: string; companyId: string; coaches: Emp[]; leads: Lead[]; multi: boolean; att: Record<string, { arrival: string | null; uniform: boolean | null }>;
    canAtt: boolean; onClose: () => void; onChanged: () => void }) {
  const isToday = iso === todayMx();
  const [draft, setDraft] = useState<Record<string, { arrival: string; uniform: boolean; absent: boolean }>>(() =>
    Object.fromEntries(coaches.map(c => { const a = att[`${c.id}|${iso}`];
      return [c.id, { arrival: a?.arrival ?? (isToday ? nowHHMM() : ''), uniform: a?.uniform ?? true, absent: !!a && a.arrival === null }]; })));
  const [msg, setMsg] = useState<string | null>(null); const [saving, setSaving] = useState<string | null>(null);
  const future = iso > todayMx();
  async function save(c: Emp) {
    const d = draft[c.id]; setSaving(c.id); setMsg(null);
    const { error } = await supabase.from('staff_attendance').insert({ company_id: companyId, employee_id: c.id, date: iso,
      arrival: d.absent ? null : d.arrival || null, uniform: d.absent ? null : d.uniform });
    setSaving(null); if (error) setMsg(error.message); else onChanged();
  }
  const set = (id: string, p: Partial<{ arrival: string; uniform: boolean; absent: boolean }>) => setDraft(x => ({ ...x, [id]: { ...x[id], ...p } }));
  return (
    <Modal title={`${WD[new Date(iso + 'T12:00:00Z').getUTCDay()]} ${+iso.slice(8)} de ${MONTHS[+iso.slice(5, 7) - 1]}`} onClose={onClose}>
      {coaches.length === 0 ? <p className="text-sm text-slate-500">Ningún coach trabaja este día según sus días laborables.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500"><tr><th className="py-1">Coach</th><th>Calentamiento</th>{canAtt && <><th>Llegada</th><th>Uniforme</th><th>No vino</th><th /></>}</tr></thead>
          <tbody>{coaches.map(c => {
            const d = draft[c.id]; const saved = att[`${c.id}|${iso}`];
            return (
              <tr key={c.id} className="border-t">
                <td className="py-1.5 font-medium">{c.full_name}</td>
                <td className="text-xs">{leads.some(l => l.employeeId === c.id)
                  ? <b>🔥 Dirige{multi ? ` ${leads.filter(l => l.employeeId === c.id).map(l => l.label).join(' y ')}` : ''}</b> : 'Ayuda activamente'}</td>
                {canAtt && <>
                  <td>{d.absent ? '—' : <TimeSelect allowAny from="05:00" value={d.arrival} onChange={v => set(c.id, { arrival: v })} />}</td>
                  <td className="text-center"><input type="checkbox" disabled={d.absent} checked={d.uniform} onChange={e => set(c.id, { uniform: e.target.checked })} /></td>
                  <td className="text-center"><input type="checkbox" checked={d.absent} onChange={e => set(c.id, { absent: e.target.checked })} /></td>
                  <td className="text-right">{future ? <span className="text-xs text-slate-400">día futuro</span>
                    : <button disabled={saving === c.id} className="text-xs text-brand" onClick={() => save(c)}>{saved ? 'Actualizar' : 'Guardar'}</button>}
                    {saved && <span className="block text-[11px] text-slate-400">{saved.arrival === null ? 'no vino' : `${saved.arrival}${saved.uniform === false ? ' · sin uniforme' : ''}`}</span>}</td>
                </>}
              </tr>);
          })}</tbody>
        </table>)}
      {canAtt && <p className="text-xs text-slate-500">La hora viene con la hora actual de México; la puedes ajustar. Esto es además del checador. Nadie registra su propia asistencia.</p>}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function Plans({ companyId, me }: { companyId: string; me: Emp | null }) {
  const { can } = useAuth();
  const cfg = useCompanyCfg(companyId);
  const [files, setFiles] = useState<PFile[]>([]);
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<PFile | null>(null);
  const [planMonth, setPlanMonth] = useState(addMonth(todayMx().slice(0, 7), 1));
  const [note, setNote] = useState(''); const [noteFiles, setNoteFiles] = useState<FileList | null>(null);
  const [gq, setGq] = useState(todayMx());
  const parts = ([1, 2] as const).slice(0, cfg.planning_parts);
  const genOptions = cfg.planning_period === 'mensual'
    ? [-1, 0, 1, 2].map(k => periodOf(`${addMonth(todayMx().slice(0, 7), k)}-01`, 'mensual'))
    : [-1, 0, 1, 2].map(k => quarterOf(new Date(Date.parse(quarterOf(todayMx()).start) + k * 92 * 864e5).toISOString().slice(0, 10)));
  const canGeneral = can('planning', 'configure');

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('planning_status').select('*').eq('company_id', companyId).is('hidden_at', null).order('created_at', { ascending: false });
    if (error) setMsg(error.message); else setFiles((data as PFile[]) ?? []);
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  const generals = files.filter(f => f.kind === 'general');
  const mine = files.filter(f => f.employee_id === me?.id);
  const myMonthly = mine.filter(f => f.kind === 'mensual' && f.period_start.slice(0, 7) === planMonth);
  const myNotes = mine.filter(f => f.kind === 'apunte');
  const daysLeft = Math.round((Date.parse(deadlineOf(planMonth, cfg.planning_deadline_day)) - Date.parse(todayMx())) / 864e5);

  async function addGeneral(f: File) {
    const q = periodOf(gq, cfg.planning_period); setBusy(true); setMsg(null);
    const u = await upload(companyId, 'general', f);
    if ('error' in u) { setBusy(false); return setMsg(u.error); }
    const { error } = await supabase.from('planning_files').insert({ company_id: companyId, kind: 'general', period_start: q.start, period_end: q.end,
      title: `Planeación ${q.label}`, storage_path: u.path, file_name: f.name, mime: f.type, size_bytes: f.size });
    setBusy(false); if (error) setMsg(error.message); else load();
  }
  async function addMonthly(part: 1 | 2, f: File) {
    if (!me) return; setBusy(true); setMsg(null);
    const u = await upload(companyId, me.id, f);
    if ('error' in u) { setBusy(false); return setMsg(u.error); }
    const { error } = await supabase.from('planning_files').insert({ company_id: companyId, kind: 'mensual', employee_id: me.id, period_start: `${planMonth}-01`, part,
      title: `Planeación ${monthLabel(planMonth)}${cfg.planning_parts > 1 ? ` · semanas ${part === 1 ? '1–2' : '3–4'}` : ''}`, storage_path: u.path, file_name: f.name, mime: f.type, size_bytes: f.size });
    setBusy(false); if (error) setMsg(error.message); else load();
  }
  async function addNote() {
    if (!me || (!note.trim() && !noteFiles?.length)) return;
    setBusy(true); setMsg(null);
    const list = noteFiles?.length ? [...noteFiles] : [null];
    for (const f of list) {
      let path: string | null = null;
      if (f) { const u = await upload(companyId, me.id, f); if ('error' in u) { setBusy(false); return setMsg(u.error); } path = u.path; }
      const { error } = await supabase.from('planning_files').insert({ company_id: companyId, kind: 'apunte', employee_id: me.id, period_start: todayMx(),
        title: note.trim().split('\n')[0].slice(0, 80) || f?.name || 'Apunte', note: note.trim() || null, storage_path: path, file_name: f?.name ?? null, mime: f?.type ?? null, size_bytes: f?.size ?? null });
      if (error) { setBusy(false); return setMsg(error.message); }
    }
    setBusy(false); setNote(''); setNoteFiles(null); load();
  }
  async function hide(f: PFile) {
    if (!window.confirm(`¿Quitar "${f.title ?? f.file_name}"? Ya no te aparecerá.`)) return;
    const { error } = await supabase.rpc('hide_planning_file', { p_id: f.id });
    if (error) setMsg(error.message); else { setOpen(null); load(); }
  }

  return (
    <div className="space-y-4">
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <section className="space-y-2 rounded-xl bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">Planeación general de la sucursal</h3>
          {canGeneral && <span className="ml-auto flex items-center gap-2 text-xs">
            <select className={field} value={periodOf(gq, cfg.planning_period).start} onChange={e => setGq(e.target.value)}>
              {genOptions.map(q => <option key={q.start} value={q.start}>{q.label}</option>)}</select>
            <label className={`${btn} cursor-pointer`}>Subir archivo<input type="file" hidden disabled={busy} onChange={e => e.target.files?.[0] && addGeneral(e.target.files[0])} /></label></span>}</div>
        {generals.length === 0 && <p className="text-sm text-slate-500">Aún no hay planeación general.</p>}
        {generals.map(g => <div key={g.id} className="flex items-center gap-2 text-sm">
          <button className="text-brand underline" onClick={() => g.storage_path && openFile(g.storage_path)}>{g.title}</button>
          <span className="text-xs text-slate-400">{g.file_name} · {g.period_start} a {g.period_end}</span>
          {canGeneral && <button className="ml-auto text-xs text-red-700" onClick={() => hide(g)}>Quitar</button>}</div>)}
      </section>

      {me ? <>
        {parts.length > 0 && <section className="space-y-2 rounded-xl bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">Mi planeación mensual</h3>
            <span className="ml-auto flex items-center gap-1 text-sm">
              <button className="rounded border px-2" onClick={() => setPlanMonth(addMonth(planMonth, -1))}>‹</button>
              <b className="w-32 text-center capitalize">{monthLabel(planMonth)}</b>
              <button className="rounded border px-2" onClick={() => setPlanMonth(addMonth(planMonth, 1))}>›</button></span></div>
          <p className={`text-xs ${daysLeft >= 0 && daysLeft <= 3 ? 'font-semibold text-amber-700' : 'text-slate-500'}`}>
            Fecha límite: {cfg.planning_deadline_day} de {MONTHS[+addMonth(planMonth, -1).slice(5, 7) - 1]}{daysLeft > 0 ? ` · faltan ${daysLeft} día(s)` : daysLeft === 0 ? ' · ¡es hoy!' : ' · ya pasó (se marca como envío tardío)'}. Cualquier tipo de archivo; hasta {cfg.planning_max_uploads} envío(s) por parte.</p>
          <div className={`grid gap-2 ${parts.length > 1 ? 'sm:grid-cols-2' : ''}`}>{parts.map(part => {
            const sent = myMonthly.filter(f => f.part === part);
            return (
              <div key={part} className="rounded-lg border p-3 text-sm">
                <p className="font-medium">{parts.length > 1 ? `Semanas ${part === 1 ? '1–2' : '3–4'}` : 'Planeación del mes'}</p>
                {sent.map(f => <p key={f.id} className="text-xs"><button className="text-brand underline" onClick={() => f.storage_path && openFile(f.storage_path)}>{f.file_name}</button>
                  {' '}· {f.created_at.slice(0, 10)} {f.late ? <span className="font-semibold text-red-700">envío tardío</span> : <span className="text-green-700">a tiempo</span>}{f.reviewed_at && ' · revisada ✓'}</p>)}
                {sent.length < cfg.planning_max_uploads && <label className="mt-1 inline-block cursor-pointer text-xs text-brand">{sent.length ? '+ Subir versión actualizada' : '+ Subir'}<input type="file" hidden disabled={busy} onChange={e => e.target.files?.[0] && addMonthly(part, e.target.files[0])} /></label>}
              </div>);
          })}</div>
        </section>}

        <section className="space-y-2 rounded-xl bg-white p-4 shadow-sm">
          <h3 className="font-semibold">Mis apuntes</h3>
          <p className="text-xs text-slate-500">Cómo vas a llevar a cabo la planeación: notas, archivos o fotos. Puedes quitarlos cuando quieras.</p>
          <textarea className={`${field} w-full`} rows={3} placeholder="Escribe tu apunte…" value={note} onChange={e => setNote(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <input type="file" multiple onChange={e => setNoteFiles(e.target.files)} className="text-sm" />
            <button disabled={busy || (!note.trim() && !noteFiles?.length)} className={btn} onClick={addNote}>{busy ? 'Subiendo…' : 'Guardar apunte'}</button></div>
          {myNotes.length > 0 && <div className="divide-y rounded-lg border">{myNotes.map(f => (
            <button key={f.id} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => setOpen(f)}>
              <span>{f.storage_path ? (f.mime?.startsWith('image/') ? '🖼️' : '📎') : '📝'}</span><span className="truncate">{f.title}</span>
              <span className="ml-auto shrink-0 text-xs text-slate-400">{f.created_at.slice(0, 10)}</span></button>))}</div>}
        </section>
      </> : <p className="rounded-xl border border-dashed bg-white p-4 text-sm text-slate-500">Para subir tu planeación y tus apuntes, tu cuenta debe estar ligada a tu expediente (Usuarios y permisos).</p>}

      {open && <Modal title={open.title ?? 'Apunte'} onClose={() => setOpen(null)}>
        <p className="text-xs text-slate-400">{open.created_at.slice(0, 16).replace('T', ' ')}</p>
        {open.note && <p className="whitespace-pre-wrap text-sm">{open.note}</p>}
        {open.storage_path && <button className="text-sm text-brand underline" onClick={() => openFile(open.storage_path!)}>Abrir {open.file_name}</button>}
        <button className="block text-sm text-red-700" onClick={() => hide(open)}>Quitar este apunte</button>
      </Modal>}
    </div>
  );
}

// ---------------------------------------------------------------------------
function ReviewPlans({ companyId }: { companyId: string }) {
  const coaches = useCoaches(companyId);
  const cfg = useCompanyCfg(companyId);
  const [files, setFiles] = useState<PFile[]>([]);
  const [month, setMonth] = usePersisted('coaches:revisionMes', addMonth(todayMx().slice(0, 7), 1));
  const [open, setOpen] = useState<Emp | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const q = periodOf(`${month}-01`, cfg.planning_period); const parts = [1, 2].slice(0, cfg.planning_parts);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('planning_status').select('*').eq('company_id', companyId).neq('kind', 'general').order('created_at', { ascending: false });
    if (error) setMsg(error.message); else setFiles((data as PFile[]) ?? []);
  }, [companyId]);
  useEffect(() => { load(); }, [load]);
  const overdue = todayMx() > deadlineOf(month, cfg.planning_deadline_day);
  const status = (empId: string, part: number) => {
    const f = files.filter(x => x.employee_id === empId && x.kind === 'mensual' && x.part === part && x.period_start.slice(0, 7) === month);
    if (!f.length) return overdue ? <span className="font-semibold text-red-700">no entregó</span> : <span className="text-slate-400">pendiente</span>;
    const last = f[0];
    return <span className={last.late ? 'text-red-700' : 'text-green-700'}>{last.late ? 'tardía' : 'a tiempo'} {last.created_at.slice(5, 10)}{last.reviewed_at ? ' ✓' : ''}</span>;
  };
  async function review(f: PFile) {
    const { error } = await supabase.from('planning_files').update({ reviewed_at: f.reviewed_at ? null : new Date().toISOString() }).eq('id', f.id);
    if (error) setMsg(error.message); else load();
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 rounded-xl bg-white p-3 text-sm shadow-sm">
        <button className="rounded border px-2" onClick={() => setMonth(addMonth(month, -1))}>‹</button>
        <b className="w-36 text-center capitalize">{monthLabel(month)}</b>
        <button className="rounded border px-2" onClick={() => setMonth(addMonth(month, 1))}>›</button>
        <span className="ml-3 text-xs text-slate-500">{parts.length > 0 && <>Límite: {deadlineOf(month, cfg.planning_deadline_day)} · </>}apuntes contados en el {q.label}</span></div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-100 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Coach</th>{parts.map(p => <th key={p}>{parts.length > 1 ? `Semanas ${p === 1 ? '1–2' : '3–4'}` : 'Planeación del mes'}</th>)}<th>Apuntes del {cfg.planning_period === 'mensual' ? 'mes' : 'trimestre'}</th><th>Último apunte</th></tr></thead>
          <tbody>{coaches.map(c => {
            const notes = files.filter(x => x.employee_id === c.id && x.kind === 'apunte' && x.period_start >= q.start && x.period_start <= q.end);
            return (
              <tr key={c.id} className="cursor-pointer border-t hover:bg-slate-50" onClick={() => setOpen(c)}>
                <td className="px-3 py-2 font-medium text-brand">{c.full_name}</td>{parts.map(p => <td key={p}>{status(c.id, p)}</td>)}
                <td className={notes.length ? '' : 'text-amber-700'}>{notes.length}</td><td className="text-xs">{notes[0]?.created_at.slice(0, 10) ?? '—'}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
      {open && <Modal wide title={open.full_name} onClose={() => setOpen(null)}>
        <div className="divide-y rounded-lg border text-sm">{files.filter(f => f.employee_id === open.id).map(f => (
          <div key={f.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 ${f.hidden_at ? 'text-slate-400' : ''}`}>
            <span className="text-xs">{f.kind === 'mensual' ? `📅 ${monthLabel(f.period_start.slice(0, 7))}${cfg.planning_parts > 1 ? ` · parte ${f.part}` : ''}` : '📝 Apunte'}</span>
            <span className="truncate">{f.title}</span>
            {f.storage_path && <button className="text-xs text-brand underline" onClick={() => openFile(f.storage_path!)}>abrir</button>}
            {f.kind === 'mensual' && <span className={`text-xs ${f.late ? 'text-red-700' : 'text-green-700'}`}>{f.late ? 'envío tardío' : 'a tiempo'}</span>}
            {f.hidden_at && <span className="text-xs">(el maestro lo quitó)</span>}
            <span className="ml-auto text-xs text-slate-400">{f.created_at.slice(0, 16).replace('T', ' ')}</span>
            {f.kind === 'mensual' && <button className="text-xs text-brand" onClick={() => review(f)}>{f.reviewed_at ? '✓ Revisada' : 'Marcar revisada'}</button>}
            {f.note && <p className="w-full whitespace-pre-wrap text-xs text-slate-600">{f.note}</p>}
          </div>))}</div>
      </Modal>}
    </div>
  );
}

// ---------------------------------------------------------------------------
const KIND: Record<string, { label: string; cls: string }> = {
  evento: { label: 'Evento', cls: 'bg-indigo-100 text-indigo-800' }, competencia: { label: 'Competencia', cls: 'bg-rose-100 text-rose-800' },
  junta: { label: 'Junta', cls: 'bg-amber-100 text-amber-800' }, festivo: { label: 'Día festivo / sin clases', cls: 'bg-slate-200 text-slate-700' },
  curso: { label: 'Curso', cls: 'bg-emerald-100 text-emerald-800' }, clase_especial: { label: 'Clase especial', cls: 'bg-sky-100 text-sky-800' },
  otro: { label: 'Otro', cls: 'bg-slate-100 text-slate-700' } };
interface Ev { id: string; date: string; end_date: string | null; start_time: string | null; end_time: string | null; kind: string; title: string; notes: string | null; created_at: string;
  audience?: string }
type Target = { department_id?: string; group_id?: string; employee_id?: string };

/** Itinerario general de la sucursal: competencias, juntas, festivos, cursos, clases especiales. */
function Events({ companyId }: { companyId: string }) {
  const { can } = useAuth();
  const [month, setMonth] = usePersisted('eventos:mes', todayMx().slice(0, 7));
  const [evs, setEvs] = useState<Ev[]>([]); const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Ev> | null>(null); const [open, setOpen] = useState<Ev | null>(null);
  const canEdit = can('calendar', 'edit');
  const [targets, setTargets] = useState<Target[]>([]); const [openTargets, setOpenTargets] = useState<Target[]>([]); const [tq, setTq] = useState('');
  const [opts, setOpts] = useState<{ depts: { id: string; name: string }[]; groups: { id: string; name: string }[]; emps: { id: string; full_name: string }[] }>({ depts: [], groups: [], emps: [] });
  useEffect(() => {
    if (!canEdit) return;
    Promise.all([supabase.from('departments').select('id,name').eq('company_id', companyId).order('name'), supabase.from('groups').select('id,name').eq('company_id', companyId).order('name'),
      supabase.from('employees').select('id,full_name').eq('company_id', companyId).eq('state', 'activo').order('full_name')])
      .then(([d, g, e]) => setOpts({ depts: d.data ?? [], groups: g.data ?? [], emps: e.data ?? [] }));
  }, [companyId, canEdit]);
  useEffect(() => { if (open) supabase.from('event_targets').select('department_id,group_id,employee_id').eq('event_id', open.id).then(r => setOpenTargets((r.data as Target[]) ?? [])); }, [open]);
  const tName = (t: Target) => t.department_id ? `Depto. ${opts.depts.find(x => x.id === t.department_id)?.name ?? ''}` : t.group_id ? `Grupo ${opts.groups.find(x => x.id === t.group_id)?.name ?? ''}`
    : opts.emps.find(x => x.id === t.employee_id)?.full_name ?? 'Persona';
  const has = (t: Target) => targets.some(x => x.department_id === t.department_id && x.group_id === t.group_id && x.employee_id === t.employee_id);
  const toggle = (t: Target) => setTargets(has(t) ? targets.filter(x => !(x.department_id === t.department_id && x.group_id === t.group_id && x.employee_id === t.employee_id)) : [...targets, t]);
  const first = `${month}-01`, last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('calendar_events').select('id,date,end_date,start_time,end_time,kind,title,notes,created_at,audience')
      .eq('company_id', companyId).is('cancelled_at', null).lte('date', last).or(`end_date.gte.${first},and(end_date.is.null,date.gte.${first})`).order('date');
    if (error) setMsg(error.message); else setEvs((data as Ev[]) ?? []);
  }, [companyId, first, last]);
  useEffect(() => { load(); }, [load]);
  const days = Array.from({ length: +last.slice(8) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const on = (iso: string) => evs.filter(e => e.date <= iso && (e.end_date ?? e.date) >= iso);
  const offset = new Date(first + 'T12:00:00Z').getUTCDay();

  async function save() {
    if (!form?.title?.trim() || !form.date) return setMsg('Falta título y fecha.');
    if (form.start_time && form.end_time && form.end_time <= form.start_time) return setMsg('La hora de fin debe ser después del inicio.');
    const dirigido = form.audience === 'dirigido';
    if (dirigido && !targets.length) return setMsg('Elige a quién va dirigido.');
    const { data, error } = await supabase.from('calendar_events').insert({ company_id: companyId, date: form.date, end_date: form.end_date || null,
      start_time: form.start_time || null, end_time: form.end_time || null, kind: form.kind ?? 'evento', title: form.title.trim(), notes: form.notes?.trim() || null,
      audience: dirigido ? 'dirigido' : 'todos' }).select('id').single();
    if (error) return setMsg(error.message);
    if (dirigido) { const t = await supabase.from('event_targets').insert(targets.map(x => ({ event_id: data.id, ...x }))); if (t.error) return setMsg(t.error.message); }
    setForm(null); setTargets([]); setMsg(null); load();
  }
  async function cancel(e: Ev) {
    if (!window.confirm(`¿Cancelar "${e.title}"?`)) return;
    const { error } = await supabase.from('calendar_events').update({ cancelled_at: new Date().toISOString() }).eq('id', e.id);
    if (error) setMsg(error.message); else { setOpen(null); load(); }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 shadow-sm">
        <button className="rounded border px-2" onClick={() => setMonth(addMonth(month, -1))}>‹</button>
        <b className="w-40 text-center capitalize">{monthLabel(month)}</b>
        <button className="rounded border px-2" onClick={() => setMonth(addMonth(month, 1))}>›</button>
        <span className="flex flex-wrap gap-1 text-[11px]">{Object.entries(KIND).map(([k, v]) => <span key={k} className={`rounded px-1.5 ${v.cls}`}>{v.label}</span>)}</span>
        {canEdit && <button className={`${btn} ml-auto`} onClick={() => setForm({ date: todayMx(), kind: 'evento' })}>+ Evento</button>}
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <div className="grid grid-cols-7 gap-1 text-xs">
        {WD.map(d => <div key={d} className="py-1 text-center font-semibold text-slate-500">{d}</div>)}
        {Array.from({ length: offset }, (_, i) => <div key={'x' + i} />)}
        {days.map(iso => (
          <div key={iso} onDoubleClick={() => canEdit && setForm({ date: iso, kind: 'evento' })}
            className={`min-h-[5.5rem] rounded-lg border bg-white p-1.5 ${iso === todayMx() ? 'border-brand ring-1 ring-brand' : ''}`}>
            <b>{+iso.slice(8)}</b>
            {on(iso).map(e => <button key={e.id} onClick={() => setOpen(e)} className={`mt-0.5 block w-full truncate rounded px-1 text-left ${KIND[e.kind]?.cls ?? ''}`}>
              {e.audience === 'dirigido' ? '👥 ' : ''}{e.start_time ? `${e.start_time} ` : ''}{e.title}</button>)}
          </div>))}
      </div>
      {canEdit && <p className="text-xs text-slate-500">Doble clic en un día para agregar un evento ahí.</p>}
      {form && <Modal title="Nuevo evento" onClose={() => setForm(null)}>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs sm:col-span-2">Título<input autoFocus className={`${field} w-full`} value={form.title ?? ''} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
          <label className="text-xs">Tipo<select className={`${field} w-full`} value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>
            {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
          <span />
          <label className="text-xs">Fecha<input type="date" className={`${field} w-full`} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></label>
          <label className="text-xs">Hasta (si dura varios días)<input type="date" min={form.date} className={`${field} w-full`} value={form.end_date ?? ''} onChange={e => setForm({ ...form, end_date: e.target.value })} /></label>
          <label className="text-xs">Desde las<TimeSelect allowAny className={`${field} w-full`} value={form.start_time ?? ''} onChange={v => setForm({ ...form, start_time: v })} /></label>
          <label className="text-xs">Hasta las<TimeSelect allowAny className={`${field} w-full`} value={form.end_time ?? ''} onChange={v => setForm({ ...form, end_time: v })} /></label>
          <label className="text-xs sm:col-span-2">Notas / itinerario<textarea rows={4} className={`${field} w-full`} value={form.notes ?? ''} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
          <div className="space-y-1 text-xs sm:col-span-2"><span className="block">Para quién</span>
            <div className="inline-flex overflow-hidden rounded-lg border">{[['todos', 'Todos'], ['dirigido', 'Personas o grupos']].map(([k, l]) =>
              <button key={k} type="button" className={`px-3 py-1.5 ${(form.audience ?? 'todos') === k ? 'bg-brand text-white' : ''}`} onClick={() => setForm({ ...form, audience: k })}>{l}</button>)}</div>
            {form.audience === 'dirigido' && <div className="space-y-2 rounded-lg border p-2">
              {targets.length > 0 && <div className="flex flex-wrap gap-1">{targets.map((t, i) => <span key={i} className="rounded-full bg-brand/10 px-2 py-0.5 text-brand">{tName(t)} <button onClick={() => toggle(t)}>×</button></span>)}</div>}
              {opts.depts.length > 0 && <div><b>Departamentos</b><div className="flex flex-wrap gap-x-3">{opts.depts.map(d => <label key={d.id} className="flex items-center gap-1">
                <input type="checkbox" checked={has({ department_id: d.id })} onChange={() => toggle({ department_id: d.id })} />{d.name}</label>)}</div></div>}
              {opts.groups.length > 0 && <div><b>Grupos</b><div className="flex flex-wrap gap-x-3">{opts.groups.map(g => <label key={g.id} className="flex items-center gap-1">
                <input type="checkbox" checked={has({ group_id: g.id })} onChange={() => toggle({ group_id: g.id })} />{g.name}</label>)}</div></div>}
              <div><b>Personas</b><input className={`${field} my-1 w-full`} placeholder="Buscar persona…" value={tq} onChange={e => setTq(e.target.value)} />
                <div className="flex max-h-40 flex-wrap gap-x-3 overflow-y-auto">{opts.emps.filter(e => !tq || e.full_name.toLowerCase().includes(tq.toLowerCase())).map(e => <label key={e.id} className="flex items-center gap-1">
                  <input type="checkbox" checked={has({ employee_id: e.id })} onChange={() => toggle({ employee_id: e.id })} />{e.full_name}</label>)}</div></div>
              <p className="text-slate-500">Sólo lo ven las personas elegidas (o de esos departamentos/grupos) y quien administra el calendario.</p>
            </div>}
          </div>
        </div>
        <div className="flex gap-2"><button className={btn} onClick={save}>Guardar</button><button className="text-sm" onClick={() => setForm(null)}>Cancelar</button></div>
      </Modal>}
      {open && <Modal title={open.title} onClose={() => setOpen(null)}>
        <p className="text-sm"><span className={`rounded px-1.5 text-xs ${KIND[open.kind]?.cls}`}>{KIND[open.kind]?.label}</span>{' '}
          {open.date}{open.end_date && open.end_date !== open.date ? ` al ${open.end_date}` : ''}{open.start_time ? ` · ${open.start_time}${open.end_time ? `–${open.end_time}` : ''}` : ''}</p>
        {open.notes && <p className="whitespace-pre-wrap text-sm">{open.notes}</p>}
        <p className="text-xs text-slate-500">Para: {open.audience === 'dirigido' ? (openTargets.length ? openTargets.map(tName).join(', ') : 'personas elegidas') : 'todos'}</p>
        {canEdit && <button className="text-sm text-red-700" onClick={() => cancel(open)}>Cancelar evento</button>}
      </Modal>}
    </div>
  );
}
