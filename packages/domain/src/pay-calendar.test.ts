import test from 'node:test';
import assert from 'node:assert/strict';
import { periodsBetween, type ScheduleConfig } from './pay-calendar.ts';

const LUN_SAB = [1, 2, 3, 4, 5, 6], LUN_JUE = [1, 2, 3, 4];
const esgila = (workDays = LUN_SAB, holidays?: Set<string>): ScheduleConfig =>
  ({ frequency: 'quincenal', biweeklyDays: [15, 31], weekendRule: 'antes', cutoff: 'dia_anterior', workDays, holidays });
const seco = (p: { start: string; end: string; payDate: string }) => [p.start, p.end, p.payDate];

// ---- Reglas de ESGILA ----
test('nov-2026: pago 15 cubre 31-oct→14-nov; pago 30 cubre 15→29 (el día de pago cuenta en la siguiente)', () => {
  const p = periodsBetween(esgila(), '2026-11-01', '2026-11-30');
  assert.deepEqual(p.map(x => [x.start, x.end, x.nominal]), [
    ['2026-10-31', '2026-11-14', '2026-11-15'],
    ['2026-11-15', '2026-11-29', '2026-11-30']]);
});
test('15 en domingo: lunes a sábado cobra el sábado 14 (y las horas del 14 entran en ese pago)', () => {
  const p = periodsBetween(esgila(), '2026-11-01', '2026-11-15')[0];
  assert.deepEqual(seco(p), ['2026-10-31', '2026-11-14', '2026-11-14']);
});
test('15 en sábado: lunes a sábado cobra ese sábado', () => {
  assert.equal(periodsBetween(esgila(), '2026-08-01', '2026-08-15')[0].payDate, '2026-08-15');
});
test('lunes a jueves: 15 en domingo → jueves 12; 15 en viernes → jueves 14; el periodo no cambia', () => {
  const nov = periodsBetween(esgila(LUN_JUE), '2026-11-01', '2026-11-15')[0];
  assert.deepEqual(seco(nov), ['2026-10-31', '2026-11-14', '2026-11-12']);
  const may = periodsBetween(esgila(LUN_JUE), '2026-05-01', '2026-05-15')[0];   // 15-may-2026 es viernes
  assert.equal(may.payDate, '2026-05-14');
  assert.equal(may.end, '2026-05-14');
});
test('lunes a jueves en día que sí trabaja → se paga ese día', () => {
  assert.equal(periodsBetween(esgila(LUN_JUE), '2026-10-01', '2026-10-15')[0].payDate, '2026-10-15'); // jueves
});
test('meses de 31 y febrero: el segundo pago es el último día del mes', () => {
  const oct = periodsBetween(esgila(), '2026-10-01', '2026-10-31');
  assert.deepEqual(oct[1].nominal, '2026-10-31'); assert.equal(oct[1].end, '2026-10-30');
  const feb = periodsBetween(esgila(), '2027-02-01', '2027-02-28');
  assert.deepEqual([feb[1].start, feb[1].end, feb[1].nominal], ['2027-02-15', '2027-02-27', '2027-02-28']);
  assert.equal(periodsBetween(esgila(), '2028-02-01', '2028-02-29')[1].nominal, '2028-02-29');
});
test('día inhábil: si el día de pago es inhábil, se paga el día laborable anterior', () => {
  const p = periodsBetween(esgila(LUN_SAB, new Set(['2026-12-15'])), '2026-12-01', '2026-12-15')[0]; // martes inhábil
  assert.equal(p.payDate, '2026-12-14');
});
test('año completo: 24 periodos contiguos, sin días repetidos ni perdidos', () => {
  const p = periodsBetween(esgila(), '2026-01-01', '2026-12-31');
  assert.equal(p.length, 24);
  for (let i = 1; i < p.length; i++) {
    const next = new Date(Date.UTC(+p[i - 1].end.slice(0, 4), +p[i - 1].end.slice(5, 7) - 1, +p[i - 1].end.slice(8, 10) + 1)).toISOString().slice(0, 10);
    assert.equal(p[i].start, next);
  }
});
test('el pago nunca cae en un día que la persona no trabaja (todo 2026, ambos horarios)', () => {
  for (const wd of [LUN_SAB, LUN_JUE]) for (const p of periodsBetween(esgila(wd), '2026-01-01', '2026-12-31')) {
    assert.ok(wd.includes(new Date(p.payDate + 'T00:00:00Z').getUTCDay()), p.payDate);
    assert.ok(p.payDate <= p.nominal);
  }
});

// ---- Opciones generales del calendario ----
const g = (rule: ScheduleConfig['weekendRule']): ScheduleConfig =>
  ({ frequency: 'quincenal', biweeklyDays: [15, 31], weekendRule: rule, cutoff: 'dia_de_pago' });
test('corte "día de pago": el periodo termina el mismo día de pago', () => {
  assert.deepEqual(periodsBetween(g('ninguno'), '2026-11-01', '2026-11-30').map(x => [x.start, x.end]),
    [['2026-11-01', '2026-11-15'], ['2026-11-16', '2026-11-30']]);
});
test('regla "después" y "ninguno"', () => {
  assert.equal(periodsBetween({ ...g('despues'), workDays: [1, 2, 3, 4, 5] }, '2026-11-01', '2026-11-30')[0].payDate, '2026-11-16');
  assert.equal(periodsBetween(g('ninguno'), '2026-11-01', '2026-11-30')[0].payDate, '2026-11-15');
});
test('mensual día 30 en febrero → 28', () => {
  const p = periodsBetween({ frequency: 'mensual', monthlyDay: 30, weekendRule: 'ninguno', cutoff: 'dia_de_pago' }, '2027-02-01', '2027-02-28');
  assert.deepEqual(p.map(x => [x.start, x.end]), [['2027-01-31', '2027-02-28']]);
});
test('semanal: viernes de noviembre 2026, sin huecos ni traslapes', () => {
  const p = periodsBetween({ frequency: 'semanal', weeklyWeekday: 5, weekendRule: 'ninguno' }, '2026-11-01', '2026-11-30');
  assert.deepEqual(p.map(x => x.nominal), ['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27']);
  assert.deepEqual([p[0].start, p[0].end], ['2026-10-30', '2026-11-05']);
});
test('sin días laborables → error claro, no una fecha inventada', () => {
  assert.throws(() => periodsBetween(esgila([]), '2026-11-01', '2026-11-30'), /días laborables/);
});
