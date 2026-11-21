// Importación de reportes de reloj checador y evaluación contra el horario.
// Sin dependencias: recibe la hoja ya convertida a una matriz de textos (la UI usa SheetJS para leer el .xls).
// Formatos probados: CAR (hoja "Registro asistencia") y Viñedos (hoja "Registros"). Ambos traen,
// por persona, una fila "ID/No" con número de checador, nombre y departamento, y debajo una fila
// con las checadas de cada día separadas por saltos de línea.

export interface CheckerPerson {
  deviceId: string;           // número de la persona en el checador (no es único entre sucursales)
  name: string;               // nombre tal como está en el checador (solo referencia)
  dept: string;
  punches: Record<string, string[]>;   // 'YYYY-MM-DD' -> ['HH:MM', …] en orden
}
export interface CheckerReport { from: string; to: string; people: CheckerPerson[] }

/** Nombres de hoja con checadas crudas, en orden de preferencia. */
export const RAW_SHEET_NAMES = ['Registro asistencia', 'Registros'];

const pad = (n: number) => String(n).padStart(2, '0');
const addDays = (iso: string, n: number) => {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim();

/** "14/10/2026 ~ 29/10/2026" (CAR) o "2026/10/15 ~ 10/29 ( ESGILA )" (Viñedos). */
export function parseRange(text: string): { from: string; to: string } {
  const [a, b] = text.split('~').map(s => s.trim());
  if (!a || !b) throw new Error(`No se reconoce el rango de fechas: "${text}"`);
  let m = a.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const n = b.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!n) throw new Error(`No se reconoce la fecha final: "${b}"`);
    return { from: `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`, to: `${n[3]}-${pad(+n[2])}-${pad(+n[1])}` };
  }
  m = a.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) {
    const n = b.match(/^(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})/);
    if (!n) throw new Error(`No se reconoce la fecha final: "${b}"`);
    let y = n[1] ? +n[1] : +m[1];
    if (!n[1] && +n[2] < +m[2]) y += 1;                      // p. ej. 2026/12/20 ~ 01/04
    return { from: `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`, to: `${y}-${pad(+n[2])}-${pad(+n[3])}` };
  }
  throw new Error(`No se reconoce el rango de fechas: "${text}"`);
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseCheckerSheet(rows: unknown[][]): CheckerReport {
  const g = rows.map(r => r.map(cell));
  // Rango: la fila que empieza con "Date :" o "Duracion:" trae el texto en alguna celda con "~".
  const rangeRow = g.find(r => /^(date|duraci[oó]n|fecha)\s*:/i.test(r[0] ?? ''));
  const rangeText = rangeRow?.find(c => c.includes('~'));
  if (!rangeText) throw new Error('No se encontró el rango de fechas del reporte');
  const { from, to } = parseRange(rangeText);

  // Columnas -> fechas a partir de la fila de días (14, 15, 16…).
  let colDates: (string | null)[] = [];
  const dayHeader = (r: string[]) => {
    const nums = r.map(c => (/^\d{1,2}(\.0)?$/.test(c) ? +c : null));
    return nums[0] !== null && nums.filter(x => x !== null).length >= 2 ? nums : null;
  };
  const mapHeader = (nums: (number | null)[]) => {
    let d = from; const out: (string | null)[] = [];
    for (const n of nums) {
      if (n === null) { out.push(null); continue; }
      let guard = 0;
      while (+d.slice(8, 10) !== n && guard++ < 40) d = addDays(d, 1);
      if (guard >= 40) throw new Error(`El día ${n} no encaja en el rango ${from} ~ ${to}`);
      out.push(d); d = addDays(d, 1);
    }
    return out;
  };

  const people: CheckerPerson[] = [];
  for (let i = 0; i < g.length; i++) {
    const r = g[i];
    const h = dayHeader(r);
    if (h) { colDates = mapHeader(h); continue; }
    if (!/^(id|no)\s*:?$/i.test(r[0] ?? '')) continue;
    if (colDates.length === 0) throw new Error('Se encontró una persona antes de la fila de días');
    const after = (label: RegExp) => { const k = r.findIndex(c => label.test(c)); return k < 0 ? '' : r.slice(k + 1).find(c => c !== '') ?? ''; };
    const deviceId = r.slice(1).find(c => c !== '') ?? '';
    const p: CheckerPerson = { deviceId, name: after(/^nombre\s*:?$/i), dept: after(/^dep(t|to)\.?\s*:?$/i), punches: {} };
    const next = g[i + 1] ?? [];
    if (!dayHeader(next) && !/^(id|no)\s*:?$/i.test(next[0] ?? '')) {
      colDates.forEach((date, c) => {
        if (!date) return;
        const times = (next[c] ?? '').split(/[\r\n|]+/).map(s => s.trim()).filter(Boolean);
        const bad = times.find(t => !TIME.test(t));
        if (bad) throw new Error(`Checada no reconocida "${bad}" (persona ${deviceId}, ${date})`);
        if (times.length) p.punches[date] = times.map(t => t.padStart(5, '0')).sort();
      });
      i++;
    }
    if (deviceId) people.push(p);
  }
  if (people.length === 0) throw new Error('No se encontraron personas en el reporte');
  return { from, to, people };
}

