import test from 'node:test';
import assert from 'node:assert/strict';
import { computePeriodLine, type PeriodDay } from './period-payroll.ts';
import type { Concept } from './concepts.ts';

const period = { start: '2026-11-15', end: '2026-11-21' };
const days: PeriodDay[] = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']
  .map((date, i) => ({ date, paidMinutes: 240, attended: true, late: i < 3 }));
const hora: Concept = { key: 'hora', label: 'Clases', kind: 'por_hora', amountCents: 10000n, weekdays: [1, 2, 3, 4, 5, 6] };

test('ejemplo del proyecto: 3 retardos a $100/h = $75 de rebaja; se pagan todas las horas', () => {
  const l = computePeriodLine({ period, payDate: '2026-11-21', days, concepts: [hora], lateDeductionBps: 2500, extras: [], deductions: [] });
  assert.equal(l.grossCents, 240000n);          // 24 h × $100
  assert.equal(l.deductionCents, 7500n);
  assert.equal(l.netCents, 232500n);
  assert.deepEqual(l.detail.lateDeduction, { count: 3, perLate: '2500', total: '7500' });
});
test('sueldo fijo: sin rebaja por retardo; con bono y descuento autorizados', () => {
  const fijo: Concept = { key: 'fijo', label: 'Sueldo', kind: 'fijo', amountCents: 180000n, weekdays: [1, 2, 3, 4, 5, 6] };
  const l = computePeriodLine({ period, payDate: '2026-11-21', days, concepts: [fijo], lateDeductionBps: 2500,
    extras: [{ id: 'b', label: 'Bono', amountCents: 20000n, kind: 'unico', startDate: '2026-11-18', status: 'autorizado' }],
    deductions: [{ id: 'd', label: 'Uniforme', amountCents: 35000n, kind: 'unico', startDate: '2026-11-18', status: 'autorizado' },
                 { id: 'p', label: 'Pendiente', amountCents: 99900n, kind: 'unico', startDate: '2026-11-18', status: 'pendiente' }] });
  assert.equal(l.detail.lateDeduction, null);
  assert.equal(l.grossCents, 200000n); assert.equal(l.deductionCents, 35000n); assert.equal(l.netCents, 165000n);
});
test('sin conceptos: aviso, no se inventa pago', () => {
  const l = computePeriodLine({ period, payDate: '2026-11-21', days, concepts: [], lateDeductionBps: 2500, extras: [], deductions: [] });
  assert.equal(l.netCents, 0n); assert.ok(l.detail.warnings.length > 0);
});

test('por día con tarifa de referencia para retardo (Madelin: $300/día, rebaja sobre $65/h) y desglose por día', () => {
  const c: Concept[] = [
    { key: 'admin', label: 'Auxiliar administrativo', kind: 'por_dia', amountCents: 30000n, weekdays: [1, 2, 3, 4, 5, 6] },
    { key: 'ret', label: 'Base retardo', kind: 'tarifa_retardo', amountCents: 6500n, weekdays: [0, 1, 2, 3, 4, 5, 6] }];
  const d: PeriodDay[] = [
    { date: '2026-11-16', paidMinutes: 240, attended: true, late: false, scheduled: true },
    { date: '2026-11-17', paidMinutes: 240, attended: true, late: true, scheduled: true },
    { date: '2026-11-18', paidMinutes: 0, attended: false, late: false, scheduled: true },
    { date: '2026-11-19', paidMinutes: 0, attended: false, late: false, scheduled: true, excused: true },
    { date: '2026-11-22', paidMinutes: 0, attended: false, late: false, scheduled: false }];
  const l = computePeriodLine({ period, payDate: '2026-11-21', days: d, concepts: c, lateDeductionBps: 2500, extras: [], deductions: [],
    loanLines: [{ loanId: 'L', label: 'Préstamo', amountCents: 50000n, skipped: false, balanceAfterCents: 0n }] });
  assert.equal(l.grossCents, 60000n);                       // 2 días × $300 (la tarifa de referencia no se paga)
  assert.deepEqual(l.detail.lateDeduction, { count: 1, perLate: '1625', total: '1625' });   // 65 × 25 % = $16.25
  assert.equal(l.netCents, 60000n - 1625n - 50000n);
  assert.equal(l.reportedCents, 60000n - 1625n);            // reportada = neta + préstamos
  assert.deepEqual(l.detail.days.map(x => x.status), ['', 'Tarde', 'Falta', 'Justificada']);
  assert.equal(l.detail.faltas, 1);
});

