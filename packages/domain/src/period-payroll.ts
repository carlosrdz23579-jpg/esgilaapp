// Nómina de UNA persona en UN periodo: junta conceptos de pago, rebaja por retardo,
// ingresos extra y descuentos autorizados. Todo en centavos (bigint).
import { mulDivRound, type Cents } from './payroll.ts';
import { conceptEarnings, hourlyRateForLate, type Concept, type WorkDay } from './concepts.ts';
import { deductionsForPeriod, totalDeductions, type Deduction, type Period } from './deductions.ts';
import type { LoanLine } from './loans.ts';

/** projected: día posterior al último reporte del checador; se paga según su horario hasta tener checadas. */
export interface PeriodDay extends WorkDay { late: boolean; scheduled?: boolean; warmupInactive?: boolean; projected?: boolean }
export type DayStatus = '' | 'Tarde' | 'Falta' | 'Justificada' | 'Proyectado';
export interface PeriodInput {
  period: Period;
  payDate: string;
  days: PeriodDay[];
  concepts: Concept[];
  lateDeductionBps: number;        // 2500 = 25 % de una hora por cada retardo
  extras: Deduction[];             // ingresos extra (misma forma que descuentos)
  deductions: Deduction[];
  loanLines?: LoanLine[];          // préstamos del periodo (loanLinesForPeriod)
  manual?: { label: string; amountCents: Cents }[];   // ajustes a mano: + percepción, − descuento
  warmupApplies?: boolean;         // solo coaches (por defecto sí, para compatibilidad)
  warmupDeductionMin?: number;     // minutos descontados por día sin calentamiento activo (configurable; 30)
}
export interface PeriodLine {
  payDate: string;
  grossCents: Cents; deductionCents: Cents; netCents: Cents;
  reportedCents: Cents;            // como en el Excel: neta + préstamos (lo que se paga antes de préstamos)
  detail: {
    days: { date: string; minutes: number; status: DayStatus; scheduled: boolean; warmupInactive: boolean }[];
    warmup: { days: number; perDay: string; total: string } | null;
    manual: { label: string; amount: string }[];
    /** Datos con los que se calculó: permiten editar la línea a mano y recalcularla igual. */
    inputs: { concepts: { key: string; label: string; kind: string; amount: string; weekdays: number[] }[]; lateBps: number; warmupApplies?: boolean; warmupMin?: number;
      extras: { id: string; label: string; amount: string; kind: string; start: string; end: string | null }[];
      deductions: { id: string; label: string; amount: string; kind: string; start: string; end: string | null }[] };
    loans: string;
    loanLines: { loan_id: string; label: string; amount: string; skipped: boolean; balance_after: string }[];
    concepts: { key: string; label: string; kind: string; units: number; amount: string; detail: string }[];
    attendedDays: number; paidMinutes: number; faltas: number; excused: number; retardos: number;
    lateDeduction: { count: number; perLate: string; total: string } | null;
    extras: { label: string; amount: string }[];
    deductions: { label: string; amount: string }[];
    warnings: string[];
  };
}

