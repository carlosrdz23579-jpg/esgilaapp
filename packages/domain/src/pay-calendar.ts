// Calendario de pagos. Sin dependencias. Fechas como 'YYYY-MM-DD' (calendario, sin zona horaria).
export type Frequency = 'semanal' | 'quincenal' | 'mensual';
export type WeekendRule = 'antes' | 'despues' | 'ninguno';
/** 'dia_anterior': el día de pago NO entra en el periodo que se paga (cuenta en el siguiente). Regla de ESGILA.
 *  'dia_de_pago': el periodo termina el mismo día de pago. */
export type Cutoff = 'dia_anterior' | 'dia_de_pago';
/** Días que trabaja la persona (0 domingo … 6 sábado). Por defecto lunes a sábado. */
export const DEFAULT_WORK_DAYS: readonly number[] = [1, 2, 3, 4, 5, 6];

export interface ScheduleConfig {
  frequency: Frequency;
  weeklyWeekday?: number;            // 0 domingo … 6 sábado
  biweeklyDays?: [number, number];   // p. ej. [15, 31]; 31 = último día del mes
  monthlyDay?: number;               // 31 = último día del mes
  weekendRule: WeekendRule;
  cutoff?: Cutoff;                   // por defecto 'dia_anterior'
  workDays?: readonly number[];      // días laborables de la persona; por defecto lunes a sábado
  holidays?: ReadonlySet<string>;    // días inhábiles 'YYYY-MM-DD'
}

/** `nominal` es la fecha de pago del calendario (15, último día…). El periodo se corta respecto a ella
 *  (nunca respecto al pago real), así ninguna quincena se alarga ni se acorta. `payDate` es cuándo se paga
 *  realmente a esa persona: si `nominal` no es laborable para ella, su último día laborable anterior (regla 'antes'). */
export interface PayPeriod { start: string; end: string; nominal: string; payDate: string }

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

const isWorkDay = (iso: string, workDays: readonly number[], holidays?: ReadonlySet<string>) =>
  workDays.includes(weekdayOf(iso)) && !(holidays?.has(iso));

export function adjustPayDate(iso: string, rule: WeekendRule, holidays?: ReadonlySet<string>,
  workDays: readonly number[] = DEFAULT_WORK_DAYS): string {
  if (rule === 'ninguno') return iso;
  if (workDays.length === 0) throw new Error('La persona no tiene días laborables configurados');
  const step = rule === 'antes' ? -1 : 1;
  let d = iso;
  for (let i = 0; i < 20 && !isWorkDay(d, workDays, holidays); i++) d = addDays(d, step);
  if (!isWorkDay(d, workDays, holidays)) throw new Error(`No se encontró día laborable cerca de ${iso}`);
  return d;
}

/** Periodos cuya fecha de pago nominal cae entre `from` y `to` (inclusive). */
export function periodsBetween(cfg: ScheduleConfig, from: string, to: string): PayPeriod[] {
  const noms = nominalEnds(cfg, from, to);
  const shift = (cfg.cutoff ?? 'dia_anterior') === 'dia_anterior' ? 0 : 1;
  const res: PayPeriod[] = [];
  for (let i = 1; i < noms.length; i++) {
    const nominal = noms[i];
    if (nominal < from || nominal > to) continue;
    res.push({
      start: addDays(noms[i - 1], shift),
      end: addDays(nominal, shift - 1),
      nominal,
      payDate: adjustPayDate(nominal, cfg.weekendRule, cfg.holidays, cfg.workDays ?? DEFAULT_WORK_DAYS),
    });
  }
  return res;
}
