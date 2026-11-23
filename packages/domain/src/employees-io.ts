// Importación / exportación de colaboradores con el formato de "Colaboradores ESGILA":
//   hoja "Datos Generales" (datos personales) y hoja "Confidencial" (pago). Sin dependencias.

export const GENERAL_HEADERS = ['No.', 'Nombre completo', 'Fecha de nacimiento', 'Puesto', 'Área', 'Sede', 'Fecha de ingreso', 'Estatus',
  'Fecha de baja', 'Domicilio', 'Teléfono', 'Correo', 'CURP', 'RFC', 'NSS (IMSS)', 'Contacto de emergencia', 'Tel. de emergencia',
  'Tipo de sangre', 'Alergias / condiciones', 'Talla de playera'] as const;
export const CONFIDENTIAL_HEADERS = ['Nombre completo', 'Puesto', 'Fecha de ingreso', 'Estatus', 'Antigüedad (años)', 'Tipo de contrato',
  'Pago por hora ($)', 'Horas por semana', 'Sueldo mensual estimado ($)', 'Fecha último aumento', 'Pago por hora anterior ($)',
  '% del último aumento', 'Fecha próxima revisión', 'Forma de pago', 'Banco', 'Notas'] as const;

/** Para comparar nombres: sin acentos, sin mayúsculas, sin espacios de más. */
export const normName = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const normHeader = (s: string) => normName(s).replace(/[^a-z0-9%]/g, '');
/** Texto de una celda. Una fecha real de Excel llega como Date: se pasa a AAAA-MM-DD (sin depender del formato de la celda). */
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).trim();
};

