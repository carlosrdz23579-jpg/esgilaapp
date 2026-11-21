// Pago de préstamos en un periodo. Centavos (bigint).
import type { Cents } from './payroll.ts';
import type { Period } from './deductions.ts';

export interface Loan {
  id: string; label: string; lender: 'empresa' | 'director';
  totalCents: Cents;            // capital + interés
  paidCents: Cents;             // abonos registrados (nómina autorizada + manuales − reversas)
  installmentCents: Cents;
  startDate: string;
  status: 'pendiente' | 'activo' | 'rechazado' | 'liquidado' | 'cancelado';
}
export interface LoanSkip { loanId: string; date: string; status: 'pendiente' | 'autorizado' | 'rechazado' }
export interface LoanLine { loanId: string; label: string; amountCents: Cents; skipped: boolean; balanceAfterCents: Cents }

/** Lo que se descuenta de cada préstamo en el periodo: min(parcialidad, saldo), salvo salto autorizado. */
export function loanLinesForPeriod(loans: readonly Loan[], skips: readonly LoanSkip[], p: Period): LoanLine[] {
  return loans
    .filter(l => l.status === 'activo' && l.startDate <= p.end)
    .map(l => {
      const balance = l.totalCents - l.paidCents;
      const skipped = skips.some(s => s.loanId === l.id && s.status === 'autorizado' && s.date >= p.start && s.date <= p.end);
      const amount = skipped || balance <= 0n ? 0n : (l.installmentCents < balance ? l.installmentCents : balance);
      return { loanId: l.id, label: l.label, amountCents: amount, skipped, balanceAfterCents: balance - amount };
    })
    .filter(x => x.amountCents > 0n || x.skipped);
}
