import { Fragment, useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { formatMXN } from '../lib/money';
import { computeOwed, monthName, type OwedItem } from '../lib/owed';

const money = (c: number) => formatMXN(c);
interface Sale { id: string; folio: number; sold_on: string; sold_at: string; total_cents: number; seller_name: string | null; cancelled_at: string | null; cancel_reason: string | null; note: string | null }
interface Line { sale_id: string; kind: string; description: string; amount_cents: number; student_id: string | null }
interface Pay { sale_id: string; amount_cents: number; paid_on: string; paid_at: string; is_installment: boolean; payment_method_id: string; reference: string | null }
interface PP { id: string; from_month: string; months: number; total_cents: number; paid_on: string; discount_bps: number; cancelled_at: string | null }

export interface Balance { owed: number; pendingReceipts: number; credit: number; items: OwedItem[] }

/** Lo que debe hoy la alumna (cargos + recibos con saldo) y lo que tiene a favor. */
export async function studentBalance(s: { id: string; company_id: string }): Promise<Balance> {
  const [o, b, c] = await Promise.all([computeOwed({ company: s.company_id, studentIds: [s.id] }),
    supabase.from('sale_balances').select('balance_cents').eq('student_id', s.id).gt('balance_cents', 0),
    supabase.rpc('student_credit', { p_student: s.id })]);
  return { items: o.items, owed: o.items.reduce((n, i) => n + i.amount, 0), pendingReceipts: (b.data ?? []).reduce((n, x) => n + Number(x.balance_cents), 0), credit: Number(c.data ?? 0) };
}

/** Estado de cuenta: saldo, cargos pendientes y todos sus movimientos (ventas, abonos, adelantos). */
export default function StudentAccount({ s, balance }: { s: { id: string; company_id: string; full_name: string }; balance: Balance | null }) {
  const [sales, setSales] = useState<Sale[]>([]); const [lines, setLines] = useState<Line[]>([]); const [pays, setPays] = useState<Pay[]>([]);
  const [pre, setPre] = useState<PP[]>([]); const [methods, setMethods] = useState<Record<string, string>>({}); const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    // ventas donde es la clienta o donde aparece en algún renglón (p. ej. cobro familiar)
    const [own, ln, m, p] = await Promise.all([
      supabase.from('sales').select('*').eq('student_id', s.id),
      supabase.from('sale_lines').select('sale_id').eq('student_id', s.id),
      supabase.from('payment_methods').select('id,name'),
      supabase.from('plan_prepayments').select('id,from_month,months,total_cents,paid_on,discount_bps,cancelled_at,subscriptions!inner(student_id)').eq('subscriptions.student_id', s.id)]);
    const ids = [...new Set([...(own.data ?? []).map(x => x.id), ...(ln.data ?? []).map(x => x.sale_id)])];
    const [sa, l, py] = ids.length ? await Promise.all([supabase.from('sales').select('*').in('id', ids).order('sold_at', { ascending: false }),
      supabase.from('sale_lines').select('sale_id,kind,description,amount_cents,student_id').in('sale_id', ids),
      supabase.from('sale_payments').select('*').in('sale_id', ids).order('paid_at')]) : [{ data: [] }, { data: [] }, { data: [] }];
    setSales((sa.data as Sale[]) ?? []); setLines((l.data as Line[]) ?? []); setPays((py.data as Pay[]) ?? []);
    setMethods(Object.fromEntries((m.data ?? []).map(x => [x.id, x.name]))); setPre((p.data as unknown as PP[]) ?? []);
  }, [s.id]);
  useEffect(() => { load(); }, [load]);

  const paidOf = (id: string) => pays.filter(p => p.sale_id === id).reduce((n, p) => n + Number(p.amount_cents), 0);
  const valid = sales.filter(x => !x.cancelled_at);
  const totalPaid = valid.reduce((n, x) => n + paidOf(x.id), 0) + pre.filter(p => !p.cancelled_at).reduce((n, p) => n + Number(p.total_cents), 0);
  const net = balance ? balance.owed + balance.pendingReceipts - balance.credit : 0;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Kpi label={net > 0 ? 'Debe hoy' : net < 0 ? 'Saldo a favor' : 'Saldo'} value={balance ? money(Math.abs(net)) : '…'} tone={net > 0 ? 'red' : net < 0 ? 'green' : 'slate'} />
        <Kpi label="Cargos pendientes" value={balance ? money(balance.owed) : '…'} />
        <Kpi label="Recibos por liquidar" value={balance ? money(balance.pendingReceipts) : '…'} />
        <Kpi label="Pagado en total" value={money(totalPaid)} />
      </div>

      {balance && balance.items.length > 0 && <div className="rounded-xl border border-red-200 bg-red-50/40 p-3 text-sm">
        <h4 className="mb-1 font-semibold">Cargos pendientes al día de hoy</h4>
        {balance.items.map(i => <p key={i.key} className="flex justify-between gap-2"><span>{i.kind === 'anualidad' ? `Anualidad ${i.year}` : `${i.kind === 'cambio_plan' ? 'Cambio de plan · ' : 'Mensualidad '}${monthName(i.month!.slice(0, 7))}`}
          {i.overdue && <span className="ml-1 text-xs text-red-700">vencida</span>}{i.surcharge > 0 && <span className="ml-1 text-xs text-slate-500">incluye recargo</span>}</span><b>{money(i.amount)}</b></p>)}
      </div>}

      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Recibo</th><th className="px-3 py-2">Concepto</th>
            <th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Pagado</th><th className="px-3 py-2 text-right">Debe</th></tr></thead>
          <tbody>
            {sales.map(x => { const pd = paidOf(x.id); return (<Fragment key={x.id}>
              <tr className={`cursor-pointer border-t hover:bg-slate-50 ${x.cancelled_at ? 'text-slate-400 line-through' : ''}`} onClick={() => setOpen(open === x.id ? null : x.id)}>
                <td className="px-3 py-1.5">{x.sold_on}</td><td className="px-3 py-1.5">F {x.folio}</td>
                <td className="px-3 py-1.5 text-xs">{lines.filter(l => l.sale_id === x.id).map(l => l.description).join(' · ')}{x.cancelled_at && <span className="block no-underline">Cancelado: {x.cancel_reason}</span>}</td>
                <td className="px-3 py-1.5 text-right">{money(x.total_cents)}</td><td className="px-3 py-1.5 text-right">{money(pd)}</td>
                <td className={`px-3 py-1.5 text-right ${!x.cancelled_at && x.total_cents - pd > 0 ? 'font-semibold text-red-700' : 'text-slate-400'}`}>{x.cancelled_at ? '—' : money(x.total_cents - pd)}</td></tr>
              {open === x.id && <tr className="bg-slate-50 text-xs"><td colSpan={6} className="px-6 py-2">
                {pays.filter(p => p.sale_id === x.id).map((p, i) => <p key={i}>{p.is_installment ? 'Abono' : 'Pago'} {p.paid_on} · {methods[p.payment_method_id]} {money(p.amount_cents)}{p.reference ? ` · ref. ${p.reference}` : ''}</p>)}
                {!pays.some(p => p.sale_id === x.id) && <p>Sin pagos.</p>}<p className="text-slate-500">Cobró: {x.seller_name}{x.note ? ` · ${x.note}` : ''}</p></td></tr>}
            </Fragment>); })}
            {pre.map(p => <tr key={p.id} className={`border-t ${p.cancelled_at ? 'text-slate-400 line-through' : ''}`}>
              <td className="px-3 py-1.5">{p.paid_on}</td><td className="px-3 py-1.5">Adelanto</td>
              <td className="px-3 py-1.5 text-xs">{p.months} meses desde {monthName(p.from_month.slice(0, 7))}{p.discount_bps ? ` · ${p.discount_bps / 100} % de descuento` : ''}</td>
              <td className="px-3 py-1.5 text-right">{money(p.total_cents)}</td><td className="px-3 py-1.5 text-right">{money(p.total_cents)}</td><td className="px-3 py-1.5 text-right text-slate-400">{money(0)}</td></tr>)}
            {!sales.length && !pre.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Sin movimientos todavía.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">Clic en un recibo para ver sus pagos y abonos. Los cargos pendientes se calculan al día de hoy (con recargo si ya pasó el día 5).</p>
    </div>
  );
}

function Kpi({ label, value, tone = 'slate' }: { label: string; value: string; tone?: 'red' | 'green' | 'slate' }) {
  return <div className="rounded-xl bg-white p-3 shadow-sm"><p className="text-xs text-slate-500">{label}</p>
    <p className={`text-xl font-semibold ${tone === 'red' ? 'text-red-700' : tone === 'green' ? 'text-green-700' : ''}`}>{value}</p></div>;
}
