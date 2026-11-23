import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { TimeSelect } from './ui';

const field = 'w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const KINDS = { clase_extra: 'Clase extra', curso: 'Curso', competencia: 'Competencia', sin_actividad: 'Sin actividad (no viene)', otro: 'Otro' } as const;
type Kind = keyof typeof KINDS;
export interface WBlock { weekday: number; start: string; end: string }
interface SchedRow { id: string; blocks: WBlock[]; effective_from: string; reason: string; created_at: string }
interface ExRow { id: string; date: string; kind: Kind; blocks: { start: string; end: string }[]; replaces_base: boolean; reason: string; cancelled_at: string | null }
const today = () => new Date().toLocaleDateString('en-CA');

/** Horario base semanal (solo-agregar: un cambio es una versión nueva) y excepciones de un día. */
export default function WorkSchedulePanel({ employeeId, companyId, suggestion, onChange, defaultFrom }:
  { employeeId: string; companyId: string; suggestion?: WBlock[]; onChange?: () => void; defaultFrom?: string }) {
  const { can } = useAuth();
  const canEdit = can('payroll_hours', 'edit');
  const [rows, setRows] = useState<SchedRow[]>([]); const [ex, setEx] = useState<ExRow[]>([]);
  const [draft, setDraft] = useState<WBlock[] | null>(null); const [from, setFrom] = useState(defaultFrom ?? today()); const [reason, setReason] = useState('');
  const [exOpen, setExOpen] = useState(false);
  const [exF, setExF] = useState({ date: today(), kind: 'clase_extra' as Kind, start: '06:00', end: '08:00', replaces: false, reason: '' });
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, e] = await Promise.all([
      supabase.from('employee_work_schedules').select('id,blocks,effective_from,reason,created_at').eq('employee_id', employeeId)
        .order('effective_from', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('schedule_exceptions').select('id,date,kind,blocks,replaces_base,reason,cancelled_at').eq('employee_id', employeeId)
        .gte('date', new Date(Date.now() - 60 * 864e5).toLocaleDateString('en-CA')).order('date', { ascending: false }),
    ]);
    const err = s.error ?? e.error; if (err) setMsg(err.message);
    setRows((s.data as SchedRow[]) ?? []); setEx((e.data as ExRow[]) ?? []);
  }, [employeeId]);
  useEffect(() => { load(); }, [load]);

  const current = rows.find(r => r.effective_from <= today()) ?? null;
  const upcoming = rows.filter(r => r.effective_from > today());

  async function saveSchedule() {
    setMsg(null);
    if (!draft) return;
    const bad = draft.find(b => !b.start || !b.end || b.end <= b.start);
    if (bad) return setMsg(`Revisa el ${DAYS[bad.weekday]}: la salida debe ser después de la entrada.`);
    if (!reason.trim()) return setMsg('Escribe el motivo del cambio.');
    const { error } = await supabase.from('employee_work_schedules').insert({ company_id: companyId, employee_id: employeeId,
      blocks: [...draft].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start)), effective_from: from, reason: reason.trim() });
    if (error) return setMsg(error.message);
    setDraft(null); setReason(''); load(); onChange?.();
  }
  async function addException(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const blocks = exF.kind === 'sin_actividad' ? [] : [{ start: exF.start, end: exF.end }];
    if (blocks.length && exF.end <= exF.start) return setMsg('La hora de salida debe ser después de la entrada.');
    const { error } = await supabase.from('schedule_exceptions').insert({ company_id: companyId, employee_id: employeeId, date: exF.date,
      kind: exF.kind, blocks, replaces_base: exF.kind === 'sin_actividad' ? false : exF.replaces, reason: exF.reason.trim() || KINDS[exF.kind] });
    if (error) return setMsg(error.message);
    setExOpen(false); load(); onChange?.();
  }
  async function cancelException(x: ExRow) {
    if (!window.confirm(`¿Cancelar "${KINDS[x.kind]}" del ${x.date}?`)) return;
    const { error } = await supabase.from('schedule_exceptions').update({ cancelled_at: new Date().toISOString() }).eq('id', x.id);
    if (error) setMsg(error.message); else load();
  }

  const fmt = (b: WBlock[]) => DAYS.map((d, i) => {
    const bs = b.filter(x => x.weekday === i); return bs.length ? `${d.slice(0, 3)} ${bs.map(x => `${x.start}–${x.end}`).join(', ')}` : null;
  }).filter(Boolean).join(' · ') || 'Sin días';

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex items-center"><h4 className="text-sm font-semibold">Horario</h4>
        {canEdit && !draft && <button className="ml-auto text-sm text-brand" onClick={() => setDraft(current?.blocks ?? [])}>{current ? 'Cambiar horario' : '+ Capturar horario'}</button>}</div>
      <p className="text-sm">{current ? <>{fmt(current.blocks)} <span className="text-xs text-slate-400">· desde {current.effective_from}</span></> : <span className="text-slate-500">Sin horario base: sin él no se pueden detectar retardos ni faltas.</span>}</p>
      {upcoming.map(u => <p key={u.id} className="text-xs text-slate-500">Programado desde {u.effective_from}: {fmt(u.blocks)}</p>)}
      {canEdit && !draft && !current && suggestion && suggestion.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-indigo-50 p-2 text-sm text-indigo-900">
          <span>Sugerido según sus checadas: <b>{fmt(suggestion)}</b></span>
          <button className="ml-auto rounded-lg border border-indigo-400 px-3 py-1 text-xs" onClick={() => { setDraft(suggestion); setReason('Horario tomado de sus checadas'); }}>Usar y revisar</button>
        </div>)}

      {draft && (
        <div className="space-y-2 rounded-lg border p-3">
          {DAYS.map((d, i) => {
            const mine = draft.map((b, k) => ({ b, k })).filter(x => x.b.weekday === i);
            return (
              <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-24">{d}</span>
                {mine.length === 0 && <span className="text-xs text-slate-400">no trabaja</span>}
                {mine.map(({ b, k }) => (
                  <span key={k} className="flex items-center gap-1">
                    <TimeSelect className={`${field} w-24`} value={b.start} onChange={v => setDraft(draft.map((x, j) => j === k ? { ...x, start: v } : x))} />–
                    <TimeSelect className={`${field} w-24`} value={b.end} onChange={v => setDraft(draft.map((x, j) => j === k ? { ...x, end: v } : x))} />
                    <button type="button" aria-label="Quitar" className="text-red-700" onClick={() => setDraft(draft.filter((_, j) => j !== k))}>×</button>
                  </span>))}
                <button type="button" className="text-xs text-brand" onClick={() => setDraft([...draft, { weekday: i, start: '16:00', end: '20:00' }])}>+ bloque</button>
              </div>);
          })}
          <div className="flex flex-wrap items-end gap-2">
            <button type="button" className="text-xs text-brand" onClick={() => {
              const lun = draft.filter(b => b.weekday === 1);
              if (!lun.length) return setMsg('Primero captura el lunes.');
              const copy = [2, 3, 4, 5].flatMap(w => lun.map(b => ({ ...b, weekday: w })));
              setDraft([...draft.filter(b => b.weekday < 2 || b.weekday > 5), ...copy]);
            }}>Copiar lunes a martes–viernes</button>
            <label className="text-xs">Vigente desde<input type="date" className={`${field} w-40`} value={from} onChange={e => setFrom(e.target.value)} /></label>
            <label className="grow text-xs">Motivo<input className={field} value={reason} onChange={e => setReason(e.target.value)} placeholder="Ej. horario de temporada" /></label>
            <button type="button" className="rounded-lg border border-brand px-3 py-1.5 text-sm text-brand" onClick={saveSchedule}>Guardar</button>
            <button type="button" className="text-sm" onClick={() => setDraft(null)}>Cancelar</button>
          </div>
        </div>)}

      <div className="flex items-center pt-1"><span className="text-xs font-medium text-slate-600">Excepciones (clases extra, cursos, competencias, días sin actividad)</span>
        {canEdit && <button className="ml-auto text-xs text-brand" onClick={() => setExOpen(!exOpen)}>+ Excepción</button>}</div>
      {exOpen && (
        <form onSubmit={addException} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-3">
          <label className="text-xs">Fecha<input type="date" required className={field} value={exF.date} onChange={e => setExF({ ...exF, date: e.target.value })} /></label>
          <label className="text-xs">Tipo<select className={field} value={exF.kind} onChange={e => setExF({ ...exF, kind: e.target.value as Kind })}>
            {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {exF.kind !== 'sin_actividad' && <div className="flex items-end gap-1 text-xs">
            <TimeSelect className={field} value={exF.start} onChange={v => setExF({ ...exF, start: v })} />–
            <TimeSelect className={field} value={exF.end} onChange={v => setExF({ ...exF, end: v })} /></div>}
          {exF.kind !== 'sin_actividad' && <label className="flex items-center gap-2 text-xs sm:col-span-3"><input type="checkbox" checked={exF.replaces}
            onChange={e => setExF({ ...exF, replaces: e.target.checked })} />Ese día SOLO cuenta este horario (p. ej. competencia en lugar de su horario normal)</label>}
          <label className="text-xs sm:col-span-2">Motivo<input className={field} value={exF.reason} onChange={e => setExF({ ...exF, reason: e.target.value })} /></label>
          <div className="flex items-end"><button className="rounded-lg border border-brand px-3 py-1.5 text-sm text-brand">Agregar</button></div>
        </form>)}
      {ex.filter(x => !x.cancelled_at).map(x => (
        <div key={x.id} className="flex items-center gap-2 text-xs">
          <span>{x.date}</span><b>{KINDS[x.kind]}</b><span>{x.blocks.map(b => `${b.start}–${b.end}`).join(', ')}{x.replaces_base ? ' (en lugar de su horario)' : ''}</span>
          <span className="text-slate-400">{x.reason}</span>
          {canEdit && <button className="ml-auto text-red-700" onClick={() => cancelException(x)}>Cancelar</button>}
        </div>))}
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
    </div>
  );
}
