import test from 'node:test';
import assert from 'node:assert/strict';
import { deductionsForPeriod, totalDeductions, type Deduction } from './deductions.ts';

const q = { start: '2026-11-15', end: '2026-11-29' };
const d = (over: Partial<Deduction>): Deduction =>
  ({ id: 'x', label: 'x', amountCents: 10000n, kind: 'unico', startDate: '2026-11-20', status: 'autorizado', ...over });

test('único: solo en el periodo que contiene su fecha', () => {
  assert.equal(deductionsForPeriod([d({})], q).length, 1);
  assert.equal(deductionsForPeriod([d({ startDate: '2026-11-30' })], q).length, 0);
});
test('recurrente: desde su inicio hasta su fin', () => {
  assert.equal(deductionsForPeriod([d({ kind: 'recurrente', startDate: '2026-10-01' })], q).length, 1);
  assert.equal(deductionsForPeriod([d({ kind: 'recurrente', startDate: '2026-10-01', endDate: '2026-11-14' })], q).length, 0);
  assert.equal(deductionsForPeriod([d({ kind: 'recurrente', startDate: '2026-11-29' })], q).length, 1);
});
test('pendientes, rechazados y cancelados no se aplican', () => {
  for (const status of ['pendiente', 'rechazado', 'cancelado'] as const) assert.equal(deductionsForPeriod([d({ status })], q).length, 0);
});
test('total', () => assert.equal(totalDeductions([d({}), d({ amountCents: 5050n })]), 15050n));