export function computePeriodLine(i: PeriodInput): PeriodLine {
  const warnings: string[] = [];
  const lines = conceptEarnings(i.concepts, i.days);
  const conceptsTotal = lines.reduce((n, l) => n + l.amountCents, 0n);
  const extras = deductionsForPeriod(i.extras, i.period);
  const deds = deductionsForPeriod(i.deductions, i.period);

  const retardos = i.days.filter(d => d.late).length;
  const rate = hourlyRateForLate(i.concepts);
  let late: PeriodLine['detail']['lateDeduction'] = null;
  let lateTotal = 0n;
  if (retardos > 0 && rate !== null) {
    const per = mulDivRound(rate, BigInt(i.lateDeductionBps), 10000n);
    lateTotal = per * BigInt(retardos);
    late = { count: retardos, perLate: per.toString(), total: lateTotal.toString() };
  }
  if (i.concepts.length === 0) warnings.push('Sin conceptos de pago vigentes: no se le calcula nada.');

  // Calentamiento (solo coaches): el día que no trabajó activamente en el calentamiento se descuentan
  // 30 minutos de su tarifa por hora o de su tarifa base.
  const warmApplies = i.warmupApplies ?? true;
  const warmDays = warmApplies ? i.days.filter(d => d.warmupInactive && d.attended).length : 0;
  let warmup: PeriodLine['detail']['warmup'] = null; let warmTotal = 0n;
  if (warmDays > 0) {
    if (rate === null) warnings.push(`${warmDays} día(s) sin calentamiento activo, pero no tiene tarifa por hora ni tarifa base: no se descontó.`);
    else { const per = mulDivRound(rate, BigInt(i.warmupDeductionMin ?? 30), 60n); warmTotal = per * BigInt(warmDays); warmup = { days: warmDays, perDay: per.toString(), total: warmTotal.toString() }; }
  }
  const manual = i.manual ?? [];
  const manualPlus = manual.filter(m => m.amountCents > 0n).reduce((n, m) => n + m.amountCents, 0n);
  const manualMinus = manual.filter(m => m.amountCents < 0n).reduce((n, m) => n - m.amountCents, 0n);

  const loanLines = i.loanLines ?? [];
  const loans = loanLines.reduce((n, l) => n + l.amountCents, 0n);
  const gross = conceptsTotal + totalDeductions(extras) + manualPlus;
  const deduction = lateTotal + warmTotal + totalDeductions(deds) + loans + manualMinus;
  const net = gross - deduction;
  if (net < 0n) warnings.push('El neto es negativo: revisa descuentos.');
  const proj = i.days.filter(d => d.projected).length;
  if (proj) warnings.push(`${proj} día(s) sin reporte del checador: se pagaron según su horario. Recalcula al subir el reporte.`);
  if (loans > 0n && loans * 10n > gross * 3n) warnings.push('El descuento por préstamos supera el 30 % de lo que gana en el periodo: revisa el límite legal (art. 110 LFT).');

  return {
    payDate: i.payDate, grossCents: gross, deductionCents: deduction, netCents: net, reportedCents: net + loans,
    detail: {
      days: i.days.filter(d => d.scheduled || d.attended || d.paidMinutes > 0 || d.excused).map(d => ({
        date: d.date, minutes: d.paidMinutes, scheduled: !!d.scheduled, warmupInactive: warmApplies && !!d.warmupInactive,
        status: (d.projected ? 'Proyectado' : d.excused ? 'Justificada' : !d.attended && d.scheduled ? 'Falta' : d.late ? 'Tarde' : '') as DayStatus })),
      warmup,
      manual: manual.map(m => ({ label: m.label, amount: m.amountCents.toString() })),
      inputs: {
        concepts: i.concepts.map(c => ({ key: c.key, label: c.label, kind: c.kind, amount: c.amountCents.toString(), weekdays: [...c.weekdays] })),
        lateBps: i.lateDeductionBps, warmupApplies: warmApplies, warmupMin: i.warmupDeductionMin ?? 30,
        extras: i.extras.map(e => ({ id: e.id, label: e.label, amount: e.amountCents.toString(), kind: e.kind, start: e.startDate, end: e.endDate ?? null })),
        deductions: i.deductions.map(e => ({ id: e.id, label: e.label, amount: e.amountCents.toString(), kind: e.kind, start: e.startDate, end: e.endDate ?? null })),
      },
      loans: loans.toString(),
      loanLines: loanLines.map(l => ({ loan_id: l.loanId, label: l.label, amount: l.amountCents.toString(), skipped: l.skipped, balance_after: l.balanceAfterCents.toString() })),
      concepts: lines.map(l => ({ key: l.key, label: l.label, kind: l.kind, units: l.units, amount: l.amountCents.toString(), detail: l.detail })),
      attendedDays: i.days.filter(d => d.attended).length,
      paidMinutes: i.days.reduce((n, d) => n + d.paidMinutes, 0),
      faltas: i.days.filter(d => !d.attended && !d.excused && (d.scheduled ?? i.concepts.some(c => c.weekdays.includes(new Date(d.date + 'T12:00:00Z').getUTCDay())))).length,
      excused: i.days.filter(d => d.excused).length,
      retardos, lateDeduction: late,
      extras: extras.map(e => ({ label: e.label, amount: e.amountCents.toString() })),
      deductions: deds.map(e => ({ label: e.label, amount: e.amountCents.toString() })),
      warnings,
    },
  };
}

/**
 * Recalcula una línea ya guardada con días editados a mano y ajustes manuales, usando exactamente los
 * mismos conceptos, ingresos extra, descuentos y préstamos con los que se calculó.
 */
export function recomputeLine(prev: PeriodLine['detail'], period: Period, payDate: string,
  days: PeriodLine['detail']['days'], manual: { label: string; amountCents: Cents }[]): PeriodLine {
  const toDed = (e: PeriodLine['detail']['inputs']['extras'][number]): Deduction =>
    ({ id: e.id, label: e.label, amountCents: BigInt(e.amount), kind: e.kind as Deduction['kind'], startDate: e.start, endDate: e.end, status: 'autorizado' });
  return computePeriodLine({
    period, payDate, lateDeductionBps: prev.inputs.lateBps, manual, warmupApplies: prev.inputs.warmupApplies ?? true, warmupDeductionMin: prev.inputs.warmupMin ?? 30,
    concepts: prev.inputs.concepts.map(c => ({ key: c.key, label: c.label, kind: c.kind as Concept['kind'], amountCents: BigInt(c.amount), weekdays: c.weekdays })),
    days: days.map(d => ({ date: d.date, paidMinutes: d.minutes, scheduled: d.scheduled, warmupInactive: d.warmupInactive,
      attended: d.status !== 'Falta' && d.status !== 'Justificada' && (d.minutes > 0 || d.status === 'Tarde'),
      excused: d.status === 'Justificada', late: d.status === 'Tarde', projected: d.status === 'Proyectado' })),
    extras: prev.inputs.extras.map(toDed), deductions: prev.inputs.deductions.map(toDed),
    loanLines: prev.loanLines.map(l => ({ loanId: l.loan_id, label: l.label, amountCents: BigInt(l.amount), skipped: l.skipped, balanceAfterCents: BigInt(l.balance_after) })),
  });
}
