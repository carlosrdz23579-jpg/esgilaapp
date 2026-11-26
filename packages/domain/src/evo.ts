// Lector del reporte de EVO "Asistencia Mensual por Instructor" (Lista de chamada mensal).
// La hoja trae, por bloque: "Grupo de actividades", "Actividad *X", "De: hh:mm Hasta: hh:mm",
// una fila con los números de día del mes y, por alumna, una fila con nombre, "ID:", teléfono
// y una letra (L, M, J…) en cada día que le toca; abajo, "Fec. Nacimiento" y "Fecha inscripción".

export interface EvoStudent {
  evoId: string; name: string; phone: string | null; birth: string | null; enrolled: string | null;
  days: number[]; weekdays: number[];
}
export interface EvoClass { activity: string; start: string; end: string; students: EvoStudent[] }
export interface EvoReport { month: number; year: number; classes: EvoClass[]; warnings: string[] }

const txt = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim();

/** "16:00:00", "16:00", 0.6666 (fracción de día de Excel) → "16:00" */
export function evoTime(v: unknown): string | null {
  if (typeof v === 'number' && v >= 0 && v < 1) {
    const m = Math.round(v * 24 * 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }
  // Puede venir "16:00", "16:00:00", "4:00 PM" o con la fecha cero de Excel delante: "1/0/00 16:00".
  const m = txt(v).match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?\s*m\.?)?\s*$/i);
  if (!m) return null;
  let h = Number(m[1]); const pm = m[3] && /^p/i.test(m[3]);
  if (m[3]) { if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  return h <= 23 ? `${String(h).padStart(2, '0')}:${m[2]}` : null;
}
/** "02/06/2023" (dd/mm/aaaa) → "2023-06-02" */
export function evoDate(v: unknown): string | null {
  const m = txt(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

export function parseEvoSheet(rows: unknown[][]): EvoReport {
  const warnings: string[] = [];
  let month = 0, year = 0; let activity = ''; let start: string | null = null; let end: string | null = null;
  let dayCols = new Map<number, number>();
  const classes = new Map<string, EvoClass>();
  let last: EvoStudent | null = null;

  const findAfter = (row: unknown[], idx: number, pred: (v: unknown) => boolean) => {
    for (let j = idx + 1; j < row.length; j++) if (txt(row[j]) && pred(row[j])) return row[j];
    return undefined;
  };

  for (const row of rows) {
    const cells = row.map(txt);
    const at = (label: RegExp) => cells.findIndex(c => label.test(c));

    const iMes = at(/^Mes:?$/i);
    if (iMes >= 0) {
      const nums = row.slice(iMes + 1).map(v => Number(String(v).replace(/[^\d.]/g, ''))).filter(n => n > 0);
      if (nums.length >= 2) { month = nums[0]; year = Math.round(nums[1]); }
    }
    const iAct = at(/^Actividad$/i);
    if (iAct >= 0) { const v = findAfter(row, iAct, () => true); if (v) activity = txt(v).replace(/^\*/, '').trim(); }
    const iGrp = at(/^Grupo de actividades:?$/i);
    if (iGrp >= 0 && !activity) { const v = findAfter(row, iGrp, () => true); if (v) activity = txt(v); }
    const iDe = at(/^De:?$/i);
    if (iDe >= 0) {
      start = evoTime(findAfter(row, iDe, v => evoTime(v) !== null));
      const iH = at(/^Hasta:?$/i);
      end = iH >= 0 ? evoTime(findAfter(row, iH, v => evoTime(v) !== null)) : null;
    }
    // Fila de números de día: muchas celdas 1..31 consecutivas que empiezan en 1
    const nums = cells.map((c, j) => [j, /^\d{1,2}$/.test(c) ? Number(c) : 0] as const).filter(([, n]) => n >= 1 && n <= 31);
    if (nums.length >= 20 && nums[0][1] === 1 && at(/^ID:?$/i) < 0) { dayCols = new Map(nums.map(([j, n]) => [j, n])); continue; }

    const iId = at(/^ID:?$/i);
    if (iId >= 0) {
      const name = cells.slice(0, iId).filter(Boolean)[0] ?? '';
      const evoId = txt(findAfter(row, iId, () => true));
      const iTel = at(/^Tel[eé]fono:?$/i);
      const phone = iTel >= 0 ? txt(findAfter(row, iTel, v => !/^[LMJVSD]$/.test(txt(v)))) || null : null;
      const days = [...dayCols.entries()].filter(([j]) => /^[LMJVSD]$/i.test(cells[j] ?? '')).map(([, d]) => d).sort((a, b) => a - b);
      if (!name || !evoId) { warnings.push(`Fila sin nombre o ID: ${cells.filter(Boolean).join(' ')}`); continue; }
      if (!activity || !start || !end) { warnings.push(`${name}: no se encontró la actividad u horario`); continue; }
      const wds = month && year ? [...new Set(days.map(d => new Date(Date.UTC(year, month - 1, d)).getUTCDay()))].sort() : [];
      last = { evoId, name: name.replace(/\s+/g, ' '), phone, birth: null, enrolled: null, days, weekdays: wds };
      const key = `${activity}|${start}`;
      if (!classes.has(key)) classes.set(key, { activity, start, end, students: [] });
      classes.get(key)!.students.push(last);
      continue;
    }
    const iNac = at(/^Fec\.? ?Nacimiento:?$/i);
    if (iNac >= 0 && last) {
      last.birth = evoDate(findAfter(row, iNac, v => evoDate(v) !== null));
      const iIns = at(/^Fecha inscripci[oó]n:?$/i);
      if (iIns >= 0) last.enrolled = evoDate(findAfter(row, iIns, v => evoDate(v) !== null));
    }
  }
  if (!month || !year) warnings.push('No se encontró el mes del reporte');
  for (const c of classes.values()) for (const s of c.students) if (!s.days.length) warnings.push(`${s.name}: sin días marcados en ${c.activity}`);
  return { month, year, classes: [...classes.values()], warnings };
}

/** Duración en minutos de una clase ("16:00" → "17:30" = 90). */
export const classMinutes = (start: string, end: string) => {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return m(end) - m(start);
};
