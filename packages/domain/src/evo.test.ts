import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvoSheet, evoTime, classMinutes } from './evo.ts';

const row = (cells: Record<number, unknown>) => { const r: unknown[] = Array(67).fill(null); for (const k in cells) r[+k] = cells[k]; return r; };
const days: Record<number, unknown> = {}; const cols = [33, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 55, 56, 57, 58, 59, 60, 61, 62, 65, 66];
cols.forEach((c, i) => { days[c] = String(i + 1); });

test('lee el reporte mensual de EVO', () => {
  const rows = [
    row({ 9: 'Asistencia Mensual por Instructor' }),
    row({ 9: 'Mes:', 13: '11', 15: '/', 16: 2026 }),
    row({ 3: 'Grupo de actividades:', 12: 'Baby Gym 1' }),
    row({ 5: 'Actividad', 7: '*Baby Gym 1' }),
    row({ 7: 'De:', 10: '16:00:00', 15: 'Hasta:', 19: '17:00:00' }),
    row(days),
    row({ 5: 'María Emilia Ruiz Arellano', 17: 'ID:', 18: '1321', 23: 'Teléfono:', 27: '(87)12446-469', 36: 'M', 38: 'J', 43: 'M', 45: 'J' }),
    row({ 4: 'Fec. Nacimiento', 8: '02/06/2023', 13: 'Fecha inscripción', 18: '11/08/2026', 22: 'Próximo Examen:' }),
    row({ 5: 'luisa faccuseh peña', 17: 'ID:', 18: '1390', 23: 'Teléfono:', 27: '8711136858', 35: 'L', 37: 'M', 66: 'L' }),
    row({ 4: 'Fec. Nacimiento', 8: '18/10/2022', 13: 'Fecha inscripción', 18: '27/07/2026' }),
  ];
  const r = parseEvoSheet(rows);
  assert.equal(r.month, 11); assert.equal(r.year, 2026);
  assert.equal(r.classes.length, 1);
  const c = r.classes[0];
  assert.deepEqual([c.activity, c.start, c.end], ['Baby Gym 1', '16:00', '17:00']);
  const [a, b] = c.students;
  assert.deepEqual([a.evoId, a.phone, a.birth, a.enrolled], ['1321', '(87)12446-469', '2023-06-02', '2026-08-11']);
  assert.deepEqual(a.days, [3, 5, 10, 12]); assert.deepEqual(a.weekdays, [2, 4]);   // martes y jueves
  assert.deepEqual(b.weekdays, [1, 3]);                                                 // lunes y miércoles
  assert.deepEqual(r.warnings, []);
});

test('horas en fracción de Excel y duración', () => {
  assert.equal(evoTime(16 / 24), '16:00'); assert.equal(evoTime('7:30'), '07:30');
  assert.equal(classMinutes('16:00', '17:30'), 90);
});
