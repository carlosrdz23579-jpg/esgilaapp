// Asistencia de un día: qué horario aplica (base + excepciones) y cómo quedan las excepciones
// después de la revisión del nominista. Sin dependencias.
import { evaluateDay, type Block, type DayEvaluation, type DayIssue } from './checador.ts';

export interface WeeklyBlock { weekday: number; start: string; end: string }   // 0 domingo … 6 sábado
export type ExceptionKind = 'clase_extra' | 'curso' | 'competencia' | 'sin_actividad' | 'otro';
export interface DayException { date: string; kind: ExceptionKind; blocks: Block[]; replacesBase: boolean }

const weekday = (iso: string) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))).getUTCDay();

/** Horario de una fecha: el base de ese día de la semana, más (o en lugar de) las excepciones del día. */
export function blocksForDate(date: string, weekly: readonly WeeklyBlock[], exceptions: readonly DayException[]): Block[] {
  const ex = exceptions.filter(e => e.date === date);
  const extra = ex.filter(e => e.kind !== 'sin_actividad').flatMap(e => e.blocks);
  const base = weekly.filter(b => b.weekday === weekday(date)).map(b => ({ start: b.start, end: b.end }));
  if (ex.some(e => e.replacesBase || e.kind === 'sin_actividad')) return sortBlocks(extra);
  return sortBlocks([...base, ...extra]);
}
const sortBlocks = (b: Block[]) => [...b].sort((x, y) => x.start.localeCompare(y.start));

// ---- Revisión del nominista ----
export type ReviewKind =
  | 'aprobar_extra'       // el trabajo fuera de horario se paga (clase extra, curso…)
  | 'justificar_falta'    // permiso, incapacidad, vacaciones: no se descuenta
  | 'quitar_retardo'      // el retardo no cuenta
  | 'corregir_checadas'   // reemplaza las checadas del día (p. ej. olvidó checar salida)
  | 'aceptar';            // se revisó y se deja como está
export interface Review { date: string; kind: ReviewKind; times?: string[]; reason: string }

export interface ReviewedDay extends DayEvaluation {
  punches: string[];
  approvedExtraMinutes: number;
  excused: boolean;
  attended: boolean;
  pending: DayIssue[];      // lo que falta revisar
  resolvedBy: ReviewKind[];
}

const minutes = (b: Block) => (+b.end.slice(0, 2) * 60 + +b.end.slice(3)) - (+b.start.slice(0, 2) * 60 + +b.start.slice(3));

export function reviewDay(date: string, rawPunches: readonly string[], blocks: readonly Block[], toleranceMin: number,
  reviews: readonly Review[]): ReviewedDay {
  const mine = reviews.filter(r => r.date === date);
  const fix = [...mine].reverse().find(r => r.kind === 'corregir_checadas');
  const punches = [...(fix?.times ?? rawPunches)].sort();
  const ev = evaluateDay(date, punches, [...blocks], toleranceMin);
  const kinds = new Set(mine.map(r => r.kind));
  let pending = [...ev.issues];
  let approvedExtraMinutes = 0;
  if (kinds.has('aprobar_extra')) {
    approvedExtraMinutes = ev.outsideBlocks.reduce((n, b) => n + minutes(b), 0);
    pending = pending.filter(i => i !== 'fuera_de_horario' && i !== 'sin_horario');
  }
  const excused = kinds.has('justificar_falta');
  if (excused) pending = pending.filter(i => i !== 'falta');
  const lateMinutes = kinds.has('quitar_retardo') ? 0 : ev.lateMinutes;
  if (kinds.has('quitar_retardo')) pending = pending.filter(i => i !== 'retardo');
  if (kinds.has('aceptar')) pending = [];
  const issues = kinds.has('quitar_retardo') ? ev.issues.filter(i => i !== 'retardo') : ev.issues;
  return {
    ...ev, issues, lateMinutes, punches, approvedExtraMinutes, excused,
    paidMinutes: ev.paidMinutes + approvedExtraMinutes,
    attended: punches.length >= 2,
    pending, resolvedBy: [...kinds],
  };
}

export const ISSUE_LABEL: Record<DayIssue, string> = {
  falta: 'Falta', retardo: 'Retardo', salida_temprana: 'Salida temprana', checada_incompleta: 'Checada incompleta',
  fuera_de_horario: 'Trabajo fuera de horario', sin_horario: 'Checó sin tener horario',
};

/**
 * Sugiere un horario base a partir de las checadas: por cada día de la semana con al menos
 * `minDays` días completos (entrada y salida), toma la mediana de entrada y de salida redondeadas
 * a 30 minutos. Es solo una propuesta: el nominista la revisa antes de guardarla.
 */
export function suggestWeekly(punchesByDate: Record<string, readonly string[]>, minDays = 2): WeeklyBlock[] {
  const toMin = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const round30 = (m: number) => Math.round(m / 30) * 30;
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
  const byDay: Record<number, { ins: number[]; outs: number[] }> = {};
  for (const [date, times] of Object.entries(punchesByDate)) {
    if (times.length < 2) continue;
    const s = [...times].sort();
    const w = weekday(date);
    (byDay[w] ??= { ins: [], outs: [] }).ins.push(toMin(s[0]));
    byDay[w].outs.push(toMin(s[s.length - 1]));
  }
  return Object.entries(byDay)
    .filter(([, v]) => v.ins.length >= minDays)
    .map(([w, v]) => ({ weekday: +w, start: fmt(round30(median(v.ins))), end: fmt(round30(median(v.outs))) }))
    .filter(b => b.end > b.start)
    .sort((a, b) => a.weekday - b.weekday);
}
