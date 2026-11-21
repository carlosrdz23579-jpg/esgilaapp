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
