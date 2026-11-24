import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { formatMXN } from '../lib/money';
import { loadAttendance, addDays, type EmpLite } from '../lib/attendanceData';
import { effectiveFor, toConfig, type Schedule } from './Companies';
import { periodsBetween } from '@domain/pay-calendar';
import { computePeriodLine, recomputeLine, type PeriodLine } from '@domain/period-payroll';
import { usePersisted } from '../lib/usePersisted';
import { Modal, HALF_HOURS } from './ui';
import type { Concept } from '@domain/concepts';
import type { Deduction } from '@domain/deductions';
import { loanLinesForPeriod, type Loan, type LoanSkip } from '@domain/loans';

const btn = 'rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60';
const btn2 = 'rounded-lg border px-3 py-1.5 text-sm disabled:opacity-60';
const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const fdate = (iso: string) => `${WD[new Date(iso + 'T12:00:00Z').getUTCDay()]} ${+iso.slice(8)}/${+iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const STATUS: Record<string, string> = { borrador: 'Borrador', en_revision: 'Publicada a empleados', autorizada: 'Autorizada', cancelada: 'Cancelada' };

type Detail = PeriodLine['detail'];
interface Run { id: string; company_id: string; period_start: string; period_end: string; nominal_pay_date: string; status: string;
  current_version: number; authorized_version: number | null; authorized_at: string | null }
interface Line { employee_id: string; pay_date: string; gross_cents: number; deduction_cents: number; net_cents: number; reported_cents: number | null; detail: Detail }
interface Version { version: number; note: string; restored_from: number | null; created_at: string; created_by: string }
interface Conf { employee_id: string; version: number; decision: 'confirmada' | 'observacion'; comment: string | null; created_at: string }
interface PeriodOpt { start: string; end: string; nominal: string; emps: { emp: EmpLite; payDate: string }[] }

export default function Payroll() {
  const { can, companyId } = useAuth();
  return (
    <div className="space-y-6">
      {can('payroll') && (companyId === 'all'
        ? <p className="rounded-xl border border-dashed bg-white p-4 text-sm text-slate-500">Elige una sucursal en el selector de arriba: cada sucursal calcula y autoriza su nómina por separado.</p>
        : <PayrollAdmin companyId={companyId} />)}
      <MyPayroll />
    </div>
  );
}

// ---------------------------------------------------------------------------
function PayrollAdmin({ companyId }: { companyId: string }) {
  const { can, user } = useAuth();
  const [emps, setEmps] = useState<EmpLite[]>([]);
  const [scheds, setScheds] = useState<Schedule[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sel, setSel] = usePersisted<string>(`nomina:periodo:${companyId}`, '');
  const [msg, setMsg] = useState<string | null>(null);

  const loadBase = useCallback(async () => {
    setMsg(null);
    const [e, s, r] = await Promise.all([
      supabase.from('employees').select('id,full_name,company_id,state,work_days,department_id,group_id').eq('company_id', companyId).eq('state', 'activo').order('full_name'),
      supabase.from('pay_schedules').select('*').eq('company_id', companyId),
      supabase.from('payroll_runs').select('*').eq('company_id', companyId).neq('status', 'cancelada').order('period_start', { ascending: false }),
    ]);
    const err = e.error ?? s.error ?? r.error; if (err) setMsg(err.message);
    setEmps((e.data as EmpLite[]) ?? []); setScheds((s.data as Schedule[]) ?? []); setRuns((r.data as Run[]) ?? []);
  }, [companyId]);
  useEffect(() => { loadBase(); }, [loadBase]);

  // Periodos recientes según el calendario de cada persona (semanal, quincenal…).
  const periods = useMemo(() => {
    const t = new Date().toLocaleDateString('en-CA'); const map = new Map<string, PeriodOpt>();
    for (const emp of emps) {
      const sch = effectiveFor(scheds, { id: emp.id, department_id: emp.department_id ?? '', group_id: emp.group_id ?? null }, t);
      if (!sch) continue;
      for (const p of periodsBetween(toConfig(sch, emp.work_days), addDays(t, -50), addDays(t, 20))) {
        const k = `${p.start}|${p.end}`;
        const o = map.get(k) ?? { start: p.start, end: p.end, nominal: p.nominal, emps: [] };
        o.emps.push({ emp, payDate: p.payDate }); map.set(k, o);
      }
    }
    return [...map.values()].sort((a, b) => b.nominal.localeCompare(a.nominal));
  }, [emps, scheds]);

  const selected = periods.find(p => `${p.start}|${p.end}` === sel) ?? null;
  const run = selected ? runs.find(r => r.period_start === selected.start && r.period_end === selected.end) ?? null : null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-sm">
        <label className="text-xs">Periodo
          <select className="block rounded-lg border border-slate-300 px-2 py-1.5 text-sm" value={sel} onChange={e => setSel(e.target.value)}>
            <option value="">Elige un periodo…</option>
            {periods.map(p => {
              const r = runs.find(x => x.period_start === p.start && x.period_end === p.end);
              return <option key={`${p.start}|${p.end}`} value={`${p.start}|${p.end}`}>
                Pago {fdate(p.nominal)} · trabajo {p.start.slice(8)}/{p.start.slice(5, 7)}–{p.end.slice(8)}/{p.end.slice(5, 7)} · {p.emps.length} persona(s){r ? ` · ${STATUS[r.status]}` : ''}</option>;
            })}
          </select></label>
        {periods.length === 0 && <span className="text-sm text-slate-500">No hay periodos: revisa que la sucursal tenga calendario de pago.</span>}
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {selected && <RunPanel key={sel} companyId={companyId} period={selected} run={run} onChanged={loadBase}
        canEdit={can('payroll', 'edit')} canAuth={can('payroll', 'authorize')} isDirector={user?.role === 'director'} />}
    </section>
  );
}

function RunPanel({ companyId, period, run, onChanged, canEdit, canAuth, isDirector }:
  { companyId: string; period: PeriodOpt; run: Run | null; onChanged: () => void; canEdit: boolean; canAuth: boolean; isDirector: boolean }) {
  const [lines, setLines] = useState<Line[]>([]); const [versions, setVersions] = useState<Version[]>([]); const [confs, setConfs] = useState<Conf[]>([]);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [info, setInfo] = useState<string | null>(null);
  const [open, setOpen] = usePersisted<string | null>(`nomina:abierto:${period.start}:${period.end}`, null); const [showVersions, setShowVersions] = useState(false);
  const names = useMemo(() => Object.fromEntries(period.emps.map(x => [x.emp.id, x.emp.full_name])), [period]);

  const load = useCallback(async () => {
    if (!run) { setLines([]); setVersions([]); setConfs([]); return; }
    const [l, v, c] = await Promise.all([
      supabase.from('payroll_lines').select('employee_id,pay_date,gross_cents,deduction_cents,net_cents,reported_cents,detail').eq('run_id', run.id).eq('version', run.current_version),
      supabase.from('payroll_versions').select('version,note,restored_from,created_at,created_by').eq('run_id', run.id).order('version', { ascending: false }),
      supabase.from('payroll_confirmations').select('employee_id,version,decision,comment,created_at').eq('run_id', run.id).order('created_at', { ascending: false }),
    ]);
    const err = l.error ?? v.error ?? c.error; if (err) setMsg(err.message);
    setLines((l.data as Line[]) ?? []); setVersions((v.data as Version[]) ?? []); setConfs((c.data as Conf[]) ?? []);
  }, [run]);
  useEffect(() => { load(); }, [load]);

  async function calculate() {
    setBusy(true); setMsg(null); setInfo(null);
    try {
      const ids = period.emps.map(x => x.emp.id);
      const [att, cc, xe, dd, ln, wu] = await Promise.all([
        loadAttendance(companyId, period.emps.map(x => x.emp), period.start, period.end),
        supabase.from('compensation_concepts').select('employee_id,concept_key,label,kind,amount_cents,weekdays,active,effective_from,created_at')
          .in('employee_id', ids).is('annulled_at', null).lte('effective_from', period.end).order('effective_from', { ascending: false }).order('created_at', { ascending: false }),
        supabase.from('extra_earnings').select('id,employee_id,label,amount_cents,kind,start_date,end_date,status').in('employee_id', ids).eq('status', 'autorizado'),
        supabase.from('deductions').select('id,employee_id,label,amount_cents,kind,start_date,end_date,status').in('employee_id', ids).eq('status', 'autorizado'),
        supabase.from('loans').select('id,employee_id,lender,principal_cents,interest_cents,installment_cents,start_date,status').in('employee_id', ids).eq('status', 'activo'),
        supabase.from('warmup_latest').select('employee_id,date,active').in('employee_id', ids).gte('date', period.start).lte('date', period.end),
      ]);
      const err = cc.error ?? xe.error ?? dd.error ?? ln.error ?? wu.error; if (err) throw err;
      const coachDepts = new Set(((await supabase.from('departments').select('id,name').eq('company_id', companyId)).data as { id: string; name: string }[] ?? [])
        .filter(d => d.name.trim().toLowerCase() === 'coach').map(d => d.id));
      const cfg = (await supabase.from('companies').select('late_deduction_bps,warmup_deduction_min').eq('id', companyId).single()).data as { late_deduction_bps: number; warmup_deduction_min: number } | null;
      const noWarm = new Set(((wu.data ?? []) as { employee_id: string; date: string; active: boolean }[]).filter(w => !w.active).map(w => `${w.employee_id}|${w.date}`));
      type LoanRow = { id: string; employee_id: string; lender: 'empresa' | 'director'; principal_cents: number; interest_cents: number; installment_cents: number; start_date: string; status: Loan['status'] };
      const loanRows = (ln.data as LoanRow[]) ?? [];
      const loanIds = loanRows.map(l => l.id);
      const [lp, ls] = loanIds.length ? await Promise.all([
        supabase.from('loan_payments').select('loan_id,amount_cents').in('loan_id', loanIds),
        supabase.from('loan_skips').select('loan_id,skip_date,status').in('loan_id', loanIds),
      ]) : [{ data: [], error: null }, { data: [], error: null }];
      if (lp.error || ls.error) throw (lp.error ?? ls.error)!;
      const paid = (id: string) => ((lp.data ?? []) as { loan_id: string; amount_cents: number }[]).filter(p => p.loan_id === id).reduce((n, p) => n + BigInt(p.amount_cents), 0n);
      const skips: LoanSkip[] = ((ls.data ?? []) as { loan_id: string; skip_date: string; status: LoanSkip['status'] }[]).map(s => ({ loanId: s.loan_id, date: s.skip_date, status: s.status }));
      const pending = att.reduce((n, a) => n + (a.hasSchedule ? a.days.reduce((m, d) => m + d.pending.length, 0) : 0), 0);
      const noSched = att.filter(a => !a.hasSchedule).map(a => a.emp.full_name);
      if ((pending || noSched.length) && !window.confirm(`Antes de calcular:\n${pending ? `• ${pending} excepción(es) de asistencia sin revisar\n` : ''}${noSched.length ? `• Sin horario base: ${noSched.join(', ')}\n` : ''}\nLo pendiente se calcula como está (faltas sin justificar, extras sin pagar). ¿Calcular de todos modos?`)) { setBusy(false); return; }

      type CC = { employee_id: string; concept_key: string; label: string; kind: Concept['kind']; amount_cents: number; weekdays: number[]; active: boolean };
      type Adj = { id: string; employee_id: string; label: string; amount_cents: number; kind: 'unico' | 'recurrente'; start_date: string; end_date: string | null; status: Deduction['status'] };
      const toDed = (a: Adj): Deduction => ({ id: a.id, label: a.label, amountCents: BigInt(a.amount_cents), kind: a.kind, startDate: a.start_date, endDate: a.end_date, status: a.status });
      const out = period.emps.map(({ emp, payDate }) => {
        const seen = new Set<string>(); const concepts: Concept[] = [];
        for (const c of (cc.data as CC[]).filter(c => c.employee_id === emp.id)) {     // vigente = el más reciente por concepto
          if (seen.has(c.concept_key)) continue; seen.add(c.concept_key);
          if (c.active) concepts.push({ key: c.concept_key, label: c.label, kind: c.kind, amountCents: BigInt(c.amount_cents), weekdays: c.weekdays });
        }
        const a = att.find(x => x.emp.id === emp.id)!;
        const line = computePeriodLine({
          period: { start: period.start, end: period.end }, payDate, lateDeductionBps: cfg?.late_deduction_bps ?? 2500, warmupDeductionMin: cfg?.warmup_deduction_min ?? 30, concepts,
          warmupApplies: coachDepts.has(emp.department_id ?? ''),
          days: a.days.map(d => ({ date: d.date, paidMinutes: d.paidMinutes, attended: d.attended, excused: d.excused,
            late: d.issues.includes('retardo'), scheduled: d.scheduledMinutes > 0, warmupInactive: noWarm.has(`${emp.id}|${d.date}`) })),
          extras: (xe.data as Adj[]).filter(x => x.employee_id === emp.id).map(toDed),
          deductions: (dd.data as Adj[]).filter(x => x.employee_id === emp.id).map(toDed),
          loanLines: loanLinesForPeriod(loanRows.filter(l => l.employee_id === emp.id).map(l => ({
            id: l.id, label: l.lender === 'director' ? 'Préstamo personal del director' : 'Préstamo de la empresa', lender: l.lender,
            totalCents: BigInt(l.principal_cents) + BigInt(l.interest_cents), paidCents: paid(l.id), installmentCents: BigInt(l.installment_cents),
            startDate: l.start_date, status: l.status })), skips, { start: period.start, end: period.end }),
        });
        if (a.days.some(d => d.pending.length) || !a.hasSchedule) line.detail.warnings.push('Tenía asistencia sin revisar al calcular.');
        return { employee_id: emp.id, pay_date: line.payDate, gross_cents: line.grossCents.toString(), deduction_cents: line.deductionCents.toString(),
          net_cents: line.netCents.toString(), reported_cents: line.reportedCents.toString(), detail: line.detail };
      });
      const totals = { net: out.reduce((n, l) => n + BigInt(l.net_cents), 0n).toString(), people: out.length };
      const note = run ? window.prompt('¿Qué cambió en este recálculo? (queda en el historial de versiones)', 'Recálculo') : 'Cálculo inicial';
      if (note === null || !note.trim()) { setBusy(false); return; }
      let runId = run?.id;
      if (!runId) {
        const r = await supabase.from('payroll_runs').insert({ company_id: companyId, period_start: period.start, period_end: period.end, nominal_pay_date: period.nominal }).select('id').single();
        if (r.error) throw r.error; runId = r.data.id;
      }
      const v = await supabase.rpc('save_payroll_version', { p_run: runId, p_note: note.trim(), p_lines: out, p_totals: totals });
      if (v.error) throw v.error;
      setInfo(`Versión ${v.data} guardada.`); onChanged();
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }

  async function status(action: 'publicar' | 'autorizar' | 'reabrir' | 'cancelar') {
    if (!run) return;
    const texts = {
      publicar: 'Publicar a los empleados: cada quien verá SOLO su nómina y podrá confirmarla u observarla hasta las 18:00 de su día de pago. ¿Continuar?',
      autorizar: `Autorizar la versión ${run.current_version}. Después nadie la puede modificar (solo el director puede reabrirla). ¿Autorizar?`,
      reabrir: 'Reabrir la nómina autorizada para corregirla. Queda registrado. ¿Reabrir?',
      cancelar: 'Cancelar esta nómina (no se borra; queda en el historial). ¿Cancelar?' };
    if (!window.confirm(texts[action])) return;
    setBusy(true); setMsg(null);
    const { error } = await supabase.rpc('set_payroll_status', { p_run: run.id, p_action: action });
    setBusy(false);
    if (error) setMsg(error.message); else onChanged();
  }

  async function restore(v: number) {
    if (!run || !window.confirm(`Restaurar la versión ${v}: se crea una versión nueva igual a la ${v}. La actual no se pierde. ¿Continuar?`)) return;
    setBusy(true);
    const { error } = await supabase.rpc('restore_payroll_version', { p_run: run.id, p_version: v, p_note: '' });
    setBusy(false);
    if (error) setMsg(error.message); else { setInfo(`Restaurada la versión ${v}.`); onChanged(); }
  }

  const conf = (id: string) => confs.find(c => c.employee_id === id && c.version === run?.current_version);
  const [editing, setEditing] = useState(false);
  const openLine = lines.find(l => l.employee_id === open) ?? null;
  useEffect(() => { setEditing(false); }, [open]);

  /** Edición a mano: se recalcula la línea con los mismos datos y se guarda TODO como versión nueva. */
  async function saveEdit(updated: Line, note: string) {
    if (!run) return;
    setBusy(true); setMsg(null);
    const out = lines.map(l => {
      const x = l.employee_id === updated.employee_id ? updated : l;
      return { employee_id: x.employee_id, pay_date: x.pay_date, gross_cents: String(x.gross_cents), deduction_cents: String(x.deduction_cents),
        net_cents: String(x.net_cents), reported_cents: x.reported_cents == null ? null : String(x.reported_cents), detail: x.detail };
    });
    const totals = { net: out.reduce((n, l) => n + BigInt(l.net_cents), 0n).toString(), people: out.length };
    const v = await supabase.rpc('save_payroll_version', { p_run: run.id, p_note: note, p_lines: out, p_totals: totals });
    setBusy(false);
    if (v.error) return setMsg(v.error.message);
    setEditing(false); setInfo(`Versión ${v.data} guardada (${note}).`); onChanged();
  }
  const editable = !run || run.status === 'borrador' || run.status === 'en_revision';
  const total = lines.reduce((n, l) => n + BigInt(l.net_cents), 0n);
  const confirmed = lines.filter(l => conf(l.employee_id)?.decision === 'confirmada').length;
  const observed = lines.filter(l => conf(l.employee_id)?.decision === 'observacion').length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-4 shadow-sm">
        <div className="text-sm">
          <p><b>Trabajo del {fdate(period.start)} al {fdate(period.end)}</b> · pago nominal {fdate(period.nominal)}</p>
          <p className="text-xs text-slate-500">{run ? <>Estado: <b>{STATUS[run.status]}</b> · versión {run.current_version}{run.status === 'en_revision' && <> · {confirmed} confirmada(s), {observed} con observación, {lines.length - confirmed - observed} sin confirmar</>}</> : 'Aún no calculada'}</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {canEdit && editable && <button disabled={busy} className={btn} onClick={calculate}>{run ? 'Recalcular (nueva versión)' : 'Calcular nómina'}</button>}
          {run && run.current_version > 0 && <button className={btn2} onClick={() => setShowVersions(!showVersions)}>Versiones ({versions.length})</button>}
          {canEdit && run?.status === 'borrador' && run.current_version > 0 && <button disabled={busy} className={btn2} onClick={() => status('publicar')}>Publicar a empleados</button>}
          {canAuth && run && editable && run.current_version > 0 && <button disabled={busy} className={`${btn2} border-green-600 text-green-700`} onClick={() => status('autorizar')}>Autorizar</button>}
          {isDirector && run?.status === 'autorizada' && <button disabled={busy} className={btn2} onClick={() => status('reabrir')}>Reabrir</button>}
          {canEdit && run && editable && <button disabled={busy} className={`${btn2} text-red-700`} onClick={() => status('cancelar')}>Cancelar</button>}
        </div>
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {info && <p className="rounded bg-green-50 p-2 text-sm text-green-800">{info}</p>}

      {showVersions && (
        <div className="rounded-xl bg-white p-4 text-sm shadow-sm">
          <p className="mb-2 font-medium">Historial de versiones (respaldo)</p>
          {versions.map(v => (
            <div key={v.version} className="flex items-center gap-3 border-t py-1.5 text-xs">
              <b>v{v.version}</b><span>{v.created_at.slice(0, 16).replace('T', ' ')}</span><span>{v.note}</span>
              {v.restored_from && <span className="text-slate-400">(copia de v{v.restored_from})</span>}
              {v.version === run?.current_version ? <span className="ml-auto text-green-700">vigente</span>
                : canEdit && editable && <button className="ml-auto text-brand" onClick={() => restore(v.version)}>Restaurar</button>}
            </div>))}
        </div>)}

      {openLine && (
        <Modal wide onClose={() => setOpen(null)} title={<>{names[openLine.employee_id] ?? '—'} <span className="text-sm font-normal text-slate-500">· pago {fdate(openLine.pay_date)}</span></>}>
          {editing && run?.status === 'borrador'
            ? <LineEditor line={openLine} period={period} onCancel={() => setEditing(false)} onSave={saveEdit} busy={busy} />
            : <>
              <LineDetail line={openLine} />
              {canEdit && run?.status === 'borrador' && <button className={btn} onClick={() => setEditing(true)}>Editar esta nómina</button>}
              {canEdit && run?.status === 'en_revision' && <p className="text-xs text-slate-500">Ya está publicada a empleados. Para editar a mano, recalcula (se crea versión nueva) o pide al director que la regrese.</p>}
            </>}
        </Modal>)}
      {lines.length > 0 && (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-500"><tr>
              <th className="px-3 py-2">Empleado</th><th className="px-3 py-2">Pago</th><th className="px-3 py-2">Días / horas</th>
              <th className="px-3 py-2 text-right">Percepciones</th><th className="px-3 py-2 text-right">Descuentos</th><th className="px-3 py-2 text-right">Neto</th><th className="px-3 py-2">Empleado revisó</th></tr></thead>
            <tbody>
              {[...lines].sort((a, b) => (names[a.employee_id] ?? '').localeCompare(names[b.employee_id] ?? '')).map(l => {
                const c = conf(l.employee_id);
                return [
                  <tr key={l.employee_id} className="cursor-pointer border-t hover:bg-slate-50" onClick={() => setOpen(l.employee_id)}>
                    <td className="px-3 py-2 font-medium"><span className="mr-1 text-xs text-brand">▸</span>{names[l.employee_id] ?? '—'}{l.detail.warnings.length > 0 && <span title={l.detail.warnings.join('\n')} className="ml-1 text-amber-600">⚠</span>}</td>
                    <td className="px-3 py-2 text-xs">{fdate(l.pay_date)}</td>
                    <td className="px-3 py-2 text-xs">{l.detail.attendedDays} días · {hm(l.detail.paidMinutes)} h{l.detail.retardos ? ` · ${l.detail.retardos} ret.` : ''}{l.detail.faltas ? ` · ${l.detail.faltas} faltas` : ''}</td>
                    <td className="px-3 py-2 text-right">{formatMXN(l.gross_cents)}</td><td className="px-3 py-2 text-right">{formatMXN(l.deduction_cents)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{formatMXN(l.net_cents)}</td>
                    <td className="px-3 py-2 text-xs">{!c ? <span className="text-slate-400">sin confirmar</span> : c.decision === 'confirmada' ? <span className="text-green-700">✓ confirmó</span>
                      : <span className="text-amber-700" title={c.comment ?? ''}>Observación: {c.comment}</span>}</td>
                  </tr>,
                ];
              })}
              <tr className="border-t bg-slate-50 font-semibold"><td className="px-3 py-2" colSpan={5}>Total ({lines.length} personas)</td><td className="px-3 py-2 text-right">{formatMXN(total)}</td><td /></tr>
            </tbody>
          </table>
        </div>)}
    </div>
  );
}

/** Desglose como en el Excel: tabla por día (Día · Horas · Faltas) y resumen de la nómina. */
function LineDetail({ line }: { line: Line }) {
  const d = line.detail;
  const days = d.days ?? [];                       // versiones anteriores a este desglose no lo traen
  const conceptsTotal = d.concepts.reduce((n, c) => n + BigInt(c.amount), 0n);
  const extras = d.extras.reduce((n, x) => n + BigInt(x.amount), 0n);
  const late = BigInt(d.lateDeduction?.total ?? '0');
  const other = d.deductions.reduce((n, x) => n + BigInt(x.amount), 0n);
  const loans = BigInt(d.loans ?? '0');
  const row = (label: string, value: React.ReactNode, strong = false) => (
    <tr className={`border-t ${strong ? 'font-semibold' : ''}`}><td className="py-1.5">{label}</td><td className="py-1.5 text-right">{value}</td></tr>);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <table className="w-full text-xs">
          <thead><tr className="bg-slate-200 text-slate-700"><th className="px-2 py-1.5 text-left">Día</th><th className="px-2 py-1.5 text-right">Horas</th><th className="px-2 py-1.5 text-left">Faltas</th></tr></thead>
          <tbody>
            {days.length === 0 && <tr><td colSpan={3} className="px-2 py-2 text-slate-400">Recalcula para ver el desglose por día.</td></tr>}
            {days.map(x => (
              <tr key={x.date} className="border-t bg-white">
                <td className="px-2 py-1">{fdate(x.date)}</td>
                <td className="px-2 py-1 text-right">{(x.minutes / 60).toFixed(2)}</td>
                <td className={`px-2 py-1 ${x.status === 'Falta' ? 'text-red-700' : x.status === 'Tarde' ? 'text-amber-700' : 'text-slate-500'}`}>{x.status || '—'}{x.warmupInactive && <span className="ml-1 text-amber-700">· sin calentamiento</span>}</td>
              </tr>))}
          </tbody>
        </table>
        {d.concepts.length > 0 && <div className="mt-2 text-xs text-slate-600">{d.concepts.map(c => <p key={c.key}>{c.label}: {formatMXN(c.amount)} <span className="text-slate-400">({c.detail})</span></p>)}</div>}
      </div>
      <table className="w-full self-start text-sm">
        <thead><tr className="text-left"><th className="pb-1">Concepto</th><th className="pb-1 text-right">Importe</th></tr></thead>
        <tbody>
          {row('Total días', d.attendedDays)}
          {row('Total horas', (d.paidMinutes / 60).toFixed(2))}
          {row('Faltas / retardos', `${d.faltas} / ${d.retardos}`)}
          {row('Nómina', formatMXN(conceptsTotal))}
          {extras > 0n && d.extras.map((x, i) => <tr key={'x' + i} className="border-t"><td className="py-1.5">+ {x.label}</td><td className="py-1.5 text-right">{formatMXN(x.amount)}</td></tr>)}
          {row('Rebajas por retardos', late ? `−${formatMXN(late)}` : formatMXN(0))}
          {d.warmup && row(`Calentamiento no activo (${d.warmup.days} día(s))`, `−${formatMXN(d.warmup.total)}`)}
          {(d.manual ?? []).map((m, i) => <tr key={'m' + i} className="border-t"><td className="py-1.5">{BigInt(m.amount) > 0n ? '+' : '−'} {m.label} <span className="text-xs text-slate-400">(a mano)</span></td><td className="py-1.5 text-right">{formatMXN(m.amount)}</td></tr>)}
          {other > 0n && d.deductions.map((x, i) => <tr key={'d' + i} className="border-t"><td className="py-1.5">− {x.label}</td><td className="py-1.5 text-right">−{formatMXN(x.amount)}</td></tr>)}
          {row('Préstamos', loans ? `−${formatMXN(loans)}` : formatMXN(0))}
          {(d.loanLines ?? []).map(l => <tr key={l.loan_id}><td colSpan={2} className="pb-1 pl-3 text-xs text-slate-500">{l.label}: {l.skipped ? 'este periodo se salta (autorizado por el director)' : `−${formatMXN(l.amount)} · saldo después: ${formatMXN(l.balance_after)}`}</td></tr>)}
          {row('Nómina neta', formatMXN(line.net_cents), true)}
          {row('Nómina reportada', line.reported_cents == null ? '—' : formatMXN(line.reported_cents))}
          {d.excused > 0 && <tr><td colSpan={2} className="pt-1 text-xs text-slate-500">{d.excused} falta(s) justificada(s)</td></tr>}
          {d.warnings.map((w, i) => <tr key={'w' + i}><td colSpan={2} className="pt-1 text-xs text-amber-700">⚠ {w}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
/** Lo que ve cada empleado: solo SU nómina publicada, y la confirma u observa hasta las 18:00 de su día de pago. */
function MyPayroll() {
  const [items, setItems] = useState<{ run: Run; line: Line; conf: Conf | null; employee_id: string }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const me = await supabase.from('employees').select('id').eq('user_id', user.id).maybeSingle();
    if (!me.data) { setItems([]); return; }
    const empId = (me.data as { id: string }).id;
    const runs = await supabase.from('payroll_runs').select('*').in('status', ['en_revision', 'autorizada']).order('nominal_pay_date', { ascending: false }).limit(6);
    if (runs.error) return setMsg(runs.error.message);
    const out = [];
    for (const r of (runs.data as Run[]) ?? []) {
      const l = await supabase.from('payroll_lines').select('employee_id,pay_date,gross_cents,deduction_cents,net_cents,reported_cents,detail')
        .eq('run_id', r.id).eq('version', r.current_version).eq('employee_id', empId).maybeSingle();
      if (!l.data) continue;
      const c = await supabase.from('payroll_confirmations').select('employee_id,version,decision,comment,created_at')
        .eq('run_id', r.id).eq('employee_id', empId).eq('version', r.current_version).order('created_at', { ascending: false }).limit(1);
      out.push({ run: r, line: l.data as Line, conf: ((c.data as Conf[]) ?? [])[0] ?? null, employee_id: empId });
    }
    setItems(out);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function answer(it: typeof items[number], decision: 'confirmada' | 'observacion') {
    let comment: string | null = null;
    if (decision === 'observacion') {
      comment = window.prompt('¿Qué no está bien? (lo verá el nominista)');
      if (!comment?.trim()) return;
    } else if (!window.confirm(`Confirmo que mi nómina de ${formatMXN(it.line.net_cents)} es correcta.`)) return;
    const { error } = await supabase.from('payroll_confirmations').insert({ run_id: it.run.id, version: it.run.current_version, employee_id: it.employee_id, decision, comment });
    if (error) setMsg(error.message); else load();
  }

  if (items.length === 0) return null;
  const deadline = (payDate: string) => new Date(`${payDate}T18:00:00-06:00`);
  return (
    <section className="space-y-2">
      <h3 className="font-semibold">Mi nómina</h3>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}
      {items.map(it => {
        const open = it.run.status === 'en_revision' && new Date() < deadline(it.line.pay_date);
        return (
          <div key={it.run.id} className="space-y-2 rounded-xl bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <b>Pago del {fdate(it.line.pay_date)}</b><span className="text-xs text-slate-500">trabajo del {fdate(it.run.period_start)} al {fdate(it.run.period_end)}</span>
              <span className="ml-auto text-lg font-semibold">{formatMXN(it.line.net_cents)}</span>
            </div>
            <LineDetail line={it.line} />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {it.run.status === 'autorizada' ? <span className="text-green-700">Autorizada</span>
                : it.conf ? <span className={it.conf.decision === 'confirmada' ? 'text-green-700' : 'text-amber-700'}>{it.conf.decision === 'confirmada' ? '✓ La confirmaste' : `Dejaste una observación: ${it.conf.comment}`}</span>
                : <span className="text-slate-500">Pendiente de tu revisión</span>}
              {open && <span className="ml-auto flex gap-2">
                <button className={btn} onClick={() => answer(it, 'confirmada')}>Está correcta</button>
                <button className={btn2} onClick={() => answer(it, 'observacion')}>Algo no está bien</button></span>}
              {it.run.status === 'en_revision' && !open && <span className="ml-auto text-xs text-slate-500">El plazo de revisión terminó (18:00 del día de pago).</span>}
            </div>
          </div>);
      })}
    </section>
  );
}

/** Editor libre de una línea (solo en borrador): horas por día, situación, calentamiento y ajustes a mano. */
function LineEditor({ line, period, onCancel, onSave, busy }:
  { line: Line; period: PeriodOpt; onCancel: () => void; onSave: (l: Line, note: string) => void; busy: boolean }) {
  const d = line.detail;
  const [days, setDays] = useState(d.days ?? []);
  const [manual, setManual] = useState<{ label: string; amount: string }[]>((d.manual ?? []).map(m => ({ label: m.label, amount: String(Number(m.amount) / 100) })));
  const [note, setNote] = useState('');
  if (!d.inputs) return <div className="space-y-2 text-sm"><p>Esta línea se calculó antes de que existiera la edición a mano. Recalcula la nómina y podrás editarla.</p><button className="text-sm" onClick={onCancel}>Volver</button></div>;
  const parsed = manual.map(m => ({ label: m.label.trim(), cents: Math.round(Number(m.amount) * 100) }));
  const bad = parsed.some(m => !m.label || !Number.isFinite(m.cents) || m.cents === 0);
  const preview = bad ? null : recomputeLine(d, { start: period.start, end: period.end }, line.pay_date, days, parsed.map(m => ({ label: m.label, amountCents: BigInt(m.cents) })));
  const set = (i: number, p: Partial<typeof days[number]>) => setDays(days.map((x, k) => k === i ? { ...x, ...p } : x));
  return (
    <div className="space-y-3">
      <div className="grid gap-4 lg:grid-cols-2">
        <table className="w-full text-xs">
          <thead><tr className="bg-slate-200 text-slate-700"><th className="px-2 py-1.5 text-left">Día</th><th className="px-2 py-1.5">Horas</th><th className="px-2 py-1.5">Situación</th><th className="px-2 py-1.5">Calent.</th></tr></thead>
          <tbody>{days.map((x, i) => (
            <tr key={x.date} className="border-t">
              <td className="px-2 py-1">{fdate(x.date)}</td>
              <td className="px-2 py-1"><select className="rounded border px-1 py-0.5" value={x.minutes} onChange={e => set(i, { minutes: +e.target.value })}>
                {[...new Set([...HALF_HOURS, x.minutes])].sort((a, b) => a - b).map(m => <option key={m} value={m}>{(m / 60).toFixed(2)}</option>)}</select></td>
              <td className="px-2 py-1"><select className="rounded border px-1 py-0.5" value={x.status} onChange={e => set(i, { status: e.target.value as typeof x.status })}>
                <option value="">—</option><option value="Tarde">Tarde</option><option value="Falta">Falta</option><option value="Justificada">Justificada</option></select></td>
              <td className="px-2 py-1 text-center">{d.inputs.warmupApplies !== false
                ? <input type="checkbox" checked={!x.warmupInactive} onChange={e => set(i, { warmupInactive: !e.target.checked })} title="Trabajó activamente en el calentamiento" />
                : <span className="text-slate-300" title="Solo aplica a coaches">—</span>}</td>
            </tr>))}</tbody>
        </table>
        <div className="space-y-2 text-sm">
          <p className="font-medium">Ajustes a mano</p>
          <p className="text-xs text-slate-500">Positivo suma (p. ej. 150), negativo resta (p. ej. -80). Quedan visibles en su nómina como "(a mano)".</p>
          {manual.map((m, i) => (
            <div key={i} className="flex gap-2">
              <input className="grow rounded border px-2 py-1" placeholder="Concepto" value={m.label} onChange={e => setManual(manual.map((x, k) => k === i ? { ...x, label: e.target.value } : x))} />
              <input className="w-28 rounded border px-2 py-1" inputMode="decimal" placeholder="$" value={m.amount} onChange={e => setManual(manual.map((x, k) => k === i ? { ...x, amount: e.target.value } : x))} />
              <button aria-label="Quitar" className="text-red-700" onClick={() => setManual(manual.filter((_, k) => k !== i))}>×</button>
            </div>))}
          <button className="text-xs text-brand" onClick={() => setManual([...manual, { label: '', amount: '' }])}>+ agregar ajuste</button>
          {preview && <div className="rounded-lg bg-slate-50 p-3">
            <p>Percepciones {formatMXN(preview.grossCents)} · Descuentos {formatMXN(preview.deductionCents)}</p>
            <p className="text-base font-semibold">Neto {formatMXN(preview.netCents)} <span className="text-xs font-normal text-slate-500">(antes {formatMXN(line.net_cents)})</span></p>
          </div>}
          {bad && <p className="text-xs text-amber-700">Cada ajuste necesita concepto e importe distinto de cero.</p>}
          <label className="block text-xs">¿Qué corregiste? (queda en el historial)<input className="w-full rounded border px-2 py-1" value={note} onChange={e => setNote(e.target.value)} /></label>
          <div className="flex gap-2">
            <button disabled={busy || !preview || !note.trim()} className={btn} onClick={() => preview && onSave({ ...line, gross_cents: Number(preview.grossCents), deduction_cents: Number(preview.deductionCents),
              net_cents: Number(preview.netCents), reported_cents: Number(preview.reportedCents), detail: preview.detail }, `Edición a mano: ${note.trim()}`)}>Guardar (versión nueva)</button>
            <button className="text-sm" onClick={onCancel}>Cancelar</button>
          </div>
        </div>
      </div>
    </div>
  );
}
