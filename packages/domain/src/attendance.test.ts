import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksForDate, reviewDay, type WeeklyBlock, type DayException } from './attendance.ts';

const W: WeeklyBlock[] = [1, 2, 3, 4, 5].map(weekday => ({ weekday, start: '16:00', end: '20:00' }));
const LUN = '2026-11-16', SAB = '2026-11-21';

test('horario: base del día, más clase extra, o reemplazado / sin actividad', () => {
  assert.deepEqual(blocksForDate(LUN, W, []), [{ start: '16:00', end: '20:00' }]);
  assert.deepEqual(blocksForDate(SAB, W, []), []);
  const extra: DayException[] = [{ date: LUN, kind: 'clase_extra', blocks: [{ start: '06:00', end: '08:00' }], replacesBase: false }];
  assert.deepEqual(blocksForDate(LUN, W, extra).map(b => b.start), ['06:00', '16:00']);
  const comp: DayException[] = [{ date: LUN, kind: 'competencia', blocks: [{ start: '08:00', end: '14:00' }], replacesBase: true }];
  assert.deepEqual(blocksForDate(LUN, W, comp), [{ start: '08:00', end: '14:00' }]);
  assert.deepEqual(blocksForDate(LUN, W, [{ date: LUN, kind: 'sin_actividad', blocks: [], replacesBase: false }]), []);
});
test('clase extra registrada como excepción: se paga sin revisar nada', () => {
  const blocks = blocksForDate(LUN, W, [{ date: LUN, kind: 'clase_extra', blocks: [{ start: '06:00', end: '08:00' }], replacesBase: false }]);
  const d = reviewDay(LUN, ['06:05', '08:00', '16:00', '20:00'], blocks, 15, []);
  assert.equal(d.paidMinutes, 360); assert.deepEqual(d.pending, []);
});
test('aprobar trabajo fuera de horario suma sus minutos', () => {
  const d = reviewDay(LUN, ['06:00', '08:00', '16:00', '20:00'], blocksForDate(LUN, W, []), 15,
    [{ date: LUN, kind: 'aprobar_extra', reason: 'clase extra' }]);
  assert.equal(d.paidMinutes, 360); assert.deepEqual(d.pending, []);
});
test('justificar falta, quitar retardo, corregir checadas', () => {
  const b = blocksForDate(LUN, W, []);
  const falta = reviewDay(LUN, [], b, 15, [{ date: LUN, kind: 'justificar_falta', reason: 'incapacidad' }]);
  assert.equal(falta.excused, true); assert.deepEqual(falta.pending, []); assert.equal(falta.attended, false);
  const tarde = reviewDay(LUN, ['16:30', '20:00'], b, 15, [{ date: LUN, kind: 'quitar_retardo', reason: 'tráfico autorizado' }]);
  assert.equal(tarde.lateMinutes, 0); assert.deepEqual(tarde.pending, []); assert.ok(!tarde.issues.includes('retardo'));
  const olvido = reviewDay(LUN, ['16:00'], b, 15, [{ date: LUN, kind: 'corregir_checadas', times: ['16:00', '20:00'], reason: 'olvidó checar salida' }]);
  assert.equal(olvido.paidMinutes, 240); assert.deepEqual(olvido.pending, []);
});
test('sin revisión, las excepciones quedan pendientes', () => {
  const d = reviewDay(LUN, ['16:30', '19:00'], blocksForDate(LUN, W, []), 15, []);
  assert.deepEqual(d.pending.sort(), ['retardo', 'salida_temprana']);
});

import { suggestWeekly } from './attendance.ts';
test('sugerir horario desde checadas (caso Sayana: lun–jue ~16:00–20:00)', () => {
  const p = {
    '2026-09-29': ['16:00', '20:00'], '2026-09-30': ['15:55', '20:01'], '2026-10-02': ['15:56'],
    '2026-10-05': ['15:58'], '2026-10-06': ['15:58', '20:00'], '2026-10-07': ['15:54', '20:01'],
    '2026-10-08': ['16:01', '20:02'], '2026-10-12': ['15:51', '19:58'], '2026-10-13': ['15:55', '20:00'], '2026-10-14': ['16:01'],
    '2026-10-01': ['16:03', '20:05'],
  };
  assert.deepEqual(suggestWeekly(p), [
    { weekday: 2, start: '16:00', end: '20:00' }, { weekday: 3, start: '16:00', end: '20:00' }, { weekday: 4, start: '16:00', end: '20:00' }]);
  assert.deepEqual(suggestWeekly(p, 1).map(b => b.weekday), [1, 2, 3, 4]);
});
