import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { formatMXN, pesosToCents } from '../lib/money';
import { planCash, reconcile, DEFAULT_DENOMINATIONS, type Denomination } from '@domain/cash';

const field = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand';
const btn = 'rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60';
const label = (d: Denomination) => `${d.kind === 'billete' ? '' : 'Moneda '}${formatMXN(d.valueCents).replace('.00', '')}`;

interface Run { id: string; period_start: string; period_end: string; nominal_pay_date: string; authorized_version: number }
interface Line { employee_id: string; pay_date: string; net_cents: number }
interface Emp { id: string; full_name: string; pay_method: string }
interface Dlv { employee_id: string; delivered: boolean; author_name: string | null; created_at: string }
interface Rec { id: string; planned_cents: number; withdrawn_cents: number; delivered_cents: number; note: string | null; created_at: string }

export default function Cash() {
  const { companyId, can } = useAuth();
  const [runs, setRuns] = useState<Run[]>([]); const [runId, setRunId] = useState('');
  const [lines, setLines] = useState<Line[]>([]); const [emps, setEmps] = useState<Emp[]>([]); const [recs, setRecs] = useState<Rec[]>([]);
  const [dlv, setDlv] = useState<Dlv[]>([]); const [busyId, setBusyId] = useState('');
  const [denoms, setDenoms] = useState<Denomination[]>(DEFAULT_DENOMINATIONS);
  const [msg, setMsg] = useState<string | null>(null);
  const [rec, setRec] = useState({ withdrawn: '', delivered: '', note: '' });

  useEffect(() => {
    if (companyId === 'all') return;
    supabase.from('payroll_runs').select('id,period_start,period_end,nominal_pay_date,authorized_version').eq('company_id', companyId)
      .eq('status', 'autorizada').order('nominal_pay_date', { ascending: false }).limit(12)
      .then(({ data, error }) => { if (error) setMsg(error.message); setRuns((data as Run[]) ?? []); setRunId(''); });
  }, [companyId]);

  const load = useCallback(async () => {
    const run = runs.find(r => r.id === runId); if (!run) { setLines([]); return; }
    const l = await supabase.from('payroll_lines').select('employee_id,pay_date,net_cents').eq('run_id', run.id).eq('version', run.authorized_version);
    if (l.error) return setMsg(l.error.message);
    const ls = (l.data as Line[]) ?? []; setLines(ls);
    const [e, r, dv] = await Promise.all([
      supabase.from('employees').select('id,full_name,pay_method').in('id', ls.map(x => x.employee_id)),
      supabase.from('cash_reconciliations').select('id,planned_cents,withdrawn_cents,delivered_cents,note,created_at').eq('run_id', run.id).order('created_at', { ascending: false }),
      supabase.from('pay_deliveries_latest').select('employee_id,delivered,author_name,created_at').eq('run_id', run.id),
    ]);
    setDlv((dv.data as Dlv[]) ?? []);
    if (e.error || r.error) setMsg((e.error ?? r.error)!.message);
    setEmps((e.data as Emp[]) ?? []); setRecs((r.data as Rec[]) ?? []);
  }, [runId, runs]);
  useEffect(() => { load(); }, [load]);

  const name = (id: string) => emps.find(e => e.id === id)?.full_name ?? '—';
  const cashLines = lines.filter(l => emps.find(e => e.id === l.employee_id)?.pay_method !== 'transferencia' && l.net_cents > 0);
  const transfers = lines.filter(l => emps.find(e => e.id === l.employee_id)?.pay_method === 'transferencia' && l.net_cents > 0);
  const plan = useMemo(() => planCash(cashLines.map(l => ({ employeeId: l.employee_id, companyId, amountCents: BigInt(l.net_cents) })), denoms),
    [cashLines, denoms, companyId]);
  const active = denoms.filter(d => d.active).sort((a, b) => (a.valueCents < b.valueCents ? 1 : -1));
  const plannedTotal = plan.grand.amountCents;
  const canEdit = can('cash', 'edit');
  const dOf = (id: string) => dlv.find(d => d.employee_id === id && d.delivered);
  async function toggle(employeeId: string, method: 'efectivo' | 'transferencia', delivered: boolean) {
    setBusyId(employeeId); setMsg(null);
    const { error } = await supabase.from('pay_deliveries').insert({ run_id: runId, company_id: companyId, employee_id: employeeId, method, delivered });
    setBusyId(''); if (error) return setMsg(error.message); load();
  }
  const Check = ({ id, method }: { id: string; method: 'efectivo' | 'transferencia' }) => {
    const d = dOf(id);
    return <label className="inline-flex items-center gap-1" title={d ? `Marcado por ${d.author_name ?? '—'} el ${new Date(d.created_at).toLocaleString('es-MX')}` : ''}>
      <input type="checkbox" className="h-4 w-4" checked={!!d} disabled={!canEdit || busyId === id} onChange={e => toggle(id, method, e.target.checked)} />
      {d && <span className="text-[11px] text-green-700 print:hidden">{new Date(d.created_at).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}</span>}</label>;
  };
  const cashDone = cashLines.filter(l => dOf(l.employee_id)), trDone = transfers.filter(l => dOf(l.employee_id));
  const deliveredCash = cashDone.reduce((n, l) => n + l.net_cents, 0);

  async function saveRec(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const w = pesosToCents(rec.withdrawn), d = pesosToCents(rec.delivered || String(Number(plannedTotal) / 100));
    if (w === null || d === null) return setMsg('Revisa los importes.');
    const { error } = await supabase.from('cash_reconciliations').insert({ run_id: runId, company_id: companyId, planned_cents: Number(plannedTotal),
      withdrawn_cents: w, delivered_cents: d, note: rec.note.trim() || null });
    if (error) return setMsg(error.message);
    setRec({ withdrawn: '', delivered: '', note: '' }); load();
  }

  if (companyId === 'all') return <p className="rounded-xl border border-dashed bg-white p-4 text-sm text-slate-500">Elige una sucursal en el selector de arriba.</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-sm print:hidden">
        <label className="text-xs">Nómina autorizada
          <select className={`${field} block`} value={runId} onChange={e => setRunId(e.target.value)}>
            <option value="">Elige…</option>
            {runs.map(r => <option key={r.id} value={r.id}>Pago {r.nominal_pay_date} · trabajo {r.period_start} a {r.period_end}</option>)}
          </select></label>
        {runs.length === 0 && <span className="text-sm text-slate-500">No hay nóminas autorizadas en esta sucursal.</span>}
        {runId && <button className={`${btn} ml-auto`} onClick={() => window.print()}>Imprimir sobres</button>}
      </div>
      {msg && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{msg}</p>}

      {runId && <>
        <details className="rounded-xl bg-white p-4 text-sm shadow-sm print:hidden">
          <summary className="cursor-pointer font-medium">Billetes y monedas disponibles</summary>
          <p className="my-2 text-xs text-slate-500">Desmarca lo que no quieras usar. Si el banco solo te da cierta cantidad de algún billete, escríbela y el cálculo la respeta.</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {denoms.map((d, i) => (
              <div key={d.id} className="flex items-center gap-2">
                <label className="flex w-36 items-center gap-1"><input type="checkbox" checked={d.active}
                  onChange={e => setDenoms(denoms.map((x, j) => j === i ? { ...x, active: e.target.checked } : x))} />{label(d)}</label>
                <input placeholder="sin límite" inputMode="numeric" className={`${field} w-24`} value={d.available ?? ''}
                  onChange={e => setDenoms(denoms.map((x, j) => j === i ? { ...x, available: e.target.value === '' ? null : Math.max(0, parseInt(e.target.value) || 0) } : x))} />
              </div>))}
          </div>
        </details>

        <div className="rounded-xl bg-white p-4 shadow-sm">
          <p className="mb-2 font-semibold">Retiro total en efectivo: {formatMXN(plannedTotal)} <span className="text-sm font-normal text-slate-500">· {plan.perEmployee.length - plan.failures.length} sobre(s) · entregados {cashDone.length} de {cashLines.length} ({formatMXN(deliveredCash)}), faltan {formatMXN(Number(plannedTotal) - deliveredCash)}</span></p>
          <div className="flex flex-wrap gap-2 text-sm">{active.filter(d => plan.grand.pieces[d.id]).map(d => (
            <span key={d.id} className="rounded-lg bg-slate-100 px-2 py-1"><b>{plan.grand.pieces[d.id]}</b> × {label(d)}</span>))}</div>
          {plan.failures.length > 0 && <div className="mt-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
            <b>Sin combinación exacta</b> (no se redondea; decide cómo pagarlos):
            {plan.failures.map(f => <p key={f.employeeId}>{name(f.employeeId)}: {formatMXN(f.amountCents)} — faltan {formatMXN(f.remainderCents)} {f.remainderCents < 50n ? '(centavos menores a $0.50)' : '(no alcanzan las existencias)'}</p>)}
          </div>}
        </div>

        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-100 uppercase text-slate-500"><tr><th className="px-3 py-2">Entregado</th><th className="px-3 py-2">Sobre</th><th className="px-3 py-2 text-right">Importe</th>
              {active.map(d => <th key={d.id} className="px-2 py-2 text-right">{label(d)}</th>)}</tr></thead>
            <tbody>{[...plan.perEmployee].sort((a, b) => name(a.employeeId).localeCompare(name(b.employeeId))).map(p => (
              <tr key={p.employeeId} className={`border-t ${!p.ok ? 'bg-amber-50' : dOf(p.employeeId) ? 'bg-green-50' : ''}`}>
                <td className="px-3 py-1.5"><Check id={p.employeeId} method="efectivo" /></td>
                <td className="px-3 py-1.5 font-medium">{name(p.employeeId)}</td><td className="px-3 py-1.5 text-right">{formatMXN(p.amountCents)}</td>
                {active.map(d => <td key={d.id} className="px-2 py-1.5 text-right">{p.pieces[d.id] || ''}</td>)}
              </tr>))}
              <tr className="border-t bg-slate-50 font-semibold"><td className="px-3 py-1.5 text-xs font-normal">{cashDone.length}/{cashLines.length}</td><td className="px-3 py-1.5">Total</td><td className="px-3 py-1.5 text-right">{formatMXN(plannedTotal)}</td>
                {active.map(d => <td key={d.id} className="px-2 py-1.5 text-right">{plan.grand.pieces[d.id] || ''}</td>)}</tr>
            </tbody>
          </table>
        </div>

        {transfers.length > 0 && <div className="rounded-xl bg-white p-4 text-sm shadow-sm">
          <p className="mb-1 font-medium">Por transferencia (no entran en el retiro) <span className="text-xs font-normal text-slate-500">· {trDone.length}/{transfers.length} transferidas</span></p>
          {transfers.map(t => <p key={t.employee_id} className="flex items-center gap-2"><Check id={t.employee_id} method="transferencia" />
            <span>{name(t.employee_id)}: <b>{formatMXN(t.net_cents)}</b> <span className="text-xs text-slate-400">pago {t.pay_date}</span></span></p>)}
          <p className="mt-1 text-xs text-slate-500">Total transferencias: {formatMXN(transfers.reduce((n, t) => n + t.net_cents, 0))}</p>
        </div>}

        <div className="space-y-2 rounded-xl bg-white p-4 text-sm shadow-sm print:hidden">
          <p className="font-medium">Conciliación</p>
          {can('cash', 'edit') && <form onSubmit={saveRec} className="flex flex-wrap items-end gap-2">
            <label className="text-xs">Retiré ($)<input required inputMode="decimal" className={`${field} block w-32`} value={rec.withdrawn} onChange={e => setRec({ ...rec, withdrawn: e.target.value })} /></label>
            <label className="text-xs">Entregué ($)<input inputMode="decimal" placeholder={String(Number(plannedTotal) / 100)} className={`${field} block w-32`} value={rec.delivered} onChange={e => setRec({ ...rec, delivered: e.target.value })} /></label>
            <label className="grow text-xs">Nota (obligatoria si hay diferencia)<input className={`${field} block w-full`} value={rec.note} onChange={e => setRec({ ...rec, note: e.target.value })} /></label>
            <button className={btn}>Registrar</button>
          </form>}
          {recs.map(r => { const c = reconcile(BigInt(r.withdrawn_cents), BigInt(r.delivered_cents)); return (
            <p key={r.id} className="text-xs">{r.created_at.slice(0, 16).replace('T', ' ')} · retirado {formatMXN(r.withdrawn_cents)} · entregado {formatMXN(r.delivered_cents)} ·{' '}
              <b className={c.balanced ? 'text-green-700' : c.shortfall ? 'text-red-700' : 'text-amber-700'}>{c.balanced ? 'cuadra' : c.shortfall ? `faltan ${formatMXN(-c.leftoverCents)}` : `sobran ${formatMXN(c.leftoverCents)}`}</b>
              {r.note ? ` · ${r.note}` : ''}</p>); })}
        </div>
      </>}
    </div>
  );
}
