// Cálculo interno de nómina. Todo en enteros: centavos (bigint) y minutos (number).
// NO es cálculo fiscal ni CFDI.

export type Cents = bigint;

export type Incidence =
  | 'ninguna' | 'falta' | 'retardo' | 'permiso' | 'incapacidad' | 'vacaciones' | 'descanso' | 'otra';

export interface DayRecord {
  date: string;            // YYYY-MM-DD
  minutesWorked: number;   // minutos efectivamente trabajados (>= 0)
  incidence: Incidence;
  rateCents: Cents;        // tarifa por hora vigente EN ESA FECHA (resuelta por el llamador)
}

export interface LoanInstallment {
  configuredCents: Cents;  // parcialidad autorizada
  balanceCents: Cents;     // saldo pendiente
}

export interface PayrollInput {
  days: DayRecord[];
  lateDeductionBps: number;          // 2500 = 25 %, configurable
  lateDeductionAuthorized: boolean;  // validación legal externa: si es false, no se descuenta
  loans: LoanInstallment[];
  otherAuthorizedDeductionsCents?: Cents;
  reportedCents?: Cents | null;      // "nómina reportada", se captura aparte
}

export interface LateLine {
  date: string; ordinal: number; rateCents: Cents; bps: number; amountCents: Cents;
}

export interface PayrollResult {
  totalDays: number;
  totalMinutes: number;
  totalFaltas: number;
  totalRetardos: number;
  grossCents: Cents;
  lateLines: LateLine[];
  lateTotalCents: Cents;
  lateComputedButNotApplied: Cents; // lo calculado cuando no está autorizado
  loansCents: Cents;
  otherCents: Cents;
  netCents: Cents;
  reportedCents: Cents | null;
  diffNetVsReportedCents: Cents | null;
  warnings: string[];
}

const MIN_PER_HOUR = 60n;

/** a*b/d con redondeo "mitad hacia arriba" (valores no negativos). */
export function mulDivRound(a: bigint, b: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('divisor inválido');
  return (a * b * 2n + d) / (2n * d);
}

export function computePayroll(input: PayrollInput): PayrollResult {
  const warnings: string[] = [];
  let totalMinutes = 0;
  let grossCents = 0n;
  let faltas = 0;
  let retardos = 0;
  const lateLines: LateLine[] = [];
  let lateComputed = 0n;

  for (const d of input.days) {
    if (!Number.isInteger(d.minutesWorked) || d.minutesWorked < 0)
      throw new Error(`Minutos inválidos en ${d.date}`);
    if (d.rateCents < 0n) throw new Error(`Tarifa inválida en ${d.date}`);

    totalMinutes += d.minutesWorked;
    // Horas trabajadas = horas pagadas
    grossCents += mulDivRound(BigInt(d.minutesWorked) * d.rateCents, 1n, MIN_PER_HOUR);

    if (d.incidence === 'falta') faltas++;
    if (d.incidence === 'retardo') {
      retardos++;
      const amount = mulDivRound(d.rateCents, BigInt(input.lateDeductionBps), 10000n);
      lateLines.push({ date: d.date, ordinal: retardos, rateCents: d.rateCents,
        bps: input.lateDeductionBps, amountCents: amount });
      lateComputed += amount;
    }
  }

  const lateApplied = input.lateDeductionAuthorized ? lateComputed : 0n;
  if (!input.lateDeductionAuthorized && lateComputed > 0n)
    warnings.push('Rebaja por retardos calculada pero NO aplicada: falta autorización legal.');

  const loansCents = input.loans.reduce((s, l) => {
    const take = l.configuredCents < l.balanceCents ? l.configuredCents : l.balanceCents;
    return s + (take < 0n ? 0n : take);
  }, 0n);

  const otherCents = input.otherAuthorizedDeductionsCents ?? 0n;
  const netCents = grossCents - lateApplied - loansCents - otherCents;
  if (netCents < 0n) warnings.push('La nómina neta es negativa: revisar descuentos (no se ajusta en silencio).');

  const reported = input.reportedCents ?? null;
  return {
    totalDays: input.days.length,
    totalMinutes,
    totalFaltas: faltas,
    totalRetardos: retardos,
    grossCents,
    lateLines,
    lateTotalCents: lateApplied,
    lateComputedButNotApplied: input.lateDeductionAuthorized ? 0n : lateComputed,
    loansCents,
    otherCents,
    netCents,
    reportedCents: reported,
    diffNetVsReportedCents: reported === null ? null : netCents - reported,
    warnings,
  };
}

export function formatMXN(cents: Cents): string {
  const neg = cents < 0n; const v = neg ? -cents : cents;
  const whole = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${whole}.${(v % 100n).toString().padStart(2, '0')}`;
}
