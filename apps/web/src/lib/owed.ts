import { supabase } from './supabase';
import { monthlyCharge, siblingTargets, DEFAULT_RULES, type BillingRules, type Adjustment, type ChargeBreakdown } from '@domain/billing';

/** Lo que debe cada alumna HOY: mensualidades pendientes (con beca, hermanos, pronto pago o recargo
 *  según la fecha), cambios de plan con diferencia y anualidad. Todo calculado con las reglas de la sucursal. */

export interface OwedItem {
  key: string; kind: 'mensualidad' | 'cambio_plan' | 'anualidad'; studentId: string; subscriptionId?: string; month?: string; year?: number;
  description: string; base: number; discount: number; surcharge: number; amount: number; detail: Record<string, unknown>;
  overdue: boolean; future: boolean; breakdown?: ChargeBreakdown;
}
const TZ = 'America/Mexico_City';
export const todayMx = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const addMonth = (ym: string, n: number) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 7);
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const monthName = (ym: string) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;

interface Sub { id: string; company_id: string; plan_id: string; student_id: string | null; start_month: string; end_month: string | null; replaces_id: string | null }
interface Adj { subscription_id: string; kind: 'beca' | 'descuento'; label: string; mode: 'pct' | 'monto'; value: number; from_month: string; to_month: string | null; id: string }

export async function loadRules(company: string): Promise<{ rules: BillingRules; chargeFrom: string }> {
  const { data } = await supabase.from('billing_rules').select('*').eq('company_id', company).maybeSingle();
  if (!data) return { rules: DEFAULT_RULES, chargeFrom: todayMx().slice(0, 7) };
  return { rules: { earlyBps: data.early_bps, siblingBps: data.sibling_bps, dueDay: data.due_day,
    surcharges: [{ fromDay: data.surcharge1_day, bps: data.surcharge1_bps }, { fromDay: data.surcharge2_day, bps: data.surcharge2_bps }] },
    chargeFrom: (data.charge_from ?? todayMx()).slice(0, 7) };
}

