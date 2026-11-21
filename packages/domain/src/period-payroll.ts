// Nómina de UNA persona en UN periodo: junta conceptos de pago, rebaja por retardo,
// ingresos extra y descuentos autorizados. Todo en centavos (bigint).
import { mulDivRound, type Cents } from './payroll.ts';
import { conceptEarnings, hourlyRateForLate, type Concept, type WorkDay } from './concepts.ts';
import { deductionsForPeriod, totalDeductions, type Deduction, type Period } from './deductions.ts';
import type { LoanLine } from './loans.ts';

export interface PeriodDay extends WorkDay { late: boolean; scheduled?: boolean }
export type DayStatus = '' | 'Tarde' | 'Falta' | 'Justificada';
export interface PeriodInput {
  period: Period;
  payDate: string;
  days: PeriodDay[];
  concepts: Concept[];
  lateDeductionBps: number;        // 2500 = 25 % de una hora por cada retardo
  extras: Deduction[];             // ingresos extra (misma forma que descuentos)
  deductions: Deduction[];
  loanLines?: LoanLine[];          // préstamos del periodo (loanLinesForPeriod)
}
export interface PeriodLine {
  payDate: string;
  grossCents: Cents; deductionCents: Cents; netCents: Cents;
  reportedCents: Cents;            // como en el Excel: neta + préstamos (lo que se paga antes de préstamos)
  detail: {
    days: { date: string; minutes: number; status: DayStatus }[];
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

  const loanLines = i.loanLines ?? [];
  const loans = loanLines.reduce((n, l) => n + l.amountCents, 0n);
  const gross = conceptsTotal + totalDeductions(extras);
  const deduction = lateTotal + totalDeductions(deds) + loans;
  const net = gross - deduction;
  if (net < 0n) warnings.push('El neto es negativo: revisa descuentos.');
  if (loans > 0n && loans * 10n > gross * 3n) warnings.push('El descuento por préstamos supera el 30 % de lo que gana en el periodo: revisa el límite legal (art. 110 LFT).');

  return {
    payDate: i.payDate, grossCents: gross, deductionCents: deduction, netCents: net, reportedCents: net + loans,
    detail: {
      days: i.days.filter(d => d.scheduled || d.attended || d.paidMinutes > 0 || d.excused).map(d => ({
        date: d.date, minutes: d.paidMinutes,
        status: (d.excused ? 'Justificada' : !d.attended && d.scheduled ? 'Falta' : d.late ? 'Tarde' : '') as DayStatus })),
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
