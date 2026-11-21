import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptEarnings, hourlyRateForLate, type Concept, type WorkDay } from './concepts.ts';

// Semana del lunes 16 al domingo 22 de noviembre de 2026.
const semana: WorkDay[] = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']
  .map((date, i) => ({ date, paidMinutes: i < 5 ? 240 : 0, attended: i !== 6 }));   // falta el domingo

test('portero por día + limpieza por día (lun-vie): dos pagos en el mismo día', () => {
  const c: Concept[] = [
    { key: 'portero', label: 'Portero', kind: 'por_dia', amountCents: 25000n, weekdays: [0, 1, 2, 3, 4, 5, 6] },
    { key: 'limpieza', label: 'Limpieza', kind: 'por_dia', amountCents: 15000n, weekdays: [1, 2, 3, 4, 5] }];
  const r = conceptEarnings(c, semana);
  assert.deepEqual(r.map(x => [x.key, x.units, x.amountCents]), [['portero', 6, 150000n], ['limpieza', 5, 75000n]]);
});
test('por hora: minutos pagados × tarifa', () => {
  const r = conceptEarnings([{ key: 'hora', label: 'Hora', kind: 'por_hora', amountCents: 10000n, weekdays: [0, 1, 2, 3, 4, 5, 6] }], semana);
  assert.equal(r[0].amountCents, 200000n);   // 20 h × $100
  assert.equal(r[0].detail, '20 h 0 min');
});
test('fijo semanal: monto completo del periodo', () => {
  const r = conceptEarnings([{ key: 'fijo', label: 'Sueldo fijo', kind: 'fijo', amountCents: 180000n, weekdays: [1, 2, 3, 4, 5] }], semana);
  assert.equal(r[0].amountCents, 180000n);
});
test('mezcla: fijo + por hora en la misma persona', () => {
  const r = conceptEarnings([
    { key: 'fijo', label: 'Base', kind: 'fijo', amountCents: 100000n, weekdays: [1] },
    { key: 'hora', label: 'Clases', kind: 'por_hora', amountCents: 9000n, weekdays: [1, 2] }], semana);
  assert.equal(r.reduce((n, x) => n + x.amountCents, 0n), 100000n + 72000n);   // 8 h × $90
});
test('rebaja por retardo usa la tarifa por hora; sin concepto por hora no hay base', () => {
  assert.equal(hourlyRateForLate([{ key: 'hora', label: 'h', kind: 'por_hora', amountCents: 12000n, weekdays: [1] }]), 12000n);
  assert.equal(hourlyRateForLate([{ key: 'p', label: 'p', kind: 'por_dia', amountCents: 1n, weekdays: [1] }]), null);
});