/** Calcula adeudos de un grupo de alumnas (una familia o toda la sucursal). */
export async function computeOwed(o: { company: string; studentIds: string[]; payDate?: string; includeNext?: boolean }): Promise<{ items: OwedItem[]; error?: string }> {
  const payDate = o.payDate ?? todayMx(); const cur = payDate.slice(0, 7);
  if (!o.studentIds.length) return { items: [] };
  const { rules, chargeFrom } = await loadRules(o.company);
  // alumnas, familias (para hermanos, aunque estén en otra sucursal) y planes
  const st = await supabase.from('students').select('id,full_name,family_id').in('id', o.studentIds);
  const fams = [...new Set((st.data ?? []).map(x => x.family_id).filter(Boolean))] as string[];
  const fam = fams.length ? await supabase.from('students').select('id,full_name,family_id').in('family_id', fams) : { data: [] };
  const everyone = new Map([...(st.data ?? []), ...(fam.data ?? [])].map(x => [x.id, x]));
  const ids = [...everyone.keys()];
  const subsR = await supabase.from('subscriptions').select('id,company_id,plan_id,student_id,start_month,end_month,replaces_id').in('student_id', ids).is('cancelled_at', null);
  if (subsR.error) return { items: [], error: subsR.error.message };
  const subs = (subsR.data as Sub[]) ?? [];
  const subIds = subs.map(s => s.id);
  const [adjR, skipR, paidR, plansR] = subIds.length ? await Promise.all([
    supabase.from('subscription_adjustments').select('*').in('subscription_id', subIds).is('cancelled_at', null),
    supabase.from('adjustment_skips').select('adjustment_id,month'),
    supabase.from('paid_months').select('subscription_id,month,amount_cents').in('subscription_id', subIds),
    supabase.from('plans').select('id,discipline,name').in('id', [...new Set(subs.map(s => s.plan_id))])]) : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];
  const adjs = (adjR.data as Adj[]) ?? []; const skips = (skipR.data ?? []) as { adjustment_id: string; month: string }[];
  const paid = (paidR.data ?? []) as { subscription_id: string; month: string; amount_cents: number }[];
  const plans = new Map(((plansR.data ?? []) as { id: string; discipline: string; name: string }[]).map(p => [p.id, p]));
  const priceCache = new Map<string, number | null>();
  async function price(plan: string, ym: string) {
    const k = `${plan}|${ym}`; if (priceCache.has(k)) return priceCache.get(k)!;
    const r = await supabase.rpc('plan_price_at', { p_plan: plan, p_month: `${ym}-01` }); const v = (r.data as number | null) ?? null; priceCache.set(k, v); return v;
  }
  const active = (s: Sub, ym: string) => s.start_month.slice(0, 7) <= ym && (!s.end_month || s.end_month.slice(0, 7) >= ym);
  const adjFor = (s: Sub, ym: string): Adjustment[] => adjs.filter(a => a.subscription_id === s.id && a.from_month.slice(0, 7) <= ym && (!a.to_month || a.to_month.slice(0, 7) >= ym)
    && !skips.some(k => k.adjustment_id === a.id && k.month.slice(0, 7) === ym)).map(a => ({ label: a.label, mode: a.mode, value: Number(a.value), kind: a.kind }));
  const paidOf = (subId: string, ym: string) => paid.find(p => p.subscription_id === subId && p.month.slice(0, 7) === ym);

  const items: OwedItem[] = [];
  const last = o.includeNext ? addMonth(cur, 1) : cur;
  for (const s of subs.filter(x => x.company_id === o.company && o.studentIds.includes(x.student_id!))) {
    const first = [s.start_month.slice(0, 7), chargeFrom].sort().at(-1)!;
    for (let ym = first; ym <= last; ym = addMonth(ym, 1)) {
      if (!active(s, ym)) continue;
      const replacedBy = subs.find(x => x.replaces_id === s.id && active(x, ym));
      if (replacedBy) continue;                                    // ese mes lo cubre el plan nuevo
      if (paidOf(s.id, ym)) continue;
      const p = await price(s.plan_id, ym); if (p === null) continue;
      // hermanos de ese mes (todas las sucursales); las becadas no cuentan
      const famId = everyone.get(s.student_id!)?.family_id ?? null;
      const peers = subs.filter(x => active(x, ym) && !subs.some(y => y.replaces_id === x.id && active(y, ym)) && everyone.get(x.student_id!)?.family_id === famId && famId);
      const peerPrices = await Promise.all(peers.map(async x => ({ id: x.id, familyId: famId, price: (await price(x.plan_id, ym)) ?? 0, beca: adjFor(x, ym).some(a => a.kind === 'beca') })));
      const sib = siblingTargets(peerPrices.length ? peerPrices : [{ id: s.id, familyId: null, price: p }]).has(s.id);
      const c = monthlyCharge({ price: p, month: ym, payDate, sibling: sib, adjustments: adjFor(s, ym), rules });
      const plan = plans.get(s.plan_id); const who = everyone.get(s.student_id!)?.full_name ?? '';
      const old = s.replaces_id ? subs.find(x => x.id === s.replaces_id) : undefined;
      const oldPaid = old ? paidOf(old.id, ym) : undefined;
      const discount = -(c.adjustments.reduce((n, a) => n + a.amount, 0) + c.sibling + c.early);
      const detail = { plan: plan ? `${plan.discipline} · ${plan.name}` : '', adjustments: c.adjustments, sibling: c.sibling, early: c.early, surchargeBps: c.surchargeBps, becaLost: c.becaLost };
      if (old && oldPaid) {   // cambio de plan en un mes ya pagado: sólo la diferencia
        const diff = c.total - Number(oldPaid.amount_cents);
        if (diff > 0) items.push({ key: `${s.id}|${ym}|cambio`, kind: 'cambio_plan', studentId: s.student_id!, subscriptionId: s.id, month: `${ym}-01`,
          description: `Cambio de plan ${monthName(ym)} · ${who} → ${detail.plan}`, base: diff, discount: 0, surcharge: 0, amount: diff, detail: { ...detail, paidBefore: oldPaid.amount_cents },
          overdue: ym < cur, future: ym > cur });
        continue;
      }
      items.push({ key: `${s.id}|${ym}`, kind: 'mensualidad', studentId: s.student_id!, subscriptionId: s.id, month: `${ym}-01`,
        description: `Mensualidad ${monthName(ym)} · ${who} · ${detail.plan}`, base: p, discount, surcharge: c.surcharge, amount: c.total, detail, breakdown: c,
        overdue: ym < cur, future: ym > cur });
    }
  }
  // anualidad del ciclo escolar (agosto a julio). Las que ya estaban antes de empezar a cobrar en este
  // sistema (charge_from) ya la pagaron en EVO: sólo se pide a las nuevas o desde el ciclo siguiente.
  const year = +cur.slice(5, 7) >= 8 ? +cur.slice(0, 4) : +cur.slice(0, 4) - 1;
  const cycleStart = `${year}-08`;
  const fee = await supabase.from('annual_fees').select('amount_cents').eq('company_id', o.company).eq('year', year).maybeSingle();
  if (fee.data) {
    const pa = await supabase.from('sale_lines').select('student_id,sales!inner(cancelled_at)').eq('kind', 'anualidad').eq('year', year).in('student_id', o.studentIds).is('sales.cancelled_at', null);
    const paidIds = new Set((pa.data ?? []).map(x => x.student_id));
    for (const id of o.studentIds) {
      const mine = subs.filter(x => x.student_id === id && x.company_id === o.company);
      if (paidIds.has(id) || !mine.some(x => active(x, cur))) continue;
      const firstStart = mine.map(x => x.start_month.slice(0, 7)).sort()[0];
      if (cycleStart < chargeFrom && firstStart < chargeFrom) continue;
      const amt = Number(fee.data.amount_cents);
      items.push({ key: `${id}|anualidad|${year}`, kind: 'anualidad', studentId: id, year, description: `Anualidad ${year}–${year + 1} · ${everyone.get(id)?.full_name ?? ''}`,
        base: amt, discount: 0, surcharge: 0, amount: amt, detail: {}, overdue: false, future: false });
    }
  }
  return { items };
}
