// Desglose de efectivo en pesos mexicanos. Todo en centavos (bigint). Nunca redondea.
import type { Cents } from './payroll.ts';

export interface Denomination {
  id: string;
  kind: 'billete' | 'moneda';
  valueCents: Cents;
  available: number | null;   // null = sin límite
  active: boolean;
}

export const DEFAULT_DENOMINATIONS: Denomination[] = [
  ...[100000n, 50000n, 20000n, 10000n, 5000n, 2000n].map<Denomination>(v =>
    ({ id: `billete-${v}`, kind: 'billete', valueCents: v, available: null,
      active: v !== 100000n })),   // $1,000 desactivado por defecto (decisión del negocio); editable en el catálogo
  ...[2000n, 1000n, 500n, 200n, 100n, 50n].map<Denomination>(v =>
    ({ id: `moneda-${v}`, kind: 'moneda', valueCents: v, available: null, active: true })),
];

export interface Breakdown {
  ok: boolean;
  amountCents: Cents;
  pieces: Record<string, number>;   // id de denominación -> cantidad
  totalPieces: number;
  remainderCents: Cents;            // > 0 si no hay combinación exacta
  reason?: string;
}

/**
 * Desglose de UN importe. Codicioso por denominación mayor respetando existencias.
 * Para el sistema monetario mexicano es mínimo en piezas cuando no hay límites.
 * LIMITACIÓN conocida: con existencias limitadas puede no encontrar una combinación
 * exacta que sí exista (la búsqueda exhaustiva queda para la etapa 11); en ese caso
 * devuelve ok=false con el remanente, sin redondear ni alterar el pago.
 */
export function breakdownAmount(amountCents: Cents, denoms: Denomination[], stock?: Map<string, number>): Breakdown {
  if (amountCents < 0n) throw new Error('Importe negativo');
  const list = denoms.filter(d => d.active).sort((a, b) => (a.valueCents < b.valueCents ? 1 : a.valueCents > b.valueCents ? -1 : a.kind === 'billete' ? -1 : 1));
  let rest = amountCents;
  const pieces: Record<string, number> = {};
  let total = 0;
  for (const d of list) {
    if (rest <= 0n) break;
    const left = stock ? (stock.get(d.id) ?? Infinity) : (d.available ?? Infinity);
    const need = rest / d.valueCents;
    const n = need > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(need);
    const take = Math.min(n, left);
    if (take > 0) { pieces[d.id] = take; total += take; rest -= BigInt(take) * d.valueCents; }
  }
  return rest === 0n
    ? { ok: true, amountCents, pieces, totalPieces: total, remainderCents: 0n }
    : { ok: false, amountCents, pieces, totalPieces: total, remainderCents: rest,
        reason: 'No existe combinación exacta con las denominaciones/existencias disponibles.' };
}

export interface EmployeePayment { employeeId: string; companyId: string; amountCents: Cents }
export interface EmployeeBreakdown extends Breakdown { employeeId: string; companyId: string }

export interface CashPlan {
  perEmployee: EmployeeBreakdown[];
  totalsByCompany: Record<string, { amountCents: Cents; pieces: Record<string, number> }>;
  grand: { amountCents: Cents; pieces: Record<string, number>; totalPieces: number };
  failures: EmployeeBreakdown[];
}

/** Primero cada empleado, luego se suman (así el retiro alcanza para cada pago). */
export function planCash(payments: EmployeePayment[], denoms: Denomination[]): CashPlan {
  const stock = new Map<string, number>();
  for (const d of denoms) if (d.available !== null) stock.set(d.id, d.available);

  // Pagos grandes primero: consumen existencias limitadas antes.
  const ordered = [...payments].sort((a, b) => (a.amountCents < b.amountCents ? 1 : -1));
  const perEmployee: EmployeeBreakdown[] = [];
  const byCompany: CashPlan['totalsByCompany'] = {};
  const grandPieces: Record<string, number> = {};
  let grandAmount = 0n; let grandCount = 0;

  for (const p of ordered) {
    const b = breakdownAmount(p.amountCents, denoms, stock);
    perEmployee.push({ ...b, employeeId: p.employeeId, companyId: p.companyId });
    if (!b.ok) continue;                      // no se consume efectivo de pagos sin combinación
    const c = (byCompany[p.companyId] ??= { amountCents: 0n, pieces: {} });
    c.amountCents += p.amountCents; grandAmount += p.amountCents;
    for (const [id, n] of Object.entries(b.pieces)) {
      c.pieces[id] = (c.pieces[id] ?? 0) + n;
      grandPieces[id] = (grandPieces[id] ?? 0) + n; grandCount += n;
      if (stock.has(id)) stock.set(id, stock.get(id)! - n);
    }
  }
  return { perEmployee, totalsByCompany: byCompany,
    grand: { amountCents: grandAmount, pieces: grandPieces, totalPieces: grandCount },
    failures: perEmployee.filter(e => !e.ok) };
}

/** Conciliación: retirado − entregado = sobrante (debe ser ≥ 0 y explicarse). */
export function reconcile(withdrawnCents: Cents, deliveredCents: Cents) {
  const leftover = withdrawnCents - deliveredCents;
  return { leftoverCents: leftover, balanced: leftover === 0n, shortfall: leftover < 0n };
}
