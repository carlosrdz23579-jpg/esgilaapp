import test from 'node:test';
import assert from 'node:assert/strict';
import { loanLinesForPeriod, type Loan } from './loans.ts';

const p = { start: '2026-11-15', end: '2026-11-29' };
const base: Loan = { id: 'a', label: 'Préstamo', lender: 'empresa', totalCents: 100000n, paidCents: 0n, installmentCents: 30000n, startDate: '2026-11-01', status: 'activo' };

test('parcialidad normal y última parcialidad = saldo', () => {
  assert.equal(loanLinesForPeriod([base], [], p)[0].amountCents, 30000n);
  const ultimo = loanLinesForPeriod([{ ...base, paidCents: 90000n }], [], p)[0];
  assert.equal(ultimo.amountCents, 10000n); assert.equal(ultimo.balanceAfterCents, 0n);
});
test('salto autorizado por el director: no se descuenta; pendiente sí se descuenta', () => {
  const s = loanLinesForPeriod([base], [{ loanId: 'a', date: '2026-11-20', status: 'autorizado' }], p)[0];
  assert.equal(s.amountCents, 0n); assert.equal(s.skipped, true);
  assert.equal(loanLinesForPeriod([base], [{ loanId: 'a', date: '2026-11-20', status: 'pendiente' }], p)[0].amountCents, 30000n);
});
test('no aplica: pendiente de autorizar, liquidado o empieza después', () => {
  assert.equal(loanLinesForPeriod([{ ...base, status: 'pendiente' }], [], p).length, 0);
  assert.equal(loanLinesForPeriod([{ ...base, status: 'liquidado' }], [], p).length, 0);
  assert.equal(loanLinesForPeriod([{ ...base, startDate: '2026-12-01' }], [], p).length, 0);
});
test('préstamo del director con interés: total = capital + interés', () => {
  const d: Loan = { ...base, id: 'd', lender: 'director', totalCents: 220000n, installmentCents: 50000n };
  assert.equal(loanLinesForPeriod([d], [], p)[0].balanceAfterCents, 170000n);
});
