import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, parseCheckerSheet, evaluateDay } from './checador.ts';

// Fixtures sintéticos con la MISMA estructura que los reportes reales (sin datos de personas reales).
const CAR = [
  ['Registro asistencia'], [],
  ['Date :', '', '14/10/2026 ~ 17/10/2026'],
  [14, 15, 16, 17],
  ['ID :', '', '1', '', 'Nombre :', '', 'empleado uno', '', 'Dept. :', '', 'Not Set1'],
  ['16:03\n20:01\n', '06:07\n07:58\n16:04\n20:05\n', '', '16:25\n'],
  [14, 15, 16, 17],
  ['ID :', '', '2', '', 'Nombre :', '', 'empleado dos', '', 'Dept. :', '', 'Not Set1'],
  [],
];
const VIN = [
  ['Lista de Registros'], [],
  ['Duracion:', '', '2026/12/30 ~ 01/02\t( ESGILA )'],
  [30, 31, 1, 2],
  ['No:', '', '7', '', 'Nombre:', '', 'Uno_V', '', 'Depto:', '', 'COACH'],
  ['15:55\n18:59\n', '', '19:12\n', ''],
  ['No:', '', '8', '', 'Nombre:', '', 'Dos_V', '', 'Depto:', '', 'ADMIN'],
  ['', '', '', ''],
];

test('rangos de fechas de ambos checadores (incluye cambio de año)', () => {
  assert.deepEqual(parseRange('14/10/2026 ~ 29/10/2026'), { from: '2026-10-14', to: '2026-10-29' });
  assert.deepEqual(parseRange('2026/10/15 ~ 10/29\t( ESGILA )'), { from: '2026-10-15', to: '2026-10-29' });
  assert.deepEqual(parseRange('2026/12/30 ~ 01/02'), { from: '2026-12-30', to: '2027-01-02' });
});
test('formato CAR: personas, días y checadas', () => {
  const r = parseCheckerSheet(CAR);
  assert.equal(r.people.length, 2);
  assert.deepEqual(r.people[0].punches, {
    '2026-10-14': ['16:03', '20:01'], '2026-10-15': ['06:07', '07:58', '16:04', '20:05'], '2026-10-17': ['16:25'] });
  assert.deepEqual(r.people[1].punches, {});
  assert.equal(r.people[0].name, 'empleado uno');
});
test('formato Viñedos: un solo encabezado de días y cambio de año', () => {
  const r = parseCheckerSheet(VIN);
  assert.equal(r.people.length, 2);
  assert.deepEqual(r.people[0].punches, { '2026-12-30': ['15:55', '18:59'], '2027-01-01': ['19:12'] });
  assert.equal(r.people[0].dept, 'COACH');
});

const H = [{ start: '16:00', end: '20:00' }];
test('llegar antes no suma horas; dentro de tolerancia se paga completo', () => {
  const e = evaluateDay('d', ['15:47', '20:03'], H);
  assert.equal(e.paidMinutes, 240); assert.deepEqual(e.issues, []);
  const t = evaluateDay('d', ['16:09', '20:00'], H);
  assert.equal(t.paidMinutes, 240); assert.equal(t.lateMinutes, 0);
});
test('retardo después de 10 minutos: se pagan todas las horas (la rebaja del 25 % va aparte)', () => {
  const e = evaluateDay('d', ['16:25', '20:00'], H);
  assert.deepEqual(e.issues, ['retardo']); assert.equal(e.lateMinutes, 25); assert.equal(e.paidMinutes, 240);
  assert.deepEqual(evaluateDay('d', ['16:10', '20:00'], H).issues, []);   // justo en la tolerancia
});
test('salida temprana', () => {
  const e = evaluateDay('d', ['16:00', '19:08'], H);
  assert.deepEqual(e.issues, ['salida_temprana']); assert.equal(e.paidMinutes, 188); assert.equal(e.earlyLeaveMinutes, 52);
});
test('clase extra en la mañana: no se paga sola, queda para aprobar', () => {
  const e = evaluateDay('d', ['06:07', '07:58', '16:04', '20:05'], H);
  assert.equal(e.paidMinutes, 240);
  assert.deepEqual(e.outsideBlocks, [{ start: '06:07', end: '07:58' }]);
  assert.deepEqual(e.issues, ['fuera_de_horario']);
});
test('falta, checada incompleta y día sin horario', () => {
  assert.deepEqual(evaluateDay('d', [], H).issues, ['falta']);
  assert.deepEqual(evaluateDay('d', ['19:12'], H).issues.sort(), ['checada_incompleta', 'falta']);
  assert.deepEqual(evaluateDay('d', [], []).issues, []);
  assert.deepEqual(evaluateDay('d', ['10:00', '12:00'], []).issues, ['sin_horario']);
});
test('horario partido (mañana y tarde)', () => {
  const e = evaluateDay('d', ['06:00', '08:00', '16:00', '20:00'], [{ start: '06:00', end: '08:00' }, ...H]);
  assert.equal(e.paidMinutes, 360); assert.deepEqual(e.issues, []);
});