import { recomputeLine } from './period-payroll.ts';
test('calentamiento: día sin calentamiento activo descuenta 30 min de su tarifa', () => {
  const d2: PeriodDay[] = days.map((x, i) => ({ ...x, late: false, scheduled: true, warmupInactive: i === 0 }));
  const l = computePeriodLine({ period, payDate: '2026-11-21', days: d2, concepts: [hora], lateDeductionBps: 2500, extras: [], deductions: [] });
  assert.deepEqual(l.detail.warmup, { days: 1, perDay: '5000', total: '5000' });   // $100/h → 30 min = $50
  assert.equal(l.netCents, 240000n - 5000n);
});
test('editar a mano: cambiar horas de un día y agregar un ajuste recalcula igual', () => {
  const l = computePeriodLine({ period, payDate: '2026-11-21', days: days.map(x => ({ ...x, scheduled: true })), concepts: [hora], lateDeductionBps: 2500, extras: [], deductions: [] });
  const edited = l.detail.days.map((d, i) => i === 0 ? { ...d, minutes: 180, status: '' as const } : d);
  const r = recomputeLine(l.detail, period, '2026-11-21', edited, [{ label: 'Bono puntualidad', amountCents: 10000n }, { label: 'Ajuste', amountCents: -5000n }]);
  assert.equal(r.grossCents, 230000n + 10000n);                // un día de 4 h pasó a 3 h; + bono
  assert.equal(r.deductionCents, 5000n + 5000n);              // 2 retardos (se quitó uno) + ajuste
  assert.equal(r.netCents, r.grossCents - r.deductionCents);
});

test('calentamiento no aplica a Staff', () => {
  const d2: PeriodDay[] = days.map(x => ({ ...x, late: false, scheduled: true, warmupInactive: true }));
  const l = computePeriodLine({ period, payDate: '2026-11-21', days: d2, concepts: [hora], lateDeductionBps: 2500, extras: [], deductions: [], warmupApplies: false });
  assert.equal(l.detail.warmup, null); assert.equal(l.netCents, 240000n);
});

test('descuento de calentamiento configurable (45 min)', () => {
  const d2: PeriodDay[] = days.map((x, i) => ({ ...x, late: false, scheduled: true, warmupInactive: i === 0 }));
  const l = computePeriodLine({ period, payDate: '2026-11-21', days: d2, concepts: [hora], lateDeductionBps: 2500, extras: [], deductions: [], warmupDeductionMin: 45 });
  assert.equal(l.detail.warmup?.total, '7500');
});

test('días sin reporte del checador se pagan según horario (Proyectado) y se pueden recalcular', () => {
  const d2: PeriodDay[] = [
    { date: '2026-11-12', paidMinutes: 180, attended: true, late: false, scheduled: true },
    { date: '2026-11-14', paidMinutes: 240, attended: true, late: false, scheduled: true, projected: true }];
  const l = computePeriodLine({ period, payDate: '2026-11-14', days: d2, concepts: [hora], lateDeductionBps: 2500, extras: [], deductions: [] });
  assert.equal(l.grossCents, 70000n);
  assert.deepEqual(l.detail.days.map(x => x.status), ['', 'Proyectado']);
  assert.ok(l.detail.warnings.some(w => w.includes('sin reporte')));
  const r = recomputeLine(l.detail, period, '2026-11-14', l.detail.days, []);
  assert.equal(r.grossCents, 70000n);
});
