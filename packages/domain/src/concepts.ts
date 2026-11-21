// Pago por conceptos: una persona puede cobrar por hora, por día y/o un fijo por periodo,
// y tener varios conceptos a la vez (p. ej. portero por día + limpieza por día de lunes a viernes).
// Todo en enteros: centavos y minutos.
import { mulDivRound, type Cents } from './payroll.ts';

export type ConceptKind = 'por_hora' | 'por_dia' | 'fijo';
export interface Concept {
  key: string; label: string; kind: ConceptKind; amountCents: Cents;
  weekdays: readonly number[];          // días de la semana en que aplica (0 domingo … 6 sábado)
}
export interface WorkDay {
  date: string;                         // YYYY-MM-DD
  paidMinutes: number;                  // minutos pagables (dentro de horario + extras aprobadas)
  attended: boolean;                    // hubo asistencia ese día (basta una entrada y una salida)
  excused?: boolean;                    // falta justificada (permiso, incapacidad, vacaciones): no se descuenta
}
export interface ConceptLine { key: string; label: string; kind: ConceptKind; units: number; amountCents: Cents; detail: string }

const weekday = (iso: string) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))).getUTCDay();

/**
 * Percepciones del periodo por concepto.
 * - por_hora: minutos pagados en los días que aplica × tarifa/60.
 * - por_dia:  cada día con asistencia que cae en sus días de la semana.
 * - fijo:     el monto del periodo menos las faltas injustificadas en sus días:
 *             valor del día = monto / días que cubre en el periodo (p. ej. $1,800 lun–sáb = $300 por día).
 *             La falta aparece como línea propia para que se vea, nunca se descuenta en silencio.
 */
export function conceptEarnings(concepts: readonly Concept[], days: readonly WorkDay[]): ConceptLine[] {
  return concepts.map(c => {
    const applies = days.filter(d => c.weekdays.includes(weekday(d.date)));
    if (c.kind === 'por_hora') {
      const minutes = applies.reduce((n, d) => n + d.paidMinutes, 0);
      return { key: c.key, label: c.label, kind: c.kind, units: minutes,
        amountCents: mulDivRound(BigInt(minutes), c.amountCents, 60n), detail: `${Math.floor(minutes / 60)} h ${minutes % 60} min` };
    }
    if (c.kind === 'por_dia') {
      const n = applies.filter(d => d.attended).length;
      return { key: c.key, label: c.label, kind: c.kind, units: n, amountCents: BigInt(n) * c.amountCents, detail: `${n} día(s)` };
    }
    const faltas = applies.filter(d => !d.attended && !d.excused).length;
    const discount = applies.length === 0 ? 0n : mulDivRound(c.amountCents, BigInt(faltas), BigInt(applies.length));
    return { key: c.key, label: c.label, kind: c.kind, units: applies.length - faltas, amountCents: c.amountCents - discount,
      detail: faltas === 0 ? 'fijo del periodo completo'
        : `fijo ${fmt(c.amountCents)} − ${faltas} falta(s) de ${applies.length} día(s) = ${fmt(c.amountCents - discount)}` };
  });
}

const fmt = (c: Cents) => `$${(c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${c % 100n ? '.' + (c % 100n).toString().padStart(2, '0') : ''}`;

/** Tarifa de "una hora" para la rebaja por retardo: la del concepto por hora, si existe. */
export function hourlyRateForLate(concepts: readonly Concept[]): Cents | null {
  const h = concepts.find(c => c.kind === 'por_hora');
  return h ? h.amountCents : null;
}
