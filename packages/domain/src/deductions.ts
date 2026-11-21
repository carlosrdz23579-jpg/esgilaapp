// Descuentos autorizados (distintos de préstamos y de la rebaja por retardo).
// Solo se aplican los AUTORIZADOS. Único: en el periodo que contiene su fecha. Recurrente: en cada
// periodo desde su fecha de inicio hasta su fecha de fin (o hasta cancelarlo).
import type { Cents } from './payroll.ts';

export type DeductionStatus = 'pendiente' | 'autorizado' | 'rechazado' | 'cancelado';
export interface Deduction {
  id: string; label: string; amountCents: Cents;
  kind: 'unico' | 'recurrente';
  startDate: string; endDate?: string | null;   // recurrente: fin opcional (inclusive)
  status: DeductionStatus;
}
export interface Period { start: string; end: string }

export function deductionsForPeriod(list: readonly Deduction[], p: Period): Deduction[] {
  return list.filter(d => d.status === 'autorizado' && (
    d.kind === 'unico'
      ? d.startDate >= p.start && d.startDate <= p.end
      : d.startDate <= p.end && (!d.endDate || d.endDate >= p.start)));
}

export const totalDeductions = (list: readonly Deduction[]): Cents => list.reduce((n, d) => n + d.amountCents, 0n);
