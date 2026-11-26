// Reglas de cobro de planes (mensualidades). Todo en centavos; porcentajes en bps (500 = 5 %).
//
//  · Pronto pago: pagado ANTES del día 1 del mes → descuento (5 %).
//  · Del día 1 al día límite (5) → precio normal.
//  · Del día 6 al 10 → recargo 5 %; del 11 en adelante → recargo 10 %.
//  · Hermanos: en una familia con 2+ planes individuales, todas menos la del plan de mayor valor
//    llevan 15 % y a ellas NO se les aplica pronto pago. Cuenta aunque estén en distintas sucursales.
//  · Becas y descuentos recurrentes (porcentaje o cantidad) se aplican primero, sobre el precio del plan.
//  · Quien tiene BECA no lleva ningún otro descuento (ni descuentos recurrentes, ni hermanos, ni pronto pago).
//    Si paga ya con recargo (día 6 en adelante) PIERDE la beca ese mes: se cobra el plan completo + el recargo.
//  · Hermanos, pronto pago y recargos se calculan SOBRE EL PRECIO NORMAL del plan (como dice la tabla de precios).
//  · Familia: se suman los planes de las hermanas; el 15 % va al plan más barato y el pronto pago sólo al más caro.
//  · Pago por adelantado: N meses con un descuento especial y el precio congelado durante esos meses.

export interface BillingRules {
  earlyBps: number;          // pronto pago (500)
  siblingBps: number;        // hermanos (1500)
  dueDay: number;            // último día sin recargo (5)
  surcharges: { fromDay: number; bps: number }[];   // [{6, 500}, {11, 1000}]
}
export const DEFAULT_RULES: BillingRules = { earlyBps: 500, siblingBps: 1500, dueDay: 5, surcharges: [{ fromDay: 6, bps: 500 }, { fromDay: 11, bps: 1000 }] };

export interface Adjustment { label: string; mode: 'pct' | 'monto'; value: number; kind?: 'beca' | 'descuento' }   // pct en bps, monto en centavos

export interface ChargeBreakdown {
  base: number; adjustments: { label: string; amount: number }[]; sibling: number;
  early: number; surcharge: number; surchargeBps: number; total: number; becaLost: boolean;
}

const pct = (amount: number, bps: number) => Math.round((amount * bps) / 10000);

/** Etapa de pago según la fecha: 'pronto' (antes del mes), 'normal' o el recargo que toque. */
export function payStage(month: string, payDate: string | null, rules: BillingRules = DEFAULT_RULES) {
  // month = 'AAAA-MM'; payDate = 'AAAA-MM-DD' (o null = aún sin pagar → se calcula como si fuera normal)
  if (!payDate) return { stage: 'normal' as const, bps: 0 };
  const ym = payDate.slice(0, 7);
  if (ym < month) return { stage: 'pronto' as const, bps: 0 };
  if (ym > month) { const last = rules.surcharges.at(-1); return { stage: 'recargo' as const, bps: last?.bps ?? 0 }; }
  const day = Number(payDate.slice(8, 10));
  let bps = 0;
  for (const s of [...rules.surcharges].sort((a, b) => a.fromDay - b.fromDay)) if (day >= s.fromDay) bps = s.bps;
  return bps ? { stage: 'recargo' as const, bps } : { stage: 'normal' as const, bps: 0 };
}

