import test from 'node:test';
import assert from 'node:assert/strict';
import { periodsBetween, type ScheduleConfig } from './pay-calendar.ts';

const q = (rule: ScheduleConfig['weekendRule'], holidays?: Set<string>): ScheduleConfig =>
  ({ frequency: 'quincenal', biweeklyDays: [15, 31], weekendRule: rule, holidays });

test('quincenal nov-2026: 15 cae en domingo → se paga el viernes 13 (regla "antes")', () => {
  const p = periodsBetween(q('antes'), '2026-11-01', '2026-11-30');
  assert.deepEqual(p, [
    { start: '2026-11-01', end: '2026-11-15', payDate: '2026-11-13' },
    { start: '2026-11-16', end: '2026-11-30', payDate: '2026-11-30' }]);
});
test('regla "después" y "ninguno"', () => {
  assert.equal(periodsBetween(q('despues'), '2026-11-01', '2026-11-30')[0].payDate, '2026-11-16');
  assert.equal(periodsBetween(q('ninguno'), '2026-11-01', '2026-11-30')[0].payDate, '2026-11-15');
});
test('día inhábil configurado se respeta', () => {
  const p = periodsBetween(q('despues', new Set(['2026-11-16'])), '2026-11-01', '2026-11-30');
  assert.equal(p[0].payDate, '2026-11-17');
});
test('febrero: el día 31 se ajusta al último día del mes (año normal y bisiesto)', () => {
  assert.equal(periodsBetween(q('ninguno'), '2027-02-01', '2027-02-28')[1].end, '2027-02-28');
  assert.equal(periodsBetween(q('ninguno'), '2028-02-01', '2028-02-29')[1].end, '2028-02-29');
});
test('mensual día 30 en febrero → 28', () => {
  const p = periodsBetween({ frequency: 'mensual', monthlyDay: 30, weekendRule: 'ninguno' }, '2027-02-01', '2027-02-28');
  assert.deepEqual(p, [{ start: '2027-01-31', end: '2027-02-28', payDate: '2027-02-28' }]);
});
test('semanal: viernes de noviembre 2026, sin huecos ni traslapes', () => {
  const p = periodsBetween({ frequency: 'semanal', weeklyWeekday: 5, weekendRule: 'ninguno' }, '2026-11-01', '2026-11-30');
  assert.deepEqual(p.map(x => x.end), ['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27']);
  assert.equal(p[0].start, '2026-10-31');
  for (let i = 1; i < p.length; i++) assert.equal(p[i].start > p[i - 1].end, true);
});
test('periodos contiguos en un año completo (sin duplicar ni perder días)', () => {
  const p = periodsBetween(q('antes'), '2026-01-01', '2026-12-31');
  assert.equal(p.length, 24);
  for (let i = 1; i < p.length; i++) {
    const next = new Date(Date.UTC(+p[i - 1].end.slice(0, 4), +p[i - 1].end.slice(5, 7) - 1, +p[i - 1].end.slice(8, 10) + 1)).toISOString().slice(0, 10);
    assert.equal(p[i].start, next);
  }
});