// ---------------------------------------------------------------------------
// Evaluación de un día contra el horario
// ---------------------------------------------------------------------------
export interface Block { start: string; end: string }   // 'HH:MM'
export type DayIssue =
  | 'falta'               // tenía horario y no checó
  | 'retardo'             // llegó después de la tolerancia
  | 'salida_temprana'
  | 'checada_incompleta'  // número impar de checadas
  | 'fuera_de_horario'    // bloque trabajado que no coincide con su horario (¿clase extra, curso, competencia?)
  | 'sin_horario';        // checó un día que no tenía horario

export interface DayEvaluation {
  date: string;
  scheduledMinutes: number;
  paidMinutes: number;          // solo dentro del horario (llegar antes no cuenta)
  lateMinutes: number;          // pasados de la hora de entrada (0 si está dentro de la tolerancia)
  earlyLeaveMinutes: number;
  outsideBlocks: Block[];       // trabajo fuera del horario: se paga solo si se aprueba
  issues: DayIssue[];
}

const toMin = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const toHHMM = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/**
 * Reglas (confirmadas con ESGILA):
 * - Las horas pagadas son las del horario: llegar antes o salir después no suma.
 * - Tolerancia (15 min por defecto; configurable por empresa): si entra dentro de ella no es retardo.
 * - Retardo: se pagan TODAS las horas del horario; la sanción es aparte (25 % de una hora,
 *   en computePayroll). Los minutos tarde solo se informan.
 * - Un bloque de checadas que no toca el horario (p. ej. 06:00–08:00 con horario 16:00–20:00)
 *   no se paga solo: se marca "fuera_de_horario" para que el nominista lo apruebe como clase extra.
 */
export function evaluateDay(date: string, punches: string[], schedule: Block[], toleranceMin = 15): DayEvaluation {
  const blocks = schedule.map(b => ({ s: toMin(b.start), e: toMin(b.end) })).filter(b => b.e > b.s).sort((a, b) => a.s - b.s);
  const scheduled = blocks.reduce((n, b) => n + (b.e - b.s), 0);
  const ev: DayEvaluation = { date, scheduledMinutes: scheduled, paidMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, outsideBlocks: [], issues: [] };
  const ts = [...punches].map(toMin).sort((a, b) => a - b);

  if (ts.length === 0) { if (scheduled > 0) ev.issues.push('falta'); return ev; }
  if (scheduled === 0) ev.issues.push('sin_horario');
  if (ts.length % 2 === 1) ev.issues.push('checada_incompleta');

  const pairs: { s: number; e: number }[] = [];
  for (let i = 0; i + 1 < ts.length; i += 2) pairs.push({ s: ts[i], e: ts[i + 1] });

  for (const b of blocks) {
    const touching = pairs.filter(p => p.e > b.s && p.s < b.e);
    if (touching.length === 0) { ev.issues.push('falta'); continue; }
    const firstIn = Math.min(...touching.map(p => p.s));
    const lastOut = Math.max(...touching.map(p => p.e));
    if (firstIn > b.s + toleranceMin) { ev.lateMinutes += firstIn - b.s; if (!ev.issues.includes('retardo')) ev.issues.push('retardo'); }
    if (lastOut < b.e) { ev.earlyLeaveMinutes += b.e - lastOut; if (!ev.issues.includes('salida_temprana')) ev.issues.push('salida_temprana'); }
    for (const p of touching) {
      const s = p.s === firstIn ? b.s : Math.max(p.s, b.s), e = Math.min(p.e, b.e);   // llegar tarde no descuenta minutos
      if (e > s) ev.paidMinutes += e - s;
    }
  }
  for (const p of pairs) if (!blocks.some(b => p.e > b.s && p.s < b.e)) ev.outsideBlocks.push({ start: toHHMM(p.s), end: toHHMM(p.e) });
  if (ev.outsideBlocks.length && scheduled > 0) ev.issues.push('fuera_de_horario');
  // Una "falta" repetida por bloque se deja una sola vez.
  ev.issues = [...new Set(ev.issues)];
  if (ev.issues.includes('falta') && ev.paidMinutes > 0) ev.issues = ev.issues.filter(i => i !== 'falta').concat('salida_temprana');
  ev.issues = [...new Set(ev.issues)];
  return ev;
}