export function monthlyCharge(o: { price: number; month: string; payDate: string | null; sibling: boolean;
  adjustments?: Adjustment[]; rules?: BillingRules }): ChargeBreakdown {
  const rules = o.rules ?? DEFAULT_RULES;
  let amount = o.price;
  const st = payStage(o.month, o.payDate, rules);
  const all0 = o.adjustments ?? [];
  const becaLost = st.stage === 'recargo' && all0.some(a => a.kind === 'beca');
  const all = becaLost ? [] : all0;
  const hasBeca = becaLost || all.some(a => a.kind === 'beca');
  const adjustments = (hasBeca ? all.filter(a => a.kind === 'beca') : all).map(a => {
    const off = Math.min(amount, a.mode === 'pct' ? pct(amount, a.value) : a.value);
    amount -= off; return { label: a.label, amount: -off };
  });
  const sibling = o.sibling && !hasBeca ? -Math.min(amount, pct(o.price, rules.siblingBps)) : 0; amount += sibling;
  const early = st.stage === 'pronto' && !o.sibling && !hasBeca ? -Math.min(amount, pct(o.price, rules.earlyBps)) : 0; amount += early;
  const surcharge = st.stage === 'recargo' ? pct(o.price, st.bps) : 0; amount += surcharge;
  return { base: o.price, adjustments, sibling, early, surcharge, surchargeBps: st.stage === 'recargo' ? st.bps : 0, total: amount, becaLost };
}

/** Qué suscripciones llevan descuento de hermanos: en cada familia, todas menos la de mayor precio.
 *  Las que tienen beca no cuentan (no llevan otro descuento). */
export function siblingTargets(subs: { id: string; familyId: string | null; price: number; familyPlan?: boolean; beca?: boolean }[]) {
  const byFam = new Map<string, typeof subs>();
  for (const s of subs) if (s.familyId && !s.familyPlan && !s.beca) byFam.set(s.familyId, [...(byFam.get(s.familyId) ?? []), s]);
  const out = new Set<string>();
  for (const list of byFam.values()) {
    if (list.length < 2) continue;
    const top = [...list].sort((a, b) => b.price - a.price || a.id.localeCompare(b.id))[0];
    for (const s of list) if (s.id !== top.id) out.add(s.id);
  }
  return out;
}

/** Cambio de plan en el mismo mes: se cobra la diferencia (negativa = queda a favor). */
export const planChangeDifference = (oldTotal: number, newTotal: number) => newTotal - oldTotal;

/** Pago por adelantado: total a pagar y cuánto le toca a cada mes (para el reporte de planes). */
export function prepayQuote(price: number, months: number, discountBps: number) {
  const gross = price * months;
  const total = gross - pct(gross, discountBps);
  const per = Math.floor(total / months), extra = total - per * months;
  return { gross, discount: gross - total, total, perMonth: Array.from({ length: months }, (_, i) => per + (i < extra ? 1 : 0)) };
}

// ---------------------------------------------------------------- Doble disciplina
export interface ComboLimits { maxTotal: number; minTotal?: number; perDiscipline: Record<string, { min: number; max: number }>; defaultMin?: number; defaultMax?: number }
/** Revisa una combinación de disciplinas: 2 o más distintas, horas de cada una dentro de su rango y total dentro del máximo. */
export function checkCombo(parts: { discipline: string; hours: number }[], lim: ComboLimits): string[] {
  const errs: string[] = [];
  const ds = parts.map(p => p.discipline);
  if (parts.length < 2) errs.push('Elige al menos dos disciplinas');
  if (new Set(ds).size !== ds.length) errs.push('Cada disciplina va una sola vez');
  for (const p of parts) {
    const r = lim.perDiscipline[p.discipline] ?? { min: lim.defaultMin ?? 1, max: lim.defaultMax ?? 8 };
    if (!(p.hours > 0)) errs.push(`${p.discipline || 'Disciplina'}: pon las horas`);
    else if (p.hours < r.min) errs.push(`${p.discipline}: mínimo ${r.min} h`);
    else if (p.hours > r.max) errs.push(`${p.discipline}: máximo ${r.max} h`);
  }
  const total = parts.reduce((n, p) => n + (p.hours || 0), 0);
  if (total > lim.maxTotal) errs.push(`El total es ${total} h; el máximo es ${lim.maxTotal} h`);
  if (lim.minTotal && total < lim.minTotal) errs.push(`El total es ${total} h; el mínimo es ${lim.minTotal} h`);
  return errs;
}
