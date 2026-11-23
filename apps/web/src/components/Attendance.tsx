import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { parseCheckerSheet, mergeReports, RAW_SHEET_NAMES, type CheckerReport } from '@domain/checador';
import WorkSchedulePanel from './WorkSchedule';
import { suggestWeekly, ISSUE_LABEL, type ReviewKind, type ReviewedDay } from '@domain/attendance';
import { loadAttendance, addDays, type EmpLite, type EmpAttendance } from '../lib/attendanceData';
import { usePersisted } from '../lib/usePersisted';
import { Modal, TimeSelect } from './ui';

const field = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const btn = 'rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-60';
const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const dayLabel = (iso: string) => `${WD[new Date(iso + 'T12:00:00Z').getUTCDay()]} ${+iso.slice(8)}/${+iso.slice(5, 7)}`;
const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
type EmpDays = EmpAttendance;

interface Mapping { device_id: string; employee_id: string | null; ignored: boolean; label: string | null }

export default function Attendance() {
  const { companies, companyId } = useAuth();
  const [tab, setTab] = usePersisted<'subir' | 'revisar'>('asistencia:tab', 'subir');
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

function Review({ companyId }: { companyId: string }) {
  const { can } = useAuth();
  const t = new Date().toLocaleDateString('en-CA');
  // Se recuerda todo: al volver, quedas donde estabas (fechas, filtro y la persona abierta).
  const [range, setRange] = usePersisted<{ from: string; to: string } | null>(`asistencia:rango:${companyId}`, null);
  const from = range?.from ?? addDays(t, -15), to = range?.to ?? addDays(t, -1);
  const setFrom = (v: string) => setRange({ from: v, to }); const setTo = (v: string) => setRange({ from, to: v });
  const [onlyPending, setOnlyPending] = usePersisted('asistencia:soloPendiente', true);
  const [openId, setOpenId] = usePersisted<string | null>(`asistencia:abierto:${companyId}`, null);
  const [data, setData] = useState<EmpDays[]>([]); const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<{ from_date: string; to_date: string } | null>(null);

  useEffect(() => {
    supabase.from('checker_imports').select('from_date,to_date').order('created_at', { ascending: false }).limit(1)
      .then(({ data }) => { const r = data?.[0]; if (r) { setLastImport(r); if (!range) setRange({ from: r.from_date, to: r.to_date }); } });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const load = useCallback(async () => {
    if (from > to) return setMsg('La fecha inicial debe ser antes de la final.');
    setLoading(true); setMsg(null);
    try {
      const em = await supabase.from('employees').select('id,full_name,company_id,state').eq('company_id', companyId).eq('state', 'activo').order('full_name');
      if (em.error) throw em.error;
      const all = await loadAttendance(companyId, (em.data as EmpLite[]) ?? [], from, to);
      setData(all.filter(x => x.hasSchedule || x.days.some(d => d.punches.length)));
    } catch (e) { setMsg((e as Error).message); }
    setLoading(false);
  }, [companyId, from, to]);
  useEffect(() => { load(); }, [load]);

  const totals = data.filter(x => x.hasSchedule).reduce((n, x) => n + x.days.reduce((m, d) => m + d.pending.length, 0), 0);
  const noSchedule = data.filter(x => !x.hasSchedule).length;
  const current = data.find(x => x.emp.id === openId) ?? null;
  const visible = [...data].sort((a, b) => Number(a.hasSchedule) - Number(b.hasSchedule) || a.emp.full_name.localeCompare(b.emp.full_name))
    .filter(x => !onlyPending || !x.hasSchedule || x.days.some(d => d.pending.length));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-sm">
        <label className="text-xs">Desde<input type="date" className={`${field} block`} value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label className="text-xs">Hasta<input type="date" className={`${field} block`} value={to} onChange={e => setTo(e.target.value)} /></label>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={onlyPending} onChange={e => setOnlyPending(e.target.checked)} />Solo con pendientes</label>
        <span className="ml-auto text-right text-sm">{loading ? 'Calculando…' : <>
          {totals === 0 ? '✅ Sin excepciones pendientes' : <b className="text-amber-700">{totals} excepción(es) pendiente(s)</b>}
          {noSchedule > 0 && <span className="block text-xs text-amber-700">{noSchedule} persona(s) sin horario base</span>}</>}</span>
        {lastImport && <span className="w-full text-xs text-slate-400">Último reporte subido: {lastImport.from_date} al {lastImport.to_date}</span>}
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-100 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Empleado</th><th className="px-3 py-2">Horas pagables</th>
            <th className="px-3 py-2">Retardos</th><th className="px-3 py-2">Faltas</th><th className="px-3 py-2">Pendiente</th></tr></thead>
          <tbody>{visible.map(({ emp, hasSchedule, days }) => {
            const pend = days.filter(d => d.pending.length).length;
            return (
              <tr key={emp.id} className={`cursor-pointer border-t hover:bg-slate-50 ${openId === emp.id ? 'bg-brand/5' : ''}`} onClick={() => setOpenId(emp.id)}>
                <td className="px-3 py-2 font-medium text-brand">{emp.full_name}</td>
                <td className="px-3 py-2">{hm(days.reduce((n, d) => n + d.paidMinutes, 0))}</td>
                <td className="px-3 py-2">{days.filter(d => d.issues.includes('retardo')).length}</td>
                <td className="px-3 py-2">{days.filter(d => d.issues.includes('falta') && !d.excused).length}</td>
                <td className="px-3 py-2 text-xs">{!hasSchedule ? <span className="rounded-full bg-amber-100 px-2 text-amber-800">sin horario base</span>
                  : pend ? <span className="text-amber-700">{pend} día(s) por revisar</span> : <span className="text-green-700">revisado</span>}</td>
              </tr>);
          })}</tbody>
        </table>
        {!loading && visible.length === 0 && <p className="p-4 text-sm text-slate-500">{data.length ? 'Nada pendiente en estas fechas.' : 'No hay personal con horario o checadas en estas fechas.'}</p>}
      </div>
      {current && <EmployeeReview x={current} from={from} canEdit={can('payroll_hours', 'edit')} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

/** Ventana con los días de una persona y las acciones de revisión. */
function EmployeeReview({ x, from, canEdit, onClose, onChanged }: { x: EmpDays; from: string; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const { emp, hasSchedule, days, byDate } = x;
  const [all, setAll] = usePersisted('asistencia:todosLosDias', false);
  const [fix, setFix] = useState<ReviewedDay | null>(null);
  const [ask, setAsk] = useState<{ d: ReviewedDay; kind: ReviewKind } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const shown = days.filter(d => d.punches.length || d.scheduledMinutes || d.issues.length).filter(d => all || d.pending.length || d.notes.length);

  async function save(d: ReviewedDay, kind: ReviewKind, reason: string, times?: string[]) {
    setMsg(null);
    const { error } = await supabase.from('attendance_reviews').insert({ company_id: emp.company_id, employee_id: emp.id, date: d.date, kind, times: times ?? null, reason });
    if (error) setMsg(error.message); else { setFix(null); setAsk(null); onChanged(); }
  }

  return (
    <Modal wide onClose={onClose} title={<>{emp.full_name} <span className="text-sm font-normal text-slate-500">· {hm(days.reduce((n, d) => n + d.paidMinutes, 0))} h pagables</span></>}>
      {!hasSchedule && canEdit && (
        <div className="rounded-lg bg-amber-50 p-3">
          <p className="text-xs text-amber-800">Sin horario base el sistema no sabe qué horas pagar. Al guardarlo, se recalcula solo.</p>
          <WorkSchedulePanel employeeId={emp.id} companyId={emp.company_id} suggestion={suggestWeekly(byDate, 1)} onChange={onChanged} defaultFrom={from} />
        </div>)}
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />Ver todos los días (no solo los que tienen algo)</label>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      <table className="w-full text-left text-xs">
        <thead className="text-slate-500"><tr><th className="py-1">Día</th><th>Checadas</th><th>Pagable</th><th>Situación</th><th /></tr></thead>
        <tbody>{shown.map(d => (
          <tr key={d.date} className="border-t align-top">
            <td className="py-1.5">{dayLabel(d.date)}</td>
            <td>{d.punches.join(' ') || '—'}{d.resolvedBy.includes('corregir_checadas') && <span className="text-slate-400"> (corregidas)</span>}</td>
            <td>{hm(d.paidMinutes)}{d.approvedExtraMinutes > 0 && <span className="text-green-700"> (+{hm(d.approvedExtraMinutes)} extra)</span>}</td>
            <td>{d.issues.length === 0 && d.notes.length === 0 ? <span className="text-green-700">OK</span> : d.issues.map(i => (
              <span key={i} className={`mr-1 rounded px-1 ${d.pending.includes(i) ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500 line-through'}`}>
                {ISSUE_LABEL[i]}{i === 'retardo' ? ` ${d.lateMinutes} min` : ''}{i === 'fuera_de_horario' ? ` ${d.outsideBlocks.map(b => `${b.start}–${b.end}`).join(', ')}` : ''}</span>))}
              {d.notes.map((n, k) => <span key={k} className="mr-1 rounded bg-blue-50 px-1 text-blue-700">{n}</span>)}
              {d.excused && <span className="text-slate-500">justificada</span>}</td>
            <td className="space-x-2 whitespace-nowrap text-right">{canEdit && <>
              {(d.pending.includes('fuera_de_horario') || d.pending.includes('sin_horario')) && <button className="text-green-700" onClick={() => setAsk({ d, kind: 'aprobar_extra' })}>Pagar extra</button>}
              {d.pending.includes('falta') && <button className="text-brand" onClick={() => setAsk({ d, kind: 'justificar_falta' })}>Justificar</button>}
              {d.pending.includes('retardo') && <button className="text-brand" onClick={() => setAsk({ d, kind: 'quitar_retardo' })}>Quitar retardo</button>}
              <button className="text-brand" onClick={() => setFix(d)}>Corregir</button>
              {d.pending.length > 0 && <button className="text-slate-600" onClick={() => setAsk({ d, kind: 'aceptar' })}>Dejar así</button>}</>}</td>
          </tr>))}
          {shown.length === 0 && <tr><td colSpan={5} className="py-3 text-slate-500">Nada pendiente. Marca "Ver todos los días" para revisar o corregir cualquier día.</td></tr>}
        </tbody>
      </table>
      {fix && <FixPunches d={fix} name={emp.full_name} onCancel={() => setFix(null)} onSave={(times, reason) => save(fix, 'corregir_checadas', reason, times)} />}
      {ask && <Reason kind={ask.kind} d={ask.d} onCancel={() => setAsk(null)} onSave={reason => save(ask.d, ask.kind, reason)} />}
    </Modal>
  );
}

const REASONS: Record<ReviewKind, string[]> = {
  aprobar_extra: ['Clase extra', 'Curso', 'Competencia', 'Cubrió a otro coach'],
  justificar_falta: ['Permiso', 'Incapacidad', 'Vacaciones', 'Día festivo'],
  quitar_retardo: ['Autorizado por dirección', 'Falla del checador', 'Actividad de la escuela'],
  aceptar: ['Revisado, está correcto'],
  corregir_checadas: ['Olvidó checar', 'Falla del checador', 'Checó de más'],
};
const TITLES: Record<ReviewKind, string> = { aprobar_extra: 'Pagar trabajo fuera de horario', justificar_falta: 'Justificar falta',
  quitar_retardo: 'Quitar retardo', aceptar: 'Dejar así', corregir_checadas: 'Corregir checadas' };

function Reason({ kind, d, onCancel, onSave }: { kind: ReviewKind; d: ReviewedDay; onCancel: () => void; onSave: (r: string) => void }) {
  const [r, setR] = useState(REASONS[kind][0]);
  return (
    <Modal title={`${TITLES[kind]} · ${dayLabel(d.date)}`} onClose={onCancel}>
      <div className="flex flex-wrap gap-2">{REASONS[kind].map(x => <button key={x} type="button" onClick={() => setR(x)}
        className={`rounded-full border px-3 py-1 text-sm ${r === x ? 'border-brand bg-brand/10 text-brand' : ''}`}>{x}</button>)}</div>
      <label className="block text-xs">Motivo (queda registrado)<input className={`${field} w-full`} value={r} onChange={e => setR(e.target.value)} /></label>
      <div className="flex gap-2"><button className={btn} disabled={!r.trim()} onClick={() => onSave(r.trim())}>Guardar</button><button className="text-sm" onClick={onCancel}>Cancelar</button></div>
    </Modal>
  );
}

function FixPunches({ d, name, onCancel, onSave }: { d: ReviewedDay; name: string; onCancel: () => void; onSave: (times: string[], reason: string) => void }) {
  const [times, setTimes] = useState<string[]>(d.punches.length ? [...d.punches] : ['16:00', '20:00']);
  const [reason, setReason] = useState(REASONS.corregir_checadas[0]);
  const odd = times.length % 2 === 1;
  return (
    <Modal title={`Corregir checadas · ${name} · ${dayLabel(d.date)}`} onClose={onCancel}>
      <p className="text-xs text-slate-500">Cada par es una entrada y una salida. Las horas se eligen de 15 en 15; si la checada real era otra (16:04), se conserva.</p>
      <div className="space-y-2">{Array.from({ length: Math.ceil(times.length / 2) }, (_, k) => (
        <div key={k} className="flex items-center gap-2 text-sm">
          <span className="w-16 text-xs text-slate-500">Bloque {k + 1}</span>
          Entrada <TimeSelect value={times[2 * k]} onChange={v => setTimes(times.map((t, i) => i === 2 * k ? v : t))} />
          Salida {times[2 * k + 1] !== undefined ? <TimeSelect value={times[2 * k + 1]} onChange={v => setTimes(times.map((t, i) => i === 2 * k + 1 ? v : t))} />
            : <button className="text-xs text-brand" onClick={() => setTimes([...times, '20:00'])}>+ agregar salida</button>}
          <button aria-label="Quitar bloque" className="text-red-700" onClick={() => setTimes(times.filter((_, i) => i !== 2 * k && i !== 2 * k + 1))}>×</button>
        </div>))}</div>
      <button className="text-xs text-brand" onClick={() => setTimes(odd ? [...times, '20:00'] : [...times, '06:00', '08:00'])}>{odd ? '+ agregar salida' : '+ agregar bloque'}</button>
      <label className="block text-xs">Motivo<select className={`${field} w-full`} value={reason} onChange={e => setReason(e.target.value)}>{REASONS.corregir_checadas.map(r => <option key={r}>{r}</option>)}</select></label>
      {odd && <p className="text-xs text-amber-700">Falta una salida.</p>}
      <div className="flex gap-2"><button className={btn} onClick={() => onSave([...times].sort(), reason)}>Guardar corrección</button><button className="text-sm" onClick={onCancel}>Cancelar</button></div>
    </Modal>
  );
}