/** d/m/aaaa (o dd/mm/aaaa). Devuelve ISO o null; `bad` si había algo que no es fecha válida. */
export function parseDate(v: unknown): { iso: string | null; bad: boolean } {
  const s = cell(v); if (!s) return { iso: null, bad: false };
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/) ?? s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { iso: null, bad: true };
  const [d, mo, y] = s.includes('-') ? [+m[3], +m[2], +m[1]] : [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || y > 2100 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { iso: null, bad: true };
  return { iso: dt.toISOString().slice(0, 10), bad: false };
}
export const fmtDateMx = (iso: string | null | undefined) => (iso ? `${+iso.slice(8, 10)}/${+iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

/** "$1,200.00" → 120000 centavos. */
export function parseMoney(v: unknown): number | null {
  const s = cell(v).replace(/[$,\s]/g, ''); if (!s || s.startsWith('#')) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [a, b = ''] = s.split('.'); return +a * 100 + +(b.padEnd(2, '0'));
}

/** Ubica la fila de encabezados y devuelve las filas como objetos {encabezado normalizado: valor}. */
export function rowsByHeader(rows: unknown[][], mustHave: string[]): Record<string, string>[] {
  const keys = mustHave.map(normHeader);
  const hi = rows.findIndex(r => keys.every(k => r.some(c => normHeader(cell(c)) === k)));
  if (hi < 0) throw new Error(`No encontré los encabezados (${mustHave.join(', ')})`);
  const head = rows[hi].map(c => normHeader(cell(c)));
  return rows.slice(hi + 1).map(r => Object.fromEntries(head.map((h, i) => [h, cell(r[i])])))
    .filter(o => (o[normHeader('Nombre completo')] ?? '') !== '');
}
const g = (o: Record<string, string>, h: string) => o[normHeader(h)] ?? '';

export type Sede = 'CAR' | 'Viñedos' | 'Ambas' | '';
export interface GeneralRow {
  externalNo: number | null; fullName: string; birthDate: string | null; jobTitle: string; area: string; sede: Sede;
  hireDate: string | null; active: boolean; terminationDate: string | null; address: string; phone: string; email: string;
  curp: string; rfc: string; nss: string; emergencyContact: string; emergencyPhone: string; bloodType: string; healthNotes: string; shirtSize: string;
  isCoach: boolean; warnings: string[];
}

export function parseGeneral(rows: unknown[][]): GeneralRow[] {
  return rowsByHeader(rows, ['Nombre completo', 'CURP']).map(o => {
    const warnings: string[] = [];
    const date = (h: string) => { const r = parseDate(g(o, h)); if (r.bad) warnings.push(`${h} no válida ("${g(o, h)}"): se deja vacía`); return r.iso; };
    const sedeRaw = normName(g(o, 'Sede'));
    const sede: Sede = sedeRaw === 'car' ? 'CAR' : sedeRaw.startsWith('vin') ? 'Viñedos' : sedeRaw === 'ambas' ? 'Ambas' : '';
    if (!sede) warnings.push('Sin sede');
    const jobTitle = g(o, 'Puesto').replace(/\s+/g, ' ').trim(); const area = g(o, 'Área').trim();
    const curp = g(o, 'CURP').toUpperCase().replace(/\s/g, '');
    if (curp && !/^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(curp)) warnings.push(`CURP con formato raro (${curp})`);
    const no = parseInt(g(o, 'No.'), 10);
    return {
      externalNo: Number.isFinite(no) ? no : null, fullName: g(o, 'Nombre completo').replace(/\s+/g, ' ').trim(),
      birthDate: date('Fecha de nacimiento'), jobTitle, area, sede, hireDate: date('Fecha de ingreso'),
      active: normName(g(o, 'Estatus')) !== 'inactivo', terminationDate: date('Fecha de baja'),
      address: g(o, 'Domicilio'), phone: g(o, 'Teléfono'), email: g(o, 'Correo').toLowerCase().replace(/\s/g, ''), curp,
      rfc: g(o, 'RFC').toUpperCase().replace(/\s/g, ''), nss: g(o, 'NSS (IMSS)'), emergencyContact: g(o, 'Contacto de emergencia'),
      emergencyPhone: g(o, 'Tel. de emergencia'), bloodType: g(o, 'Tipo de sangre'), healthNotes: g(o, 'Alergias / condiciones'), shirtSize: g(o, 'Talla de playera'),
      isCoach: /coach/i.test(jobTitle), warnings,   // por puesto: el área "Coaching" incluye a directivos
    };
  });
}

export interface ConfidentialRow {
  fullName: string; contractType: string; hourlyCents: number | null; hoursPerWeek: number | null;
  lastRaiseDate: string | null; previousHourlyCents: number | null; payMethod: 'efectivo' | 'transferencia' | null; bank: string; notes: string;
  /** El pago solo se importa como "por hora" cuando el contrato es "Por horas" (en Nómina/Honorarios la columna no es por hora real). */
  importPay: boolean; warnings: string[];
}

export function parseConfidential(rows: unknown[][]): ConfidentialRow[] {
  return rowsByHeader(rows, ['Nombre completo', 'Pago por hora ($)']).map(o => {
    const warnings: string[] = [];
    const contract = g(o, 'Tipo de contrato').trim();
    const hourly = parseMoney(g(o, 'Pago por hora ($)'));
    const lr = parseDate(g(o, 'Fecha último aumento')); if (lr.bad) warnings.push(`Fecha último aumento no válida ("${g(o, 'Fecha último aumento')}")`);
    const fp = normName(g(o, 'Forma de pago'));
    const hpw = parseFloat(g(o, 'Horas por semana'));
    const importPay = normName(contract) === 'por horas' && hourly !== null && hourly > 0;
    if (hourly !== null && !importPay) warnings.push(`Contrato "${contract || 'sin tipo'}": su pago no se importa como por hora; captúralo en su expediente`);
    return {
      fullName: g(o, 'Nombre completo').replace(/\s+/g, ' ').trim(), contractType: contract, hourlyCents: hourly,
      hoursPerWeek: Number.isFinite(hpw) ? hpw : null, lastRaiseDate: lr.iso, previousHourlyCents: parseMoney(g(o, 'Pago por hora anterior ($)')),
      payMethod: fp.startsWith('transf') ? 'transferencia' : fp.startsWith('efect') ? 'efectivo' : null,
      bank: g(o, 'Banco').trim(), notes: g(o, 'Notas').trim(), importPay, warnings,
    };
  });
}

/** Años de antigüedad con un decimal (como el Excel). */
export function seniorityYears(hireIso: string | null, todayIso: string): number | null {
  if (!hireIso) return null;
  const days = (Date.parse(todayIso) - Date.parse(hireIso)) / 864e5;
  return days < 0 ? 0 : Math.round(days / 365.25 * 10) / 10;
}
/** Sueldo mensual estimado del Excel: pago por hora × horas por semana × 4.33. */
export const monthlyEstimateCents = (hourlyCents: number, hoursPerWeek: number) => Math.round(hourlyCents * hoursPerWeek * 4.33);
export const addMonthsIso = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z'); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};

/**
 * Posibles coincidencias por nombre cuando no es idéntico: todas las palabras del nombre más corto
 * aparecen en el más largo ("Itzel Gonzalez" ⊂ "Itzel Gonzalez Guerrero"), o coinciden el primer nombre
 * y el primer apellido. Devuelve los índices de los candidatos.
 */
export function similarNames(name: string, others: readonly string[]): number[] {
  const a = normName(name).replace(/\(.*?\)/g, '').split(' ').filter(w => w.length > 1);
  return others.map((o, i) => ({ i, b: normName(o).replace(/\(.*?\)/g, '').split(' ').filter(w => w.length > 1) }))
    .filter(({ b }) => {
      if (!a.length || !b.length) return false;
      const [short, long] = a.length <= b.length ? [a, b] : [b, a];
      if (short.length >= 2 && short.every(w => long.includes(w))) return true;
      return a[0] === b[0] && a.length > 1 && b.length > 1 && a[1] === b[1];
    }).map(x => x.i);
}
