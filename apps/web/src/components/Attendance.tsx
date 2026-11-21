import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { parseCheckerSheet, mergeReports, RAW_SHEET_NAMES, type CheckerReport } from '@domain/checador';
import WorkSchedulePanel from './WorkSchedule';
import { blocksForDate, reviewDay, suggestWeekly, ISSUE_LABEL, type WeeklyBlock, type DayException, type Review, type ReviewKind, type ReviewedDay } from '@domain/attendance';

const field = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const btn = 'rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const addDays = (iso: string, n: number) => {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)); return d.toISOString().slice(0, 10);
};
const dayLabel = (iso: string) => `${WD[new Date(iso + 'T12:00:00Z').getUTCDay()]} ${+iso.slice(8)}/${+iso.slice(5, 7)}`;
const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

interface EmpLite { id: string; full_name: string; company_id: string; state: string }
interface Mapping { device_id: string; employee_id: string | null; ignored: boolean; label: string | null }

export default function Attendance() {
  const { companies, companyId } = useAuth();
  const [tab, setTab] = useState<'subir' | 'revisar'>('subir');
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(['subir', 'revisar'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === t ? 'bg-brand text-white' : 'bg-white shadow-sm'}`}>
            {t === 'subir' ? '1. Subir reporte del checador' : '2. Revisar excepciones'}</button>))}
      </div>
      {tab === 'subir' ? <Upload companies={companies.filter(c => c.is_active)} defaultCompany={companyId !== 'all' ? companyId : ''} onDone={() => setTab('revisar')} />
        : companyId === 'all' ? <p className="rounded-xl border border-dashed bg-white p-4 text-sm text-slate-500">Elige una empresa en el selector de arriba: cada sucursal revisa y paga a su personal.</p>
        : <Review companyId={companyId} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Upload({ companies, defaultCompany, onDone }: { companies: { id: string; trade_name: string }[]; defaultCompany: string; onDone: () => void }) {
  const [company, setCompany] = useState(defaultCompany);
  const [files, setFiles] = useState<File[]>([]);
  const [report, setReport] = useState<CheckerReport | null>(null);
  const [emps, setEmps] = useState<EmpLite[]>([]);
  const [map, setMap] = useState<Record<string, Mapping>>({});
  const [showAll, setShowAll] = useState(false);
  const [msg, setMsg] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  /** Uno o varios archivos del MISMO checador (Viñedos manda dos cuando el periodo cruza de mes). */
  async function read(list: File[]) {
    setMsg(null); setOk(null); setReport(null); setFiles(list);
    try {
      const XLSX = await import('xlsx');
      const reports: CheckerReport[] = [];
      for (const f of list) {
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        const name = RAW_SHEET_NAMES.find(n => wb.SheetNames.includes(n));
        if (!name) throw new Error(`"${f.name}" no tiene una hoja de checadas (${RAW_SHEET_NAMES.join(' o ')}). Hojas: ${wb.SheetNames.join(', ')}`);
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: '' });
        try { reports.push(parseCheckerSheet(rows)); } catch (e) { throw new Error(`"${f.name}": ${(e as Error).message}`); }
      }
      setReport(mergeReports(reports));
    } catch (e) { setMsg((e as Error).message); }
  }

  const loadMapping = useCallback(async () => {
    if (!company) return;
    const [e, m] = await Promise.all([
      supabase.from('employees').select('id,full_name,company_id,state').order('full_name'),
      supabase.from('checker_ids').select('device_id,employee_id,ignored,label').eq('company_id', company),
    ]);
    if (e.error || m.error) setMsg((e.error ?? m.error)!.message);
    setEmps((e.data as EmpLite[]) ?? []);
    setMap(Object.fromEntries(((m.data as Mapping[]) ?? []).map(x => [x.device_id, x])));
  }, [company]);
  useEffect(() => { loadMapping(); }, [loadMapping]);

  const people = useMemo(() => (report?.people ?? []).map(p => ({ ...p, days: Object.keys(p.punches).length }))
    .filter(p => showAll || p.days > 0), [report, showAll]);
  const companyName = (id: string) => companies.find(c => c.id === id)?.trade_name ?? '';
  const pending = people.filter(p => p.days > 0 && !map[p.deviceId]?.employee_id && !map[p.deviceId]?.ignored);

  function setLink(deviceId: string, label: string, value: string) {
    setMap(m => ({ ...m, [deviceId]: { device_id: deviceId, label, employee_id: value && value !== 'ignorar' ? value : null, ignored: value === 'ignorar' } }));
  }

  async function save() {
    if (!report || !company || files.length === 0) return;
    if (pending.length && !window.confirm(`${pending.length} número(s) con checadas no están ligados ni ignorados; sus horas no se contarán hasta ligarlos. ¿Guardar así?`)) return;
    setBusy(true); setMsg(null); setOk(null);
    try {
      const links = Object.values(map).filter(m => report.people.some(p => p.deviceId === m.device_id))
        .map(m => ({ company_id: company, device_id: m.device_id, employee_id: m.employee_id, ignored: m.ignored, label: m.label }));
      if (links.length) { const r = await supabase.from('checker_ids').upsert(links, { onConflict: 'company_id,device_id' }); if (r.error) throw r.error; }
      const withPunches = report.people.filter(p => Object.keys(p.punches).length && !map[p.deviceId]?.ignored);
      const imp = await supabase.from('checker_imports').insert({ company_id: company, from_date: report.from, to_date: report.to,
        file_name: files.map(f => f.name).join(' + '), people: withPunches.length }).select('id').single();
      if (imp.error) throw imp.error;
      const rows = withPunches.flatMap(p => Object.entries(p.punches).map(([date, times]) =>
        ({ import_id: imp.data.id, company_id: company, device_id: p.deviceId, date, times })));
      for (let i = 0; i < rows.length; i += 500) { const r = await supabase.from('checker_punches').insert(rows.slice(i, i + 500)); if (r.error) throw r.error; }
      setOk(`Guardado: ${rows.length} día(s) con checadas de ${withPunches.length} persona(s), del ${report.from} al ${report.to}.`);
      await loadMapping();
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-sm">
        <label className="text-xs">Checador de<select className={`${field} block`} value={company} onChange={e => { setCompany(e.target.value); setReport(null); }}>
          <option value="" disabled>Elige sucursal…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</select></label>
        <label className="text-xs">Reporte(s) .xls — puedes elegir varios del mismo checador
          <input type="file" accept=".xls,.xlsx" multiple disabled={!company} className="block text-sm"
            onChange={e => e.target.files?.length && read([...e.target.files])} /></label>
        {report && <p className="text-sm">{files.length > 1 ? `${files.length} archivos juntos · ` : ''}Del <b>{report.from}</b> al <b>{report.to}</b> · {report.people.length} personas en el checador</p>}
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {ok && <p className="rounded bg-green-50 p-2 text-sm text-green-800">{ok} <button className="ml-2 underline" onClick={onDone}>Ir a revisar →</button></p>}
      {report && (
        <>
          <div className="flex items-center gap-3 text-sm">
            <p>Liga cada número del checador con su expediente. Puede ser de la otra sucursal: sus horas se pagan en su empresa. A quien ya no está, márcalo <b>Ignorar</b>.</p>
            <label className="ml-auto flex shrink-0 items-center gap-1 text-xs"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />Mostrar también sin checadas</label>
          </div>
          <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Núm.</th><th className="px-3 py-2">En el checador</th>
                <th className="px-3 py-2">Días con checada</th><th className="px-3 py-2">Expediente</th></tr></thead>
              <tbody>{people.map(p => {
                const m = map[p.deviceId]; const v = m?.ignored ? 'ignorar' : m?.employee_id ?? '';
                return (
                  <tr key={p.deviceId} className={`border-t ${p.days && !v ? 'bg-amber-50' : ''}`}>
                    <td className="px-3 py-1.5">{p.deviceId}</td><td className="px-3 py-1.5">{p.name || '(sin nombre)'} <span className="text-xs text-slate-400">{p.dept}</span></td>
                    <td className="px-3 py-1.5">{p.days}</td>
                    <td className="px-3 py-1.5"><select className={field} value={v} onChange={e => setLink(p.deviceId, p.name, e.target.value)}>
                      <option value="">— sin ligar —</option><option value="ignorar">Ignorar (ya no está / no aplica)</option>
                      {emps.filter(e => e.state === 'activo' || e.id === m?.employee_id).map(e => <option key={e.id} value={e.id}>{e.full_name} · {companyName(e.company_id)}</option>)}
                    </select></td>
                  </tr>);
              })}</tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            <button disabled={busy} className={btn} onClick={save}>Guardar ligas y checadas</button>
            {pending.length > 0 && <span className="text-sm text-amber-700">{pending.length} número(s) con checadas sin ligar</span>}
          </div>
        </>)}
    </div>
  );
}

// ---------------------------------------------------------------------------
interface EmpDays { emp: EmpLite; hasSchedule: boolean; days: ReviewedDay[]; byDate: Record<string, string[]> }

function Review({ companyId }: { companyId: string }) {
  const { can } = useAuth();
  const t = new Date().toLocaleDateString('en-CA');
  const [from, setFrom] = useState(addDays(t, -15)); const [to, setTo] = useState(addDays(t, -1));
  const [data, setData] = useState<EmpDays[]>([]); const [loading, setLoading] = useState(false);
  const [onlyPending, setOnlyPending] = useState(true); const [msg, setMsg] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<{ from_date: string; to_date: string } | null>(null);

  useEffect(() => {
    supabase.from('checker_imports').select('from_date,to_date').order('created_at', { ascending: false }).limit(1)
      .then(({ data }) => { const r = data?.[0]; if (r) { setLastImport(r); setFrom(r.from_date); setTo(r.to_date); } });
  }, [companyId]);

  const load = useCallback(async () => {
    if (from > to) return setMsg('La fecha inicial debe ser antes de la final.');
    setLoading(true); setMsg(null);
    try {
      const [co, em, ws, sx, rv] = await Promise.all([
        supabase.from('companies').select('late_tolerance_min').eq('id', companyId).single(),
        supabase.from('employees').select('id,full_name,company_id,state').eq('company_id', companyId).eq('state', 'activo').order('full_name'),
        supabase.from('employee_work_schedules').select('employee_id,blocks,effective_from,created_at').eq('company_id', companyId).lte('effective_from', to)
          .order('effective_from', { ascending: false }).order('created_at', { ascending: false }),
        supabase.from('schedule_exceptions').select('employee_id,date,kind,blocks,replaces_base').eq('company_id', companyId).is('cancelled_at', null).gte('date', from).lte('date', to),
        supabase.from('attendance_reviews').select('employee_id,date,kind,times,reason').eq('company_id', companyId).is('cancelled_at', null).gte('date', from).lte('date', to),
      ]);
      const err = co.error ?? em.error ?? ws.error ?? sx.error ?? rv.error; if (err) throw err;
      const tol = (co.data as { late_tolerance_min: number }).late_tolerance_min;
      const emps = (em.data as EmpLite[]) ?? [];
      const punches = await Promise.all(emps.map(e => supabase.rpc('employee_punches', { p_employee: e.id, p_from: from, p_to: to })));
      const out: EmpDays[] = emps.map((emp, k) => {
        const byDate: Record<string, string[]> = {};
        for (const p of (punches[k].data as { date: string; times: string[] }[]) ?? []) byDate[p.date] = [...(byDate[p.date] ?? []), ...p.times];
        const scheds = ((ws.data ?? []) as { employee_id: string; blocks: WeeklyBlock[]; effective_from: string }[]).filter(s => s.employee_id === emp.id);
        const exs: DayException[] = ((sx.data ?? []) as { employee_id: string; date: string; kind: DayException['kind']; blocks: DayException['blocks']; replaces_base: boolean }[])
          .filter(x => x.employee_id === emp.id).map(x => ({ date: x.date, kind: x.kind, blocks: x.blocks, replacesBase: x.replaces_base }));
        const revs: Review[] = ((rv.data ?? []) as { employee_id: string; date: string; kind: ReviewKind; times: string[] | null; reason: string }[])
          .filter(r => r.employee_id === emp.id).map(r => ({ date: r.date, kind: r.kind, times: r.times ?? undefined, reason: r.reason }));
        const days: ReviewedDay[] = [];
        for (let d = from; d <= to; d = addDays(d, 1)) {
          const sched = scheds.find(s => s.effective_from <= d);
          const blocks = blocksForDate(d, sched?.blocks ?? [], exs);
          days.push(reviewDay(d, byDate[d] ?? [], blocks, tol, revs));
        }
        return { emp, hasSchedule: scheds.length > 0, days, byDate };
      }).filter(x => x.hasSchedule || x.days.some(d => d.punches.length));
      setData(out);
    } catch (e) { setMsg((e as Error).message); }
    setLoading(false);
  }, [companyId, from, to]);
  useEffect(() => { load(); }, [load]);

  async function act(emp: EmpLite, d: ReviewedDay, kind: ReviewKind) {
    let times: string[] | undefined;
    if (kind === 'corregir_checadas') {
      const v = window.prompt(`Checadas correctas del ${dayLabel(d.date)} para ${emp.full_name}, separadas por espacio (ej. 16:00 20:00):`, d.punches.join(' '));
      if (v === null) return;
      times = v.trim().split(/[\s,]+/).filter(Boolean);
      if (times.some(x => !/^([01]\d|2[0-3]):[0-5]\d$/.test(x))) return setMsg('Usa el formato HH:MM, por ejemplo 07:05 16:00.');
    }
    const reason = window.prompt('Motivo (queda registrado):', kind === 'justificar_falta' ? 'Permiso' : kind === 'aprobar_extra' ? 'Clase extra' : '');
    if (!reason?.trim()) return;
    const { error } = await supabase.from('attendance_reviews').insert({ company_id: emp.company_id, employee_id: emp.id, date: d.date, kind, times: times ?? null, reason: reason.trim() });
    if (error) setMsg(error.message); else load();
  }

  const canEdit = can('payroll_hours', 'edit');
  // Sin horario base todo sale como excepción: se cuenta aparte y primero se captura su horario.
  const totals = data.filter(x => x.hasSchedule).reduce((n, x) => n + x.days.reduce((m, d) => m + d.pending.length, 0), 0);
  const noSchedule = data.filter(x => !x.hasSchedule).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-sm">
        <label className="text-xs">Desde<input type="date" className={`${field} block`} value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label className="text-xs">Hasta<input type="date" className={`${field} block`} value={to} onChange={e => setTo(e.target.value)} /></label>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={onlyPending} onChange={e => setOnlyPending(e.target.checked)} />Solo lo pendiente</label>
        <span className="ml-auto text-right text-sm">{loading ? 'Calculando…' : <>
          {totals === 0 ? '✅ Sin excepciones pendientes' : <b className="text-amber-700">{totals} excepción(es) pendiente(s)</b>}
          {noSchedule > 0 && <span className="block text-xs text-amber-700">{noSchedule} persona(s) sin horario base: captúralo primero (te sugiero uno con sus checadas)</span>}</>}</span>
        {lastImport && <span className="w-full text-xs text-slate-400">Último reporte subido: {lastImport.from_date} al {lastImport.to_date}</span>}
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {[...data].sort((a, b) => Number(a.hasSchedule) - Number(b.hasSchedule)).map(({ emp, hasSchedule, days, byDate }) => {
        const pend = days.filter(d => d.pending.length);
        const paid = days.reduce((n, d) => n + d.paidMinutes, 0);
        const lates = days.filter(d => d.issues.includes('retardo')).length;
        const faltas = days.filter(d => d.issues.includes('falta') && !d.excused).length;
        if (onlyPending && pend.length === 0) return null;
        return (
          <details key={emp.id} className="rounded-xl bg-white shadow-sm" open={!hasSchedule || (pend.length > 0 && pend.length < 6)}>
            <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <b>{emp.full_name}</b><span>{hm(paid)} h pagables</span><span>{lates} retardo(s)</span><span>{faltas} falta(s)</span>
              {!hasSchedule && <span className="rounded-full bg-amber-100 px-2 text-xs text-amber-800">sin horario base</span>}
              <span className={`ml-auto text-xs ${pend.length ? 'text-amber-700' : 'text-green-700'}`}>{!hasSchedule ? 'captura su horario' : pend.length ? `${pend.length} día(s) por revisar` : 'revisado'}</span>
            </summary>
            {!hasSchedule && can('payroll_hours', 'edit') && (
              <div className="px-4 pb-2">
                <p className="text-xs text-slate-500">Sin horario base el sistema no sabe qué horas pagar, por eso cada día sale como excepción. Al guardarlo, se recalcula solo.</p>
                <WorkSchedulePanel employeeId={emp.id} companyId={emp.company_id} suggestion={suggestWeekly(byDate, 1)} onChange={load} defaultFrom={from} />
              </div>)}
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500"><tr><th className="px-4 py-1">Día</th><th>Checadas</th><th>Pagable</th><th>Situación</th><th /></tr></thead>
              <tbody>{(hasSchedule || !onlyPending ? days : []).filter(d => !onlyPending || d.pending.length).filter(d => d.punches.length || d.scheduledMinutes || d.issues.length).map(d => (
                <tr key={d.date} className="border-t align-top">
                  <td className="px-4 py-1">{dayLabel(d.date)}</td>
                  <td>{d.punches.join(' ') || '—'}{d.resolvedBy.includes('corregir_checadas') && <span className="text-slate-400"> (corregidas)</span>}</td>
                  <td>{hm(d.paidMinutes)}{d.approvedExtraMinutes > 0 && <span className="text-green-700"> (+{hm(d.approvedExtraMinutes)} extra)</span>}</td>
                  <td>{d.issues.length === 0 ? <span className="text-green-700">OK</span> : d.issues.map(i => (
                    <span key={i} className={`mr-1 rounded px-1 ${d.pending.includes(i) ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500 line-through'}`}>
                      {ISSUE_LABEL[i]}{i === 'retardo' ? ` ${d.lateMinutes} min` : ''}{i === 'fuera_de_horario' ? ` ${d.outsideBlocks.map(b => `${b.start}–${b.end}`).join(', ')}` : ''}</span>))}
                    {d.excused && <span className="text-slate-500">justificada</span>}</td>
                  <td className="space-x-2 whitespace-nowrap pr-3 text-right">{canEdit && d.pending.length > 0 && <>
                    {(d.pending.includes('fuera_de_horario') || d.pending.includes('sin_horario')) && <button className="text-green-700" onClick={() => act(emp, d, 'aprobar_extra')}>Pagar extra</button>}
                    {d.pending.includes('falta') && <button className="text-brand" onClick={() => act(emp, d, 'justificar_falta')}>Justificar</button>}
                    {d.pending.includes('retardo') && <button className="text-brand" onClick={() => act(emp, d, 'quitar_retardo')}>Quitar retardo</button>}
                    <button className="text-brand" onClick={() => act(emp, d, 'corregir_checadas')}>Corregir</button>
                    <button className="text-slate-600" onClick={() => act(emp, d, 'aceptar')}>Dejar así</button></>}</td>
                </tr>))}</tbody>
            </table>
          </details>);
      })}
      {!loading && data.length === 0 && <p className="text-sm text-slate-500">No hay personal con horario o checadas en estas fechas.</p>}
    </div>
  );
}
