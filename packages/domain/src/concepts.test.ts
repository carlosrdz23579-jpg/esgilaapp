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
const LUN_SAB = [1, 2, 3, 4, 5, 6];
const fijo1800: Concept = { key: 'fijo', label: 'Sueldo fijo', kind: 'fijo', amountCents: 180000n, weekdays: LUN_SAB };
test('fijo semanal lun–sáb $1,800 sin faltas → $1,800', () => {
  assert.equal(conceptEarnings([fijo1800], semana)[0].amountCents, 180000n);   // falta solo el domingo, que no cubre
});
test('fijo $1,800 con 1 falta → $1,500; falta justificada no descuenta', () => {
  const unaFalta = semana.map(d => d.date === '2026-11-18' ? { ...d, attended: false } : d);
  const r = conceptEarnings([fijo1800], unaFalta)[0];
  assert.equal(r.amountCents, 150000n); assert.match(r.detail, /1 falta/);
  const justificada = semana.map(d => d.date === '2026-11-18' ? { ...d, attended: false, excused: true } : d);
  assert.equal(conceptEarnings([fijo1800], justificada)[0].amountCents, 180000n);
});
test('portero: una sola entrada y salida cuenta el día para portero y limpieza', () => {
  const dia: WorkDay[] = [{ date: '2026-11-16', paidMinutes: 0, attended: true }];   // checó 13:00 y 19:15
  const r = conceptEarnings([
    { key: 'portero', label: 'Portero', kind: 'por_dia', amountCents: 25000n, weekdays: [0, 1, 2, 3, 4, 5, 6] },
    { key: 'limpieza', label: 'Limpieza', kind: 'por_dia', amountCents: 15000n, weekdays: [1, 2, 3, 4, 5] }], dia);
  assert.equal(r.reduce((n, x) => n + x.amountCents, 0n), 40000n);
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
