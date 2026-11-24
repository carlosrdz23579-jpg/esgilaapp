import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { usePersisted } from '../lib/usePersisted';
import { Modal, TimeSelect } from './ui';

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
const deadlineOf = (ym: string) => `${addMonth(ym, -1)}-25`;

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
  const [tab, setTab] = usePersisted<'calendario' | 'planeaciones' | 'revision'>('coaches:tab', 'calendario');
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
  const tabs = [['calendario', 'Calendario'], ['planeaciones', 'Planeaciones y mis apuntes'], ...(can('planning', 'view') ? [['revision', 'Revisión de maestros']] : [])] as const;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">{tabs.map(([k, l]) => (
        <button key={k} onClick={() => setTab(k as typeof tab)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === k ? 'bg-brand text-white' : 'bg-white shadow-sm'}`}>{l}</button>))}
        <span className="ml-auto self-center text-sm text-slate-500">{companies.find(c => c.id === co)?.trade_name}</span></div>
      {tab === 'calendario' && <Calendar companyId={co} />}
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

function Calendar({ companyId }: { companyId: string }) {
  const { can } = useAuth();
  const [month, setMonth] = usePersisted('coaches:mes', todayMx().slice(0, 7));
  const coaches = useCoaches(companyId);
  // Clave 'día|n' (n = calentamiento 1, 2…). Viñedos tiene 2 por día; CAR, 1.
  const [leaders, setLeaders] = useState<Record<string, string | null>>({});
  const [slots, setSlots] = useState(1);
  const [att, setAtt] = useState<Record<string, { arrival: string | null; uniform: boolean | null }>>({});
  const [day, setDay] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const canLead = can('warmup', 'configure'), canAtt = can('uniform', 'edit');

  const days = useMemo(() => {
    const n = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
    return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  }, [month]);
  const load = useCallback(async () => {
    const [l, a, c] = await Promise.all([
      supabase.from('warmup_leader_latest').select('date,slot,employee_id').eq('company_id', companyId).gte('date', days[0]).lte('date', days[days.length - 1]),
      supabase.from('staff_attendance_latest').select('employee_id,date,arrival,uniform').eq('company_id', companyId).gte('date', days[0]).lte('date', days[days.length - 1]),
      supabase.from('companies').select('warmups_per_day').eq('id', companyId).single(),
    ]);
    if (l.error) setMsg(l.error.message);
    setSlots((c.data as { warmups_per_day: number } | null)?.warmups_per_day ?? 1);
    setLeaders(Object.fromEntries(((l.data ?? []) as { date: string; slot: number; employee_id: string | null }[]).map(x => [`${x.date}|${x.slot}`, x.employee_id])));
    setAtt(Object.fromEntries(((a.data ?? []) as { employee_id: string; date: string; arrival: string | null; uniform: boolean | null }[]).map(x => [`${x.employee_id}|${x.date}`, x])));
  }, [companyId, days]);
  useEffect(() => { load(); }, [load]);

  const wd = (iso: string) => new Date(iso + 'T12:00:00Z').getUTCDay();
  const working = (iso: string) => coaches.filter(c => c.work_days.includes(wd(iso)));
  const name = (id: string | null | undefined) => coaches.find(c => c.id === id)?.full_name ?? '';
  const lead = async (iso: string, slot: number, empId: string) => {
    const { error } = await supabase.from('warmup_leaders').insert({ company_id: companyId, date: iso, slot, employee_id: empId || null });
    if (error) setMsg(error.message); else load();
  };
  const offset = wd(days[0]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 shadow-sm">
        <button className="rounded border px-2" onClick={() => setMonth(addMonth(month, -1))}>‹</button>
        <b className="w-40 text-center capitalize">{monthLabel(month)}</b>
        <button className="rounded border px-2" onClick={() => setMonth(addMonth(month, 1))}>›</button>
        <p className="ml-2 text-xs text-slate-500">🔥 dirige el calentamiento; el resto de los coaches de ese día ayuda activamente. Da clic en un día para ver quién trabaja{canAtt ? ' y registrar llegada y uniforme' : ''}.</p>
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <div className="grid grid-cols-7 gap-1 text-xs">
        {WD.map(d => <div key={d} className="py-1 text-center font-semibold text-slate-500">{d}</div>)}
        {Array.from({ length: offset }, (_, i) => <div key={'x' + i} />)}
        {days.map(iso => {
          const w = working(iso); const isToday = iso === todayMx();
          const noUni = w.filter(c => att[`${c.id}|${iso}`]?.uniform === false).length;
          return (
            <div key={iso} onClick={() => setDay(iso)} className={`min-h-[5.5rem] cursor-pointer rounded-lg border bg-white p-1.5 hover:border-brand ${isToday ? 'border-brand ring-1 ring-brand' : ''} ${w.length === 0 ? 'opacity-50' : ''}`}>
              <div className="flex justify-between"><b>{+iso.slice(8)}</b>{w.length > 0 && <span className="text-slate-400">{w.length} coach(es)</span>}</div>
              {w.length > 0 && Array.from({ length: slots }, (_, k) => k + 1).map(n => {
                const v = leaders[`${iso}|${n}`] ?? '';
                return canLead
                  ? <select key={n} onClick={e => e.stopPropagation()} className="mt-1 w-full rounded border px-1 py-0.5 text-[11px]" value={v} onChange={e => lead(iso, n, e.target.value)}>
                      <option value="">🔥{slots > 1 ? n : ''} Sin asignar</option>{w.map(c => <option key={c.id} value={c.id}>🔥{slots > 1 ? n : ''} {c.full_name}</option>)}</select>
                  : v && <p key={n} className="mt-1 truncate">🔥{slots > 1 ? n : ''} {name(v)}</p>;
              })}
              {noUni > 0 && <p className="mt-1 text-amber-700">{noUni} sin uniforme</p>}
            </div>);
        })}
      </div>
      {day && <DayPanel iso={day} companyId={companyId} coaches={working(day)} slots={slots} leaders={Array.from({ length: slots }, (_, k) => leaders[`${day}|${k + 1}`] ?? null)} att={att} canAtt={canAtt}
        onClose={() => setDay(null)} onChanged={load} />}
    </div>
  );
}

function DayPanel({ iso, companyId, coaches, slots, leaders, att, canAtt, onClose, onChanged }:
  { iso: string; companyId: string; coaches: Emp[]; slots: number; leaders: (string | null)[]; att: Record<string, { arrival: string | null; uniform: boolean | null }>;
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
                <td className="text-xs">{leaders.includes(c.id) ? <b>🔥 Dirige{slots > 1 ? ` el ${leaders.indexOf(c.id) + 1}º` : ''}</b> : 'Ayuda activamente'}</td>
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
  const [files, setFiles] = useState<PFile[]>([]);
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<PFile | null>(null);
  const [planMonth, setPlanMonth] = useState(addMonth(todayMx().slice(0, 7), 1));
  const [note, setNote] = useState(''); const [noteFiles, setNoteFiles] = useState<FileList | null>(null);
  const [gq, setGq] = useState(quarterOf(todayMx()).start);
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
  const daysLeft = Math.round((Date.parse(deadlineOf(planMonth)) - Date.parse(todayMx())) / 864e5);

  async function addGeneral(f: File) {
    const q = quarterOf(gq); setBusy(true); setMsg(null);
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
      title: `Planeación ${monthLabel(planMonth)} · semanas ${part === 1 ? '1–2' : '3–4'}`, storage_path: u.path, file_name: f.name, mime: f.type, size_bytes: f.size });
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
            <select className={field} value={gq} onChange={e => setGq(e.target.value)}>
              {[-1, 0, 1, 2].map(k => { const d = new Date(Date.parse(quarterOf(todayMx()).start) + k * 92 * 864e5).toISOString().slice(0, 10); const q = quarterOf(d);
                return <option key={q.start} value={q.start}>{q.label}</option>; })}</select>
            <label className={`${btn} cursor-pointer`}>Subir archivo<input type="file" hidden disabled={busy} onChange={e => e.target.files?.[0] && addGeneral(e.target.files[0])} /></label></span>}</div>
        {generals.length === 0 && <p className="text-sm text-slate-500">Aún no hay planeación general.</p>}
        {generals.map(g => <div key={g.id} className="flex items-center gap-2 text-sm">
          <button className="text-brand underline" onClick={() => g.storage_path && openFile(g.storage_path)}>{g.title}</button>
          <span className="text-xs text-slate-400">{g.file_name} · {g.period_start} a {g.period_end}</span>
          {canGeneral && <button className="ml-auto text-xs text-red-700" onClick={() => hide(g)}>Quitar</button>}</div>)}
      </section>

      {me ? <>
        <section className="space-y-2 rounded-xl bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">Mi planeación mensual</h3>
            <span className="ml-auto flex items-center gap-1 text-sm">
              <button className="rounded border px-2" onClick={() => setPlanMonth(addMonth(planMonth, -1))}>‹</button>
              <b className="w-32 text-center capitalize">{monthLabel(planMonth)}</b>
              <button className="rounded border px-2" onClick={() => setPlanMonth(addMonth(planMonth, 1))}>›</button></span></div>
          <p className={`text-xs ${daysLeft >= 0 && daysLeft <= 3 ? 'font-semibold text-amber-700' : 'text-slate-500'}`}>
            Fecha límite: 25 de {MONTHS[+addMonth(planMonth, -1).slice(5, 7) - 1]}{daysLeft > 0 ? ` · faltan ${daysLeft} día(s)` : daysLeft === 0 ? ' · ¡es hoy!' : ' · ya pasó (se marca como envío tardío)'}. Cualquier tipo de archivo; hasta 2 envíos por parte.</p>
          <div className="grid gap-2 sm:grid-cols-2">{([1, 2] as const).map(part => {
            const sent = myMonthly.filter(f => f.part === part);
            return (
              <div key={part} className="rounded-lg border p-3 text-sm">
                <p className="font-medium">Semanas {part === 1 ? '1–2' : '3–4'}</p>
                {sent.map(f => <p key={f.id} className="text-xs"><button className="text-brand underline" onClick={() => f.storage_path && openFile(f.storage_path)}>{f.file_name}</button>
                  {' '}· {f.created_at.slice(0, 10)} {f.late ? <span className="font-semibold text-red-700">envío tardío</span> : <span className="text-green-700">a tiempo</span>}{f.reviewed_at && ' · revisada ✓'}</p>)}
                {sent.length < 2 && <label className="mt-1 inline-block cursor-pointer text-xs text-brand">{sent.length ? '+ Subir versión actualizada' : '+ Subir'}<input type="file" hidden disabled={busy} onChange={e => e.target.files?.[0] && addMonthly(part, e.target.files[0])} /></label>}
              </div>);
          })}</div>
        </section>

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
  const [files, setFiles] = useState<PFile[]>([]);
  const [month, setMonth] = usePersisted('coaches:revisionMes', addMonth(todayMx().slice(0, 7), 1));
  const [open, setOpen] = useState<Emp | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const q = quarterOf(`${month}-01`);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('planning_status').select('*').eq('company_id', companyId).neq('kind', 'general').order('created_at', { ascending: false });
    if (error) setMsg(error.message); else setFiles((data as PFile[]) ?? []);
  }, [companyId]);
  useEffect(() => { load(); }, [load]);
  const overdue = todayMx() > deadlineOf(month);
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
        <span className="ml-3 text-xs text-slate-500">Límite: {deadlineOf(month)} · apuntes contados en el {q.label}</span></div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-100 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Coach</th><th>Semanas 1–2</th><th>Semanas 3–4</th><th>Apuntes del trimestre</th><th>Último apunte</th></tr></thead>
          <tbody>{coaches.map(c => {
            const notes = files.filter(x => x.employee_id === c.id && x.kind === 'apunte' && x.period_start >= q.start && x.period_start <= q.end);
            return (
              <tr key={c.id} className="cursor-pointer border-t hover:bg-slate-50" onClick={() => setOpen(c)}>
                <td className="px-3 py-2 font-medium text-brand">{c.full_name}</td><td>{status(c.id, 1)}</td><td>{status(c.id, 2)}</td>
                <td className={notes.length ? '' : 'text-amber-700'}>{notes.length}</td><td className="text-xs">{notes[0]?.created_at.slice(0, 10) ?? '—'}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
      {open && <Modal wide title={open.full_name} onClose={() => setOpen(null)}>
        <div className="divide-y rounded-lg border text-sm">{files.filter(f => f.employee_id === open.id).map(f => (
          <div key={f.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 ${f.hidden_at ? 'text-slate-400' : ''}`}>
            <span className="text-xs">{f.kind === 'mensual' ? `📅 ${monthLabel(f.period_start.slice(0, 7))} · parte ${f.part}` : '📝 Apunte'}</span>
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
