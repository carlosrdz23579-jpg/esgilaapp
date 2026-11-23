import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, parseMoney, parseGeneral, parseConfidential, normName, seniorityYears, monthlyEstimateCents, addMonthsIso } from './employees-io.ts';

test('fechas d/m/aaaa; inválidas se marcan', () => {
  assert.deepEqual(parseDate('9/1/2023'), { iso: '2023-01-09', bad: false });
  assert.deepEqual(parseDate('01/09/2026'), { iso: '2026-09-01', bad: false });
  assert.equal(parseDate('09/2026').bad, true);
  assert.equal(parseDate('22/4/0199').bad, true);
  assert.equal(parseDate('31/2/2026').bad, true);
  assert.deepEqual(parseDate(''), { iso: null, bad: false });
});
test('dinero y nombres', () => {
  assert.equal(parseMoney('$1,200.00'), 120000); assert.equal(parseMoney('$64.61'), 6461); assert.equal(parseMoney('#N/A'), null);
  assert.equal(normName('  Ana María  Campa Puentes '), normName('ana maria campa puentes'));
});
const GEN = [['No.', 'Nombre completo', 'Fecha de nacimiento', 'Puesto', 'Área', 'Sede', 'Fecha de ingreso', 'Estatus', 'Fecha de baja', 'Domicilio', 'Teléfono', 'Correo', 'CURP', 'RFC', 'NSS (IMSS)', 'Contacto de emergencia', 'Tel. de emergencia', 'Tipo de sangre', 'Alergias / condiciones', 'Talla de playera'],
  ['1', 'Persona  Uno ', '2/9/1990', 'Coach Telas', 'Coaching', 'Viñedos', '1/2/2024', 'Activo', '', 'Calle 1', '871', 'A@B.COM ', 'aaaa900902mclsrl02', '', '', 'Mamá', '872', 'O+', 'polvo', 'M'],
  ['2', 'Persona Dos', '12/1989', 'Staff', 'Limpieza', 'Ambas', '', 'Inactivo', '6/8/2026']];
test('Datos Generales: mapea campos, coach por puesto/área, baja e inválidas', () => {
  const r = parseGeneral(GEN);
  assert.equal(r.length, 2);
  assert.equal(r[0].fullName, 'Persona Uno'); assert.equal(r[0].isCoach, true); assert.equal(r[0].email, 'a@b.com'); assert.equal(r[0].curp, 'AAAA900902MCLSRL02');
  assert.equal(r[1].active, false); assert.equal(r[1].terminationDate, '2026-08-06'); assert.equal(r[1].sede, 'Ambas'); assert.equal(r[1].isCoach, false);
  assert.ok(r[1].warnings.some(w => w.includes('Fecha de nacimiento')));
});
test('Confidencial: solo "Por horas" importa pago', () => {
  const r = parseConfidential([['Nombre completo', 'Puesto', 'Fecha de ingreso', 'Estatus', 'Antigüedad (años)', 'Tipo de contrato', 'Pago por hora ($)', 'Horas por semana', 'Sueldo mensual estimado ($)', 'Fecha último aumento', 'Pago por hora anterior ($)', '% del último aumento', 'Fecha próxima revisión', 'Forma de pago', 'Banco', 'Notas'],
    ['A', 'Coach', '', '', '', 'Por horas', '$90.00', '19', '', '1/7/2026', '$80.00', '', '', 'Transferencia', 'BBVA', ''],
    ['B', 'Staff', '', '', '', 'Nómina', '$600.00', '1', '', '', '', '', '', 'Efectivo', '', '']]);
  assert.equal(r[0].importPay, true); assert.equal(r[0].hourlyCents, 9000); assert.equal(r[0].payMethod, 'transferencia'); assert.equal(r[0].lastRaiseDate, '2026-07-01');
  assert.equal(r[1].importPay, false); assert.ok(r[1].warnings[0].includes('Nómina'));
});
test('cálculos del Excel', () => {
  assert.equal(monthlyEstimateCents(9000, 19), 740430);       // $7,404.30 como en el Excel (Sayana)
  assert.equal(seniorityYears('2023-01-09', '2026-11-23'), 3.9);
  assert.equal(addMonthsIso('2026-08-31', 6), '2027-02-28');
});

test('fecha real de Excel (Date) y número sin formato', () => {
  const r = parseGeneral([['Nombre completo', 'CURP', 'Fecha de ingreso'], ['X', '', new Date(2023, 0, 9)]]);
  assert.equal(r[0].hireDate, '2023-01-09');
  assert.equal(parseMoney(600), 60000);
});
