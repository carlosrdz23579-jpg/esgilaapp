// Calendario de pagos. Sin dependencias. Fechas como 'YYYY-MM-DD' (calendario, sin zona horaria).
export type Frequency = 'semanal' | 'quincenal' | 'mensual';
export type WeekendRule = 'antes' | 'despues' | 'ninguno';

export interface ScheduleConfig {
  frequency: Frequency;
  weeklyWeekday?: number;            // 0 domingo … 6 sábado
  biweeklyDays?: [number, number];   // p. ej. [15, 31]; 31 = último día del mes
  monthlyDay?: number;               // 31 = último día del mes
  weekendRule: WeekendRule;
  holidays?: ReadonlySet<string>;    // días inhábiles 'YYYY-MM-DD'
}

/** Un periodo termina en su fecha nominal; el pago puede moverse por fin de semana/inhábil. */
export interface PayPeriod { start: string; end: string; payDate: string }

const DAY = 86400000;
const toMs = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');
export const addDays = (iso: string, n: number) => toIso(toMs(iso) + n * DAY);
export const weekdayOf = (iso: string) => new Date(toMs(iso)).getUTCDay();

function monthDay(y: number, m0: number, d: number): string {
  return `${y}-${pad(m0 + 1)}-${pad(Math.min(d, daysInMonth(y, m0)))}`;
}

function nominalEnds(cfg: ScheduleConfig, from: string, to: string): string[] {
  const lo = addDays(from, -45), hi = addDays(to, 45);
  const out = new Set<string>();
  if (cfg.frequency === 'semanal') {
    if (cfg.weeklyWeekday === undefined) throw new Error('Falta el día de la semana');
    for (let d = lo; d <= hi; d = addDays(d, 1)) if (weekdayOf(d) === cfg.weeklyWeekday) out.add(d);
  } else {
    const days = cfg.frequency === 'quincenal'
      ? cfg.biweeklyDays
      : cfg.monthlyDay === undefined ? undefined : [cfg.monthlyDay];
    if (!days || days.length === 0) throw new Error('Faltan los días de pago');
    if (cfg.frequency === 'quincenal' && !(days[0] < days[1])) throw new Error('El primer día de pago debe ser menor que el segundo');
    let y = +lo.slice(0, 4), m = +lo.slice(5, 7) - 1;
    const endY = +hi.slice(0, 4), endM = +hi.slice(5, 7) - 1;
    while (y < endY || (y === endY && m <= endM)) {
      for (const d of days) { const iso = monthDay(y, m, d); if (iso >= lo && iso <= hi) out.add(iso); }
      m++; if (m > 11) { m = 0; y++; }
    }
  }
  return [...out].sort();
}

const isBusinessDay = (iso: string, holidays?: ReadonlySet<string>) => {
  const w = weekdayOf(iso);
  return w !== 0 && w !== 6 && !(holidays?.has(iso));
};

export function adjustPayDate(iso: string, rule: WeekendRule, holidays?: ReadonlySet<string>): string {
  if (rule === 'ninguno') return iso;
  const step = rule === 'antes' ? -1 : 1;
  let d = iso;
  for (let i = 0; i < 20 && !isBusinessDay(d, holidays); i++) d = addDays(d, step);
  return d;
}

/** Periodos cuyo fin nominal cae entre `from` y `to` (inclusive). */
export function periodsBetween(cfg: ScheduleConfig, from: string, to: string): PayPeriod[] {
  const ends = nominalEnds(cfg, from, to);
  const res: PayPeriod[] = [];
  for (let i = 1; i < ends.length; i++) {
    const end = ends[i];
    if (end < from || end > to) continue;
    res.push({ start: addDays(ends[i - 1], 1), end, payDate: adjustPayDate(end, cfg.weekendRule, cfg.holidays) });
  }
  return res;
}
