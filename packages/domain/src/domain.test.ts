import test from 'node:test';
import assert from 'node:assert/strict';
import { computePayroll, formatMXN, type DayRecord } from './payroll.ts';
import { breakdownAmount, planCash, DEFAULT_DENOMINATIONS, reconcile } from './cash.ts';

const day = (date: string, minutes: number, incidence: DayRecord['incidence'] = 'ninguna', rate = 10000n): DayRecord =>
  ({ date, minutesWorked: minutes, incidence, rateCents: rate });

test('nómina = horas × pago por hora', () => {
  const r = computePayroll({ days: [day('2026-11-01', 480), day('2026-11-02', 450)],
    lateDeductionBps: 2500, lateDeductionAuthorized: true, loans: [] });
  assert.equal(r.grossCents, 155000n);          // 930 min = 15.5 h × $100 = $1,550.00
});

test('ejemplo del proyecto: 3 retardos a $100 → $75 de rebaja (25% por cada retardo)', () => {
  const days = [day('2026-11-01', 60, 'retardo'), day('2026-11-02', 60, 'retardo'), day('2026-11-03', 60, 'retardo')];
  const r = computePayroll({ days, lateDeductionBps: 2500, lateDeductionAuthorized: true, loans: [] });
  assert.equal(r.totalRetardos, 3);
  assert.equal(r.lateTotalCents, 7500n);
  assert.equal(r.lateLines[0].amountCents, 2500n);
});

test('sin autorización legal la rebaja se calcula pero no se aplica', () => {
  const r = computePayroll({ days: [day('2026-11-01', 60, 'retardo')], lateDeductionBps: 2500,
    lateDeductionAuthorized: false, loans: [] });
  assert.equal(r.lateTotalCents, 0n);
  assert.equal(r.lateComputedButNotApplied, 2500n);
  assert.ok(r.warnings.length > 0);
});

test('préstamo no descuenta más que el saldo; neta y diferencia vs reportada', () => {
  const r = computePayroll({ days: [day('2026-11-01', 600)], lateDeductionBps: 2500, lateDeductionAuthorized: true,
    loans: [{ configuredCents: 50000n, balanceCents: 30000n }], reportedCents: 70000n });
  assert.equal(r.loansCents, 30000n);
  assert.equal(r.netCents, 100000n - 30000n);
  assert.equal(r.diffNetVsReportedCents, 0n);
});

test('tarifa distinta por día (aumento a mitad de periodo)', () => {
  const r = computePayroll({ days: [day('2026-11-01', 60, 'ninguna', 10000n), day('2026-11-02', 60, 'ninguna', 12000n)],
    lateDeductionBps: 2500, lateDeductionAuthorized: true, loans: [] });
  assert.equal(r.grossCents, 22000n);
});

test('formato MXN', () => assert.equal(formatMXN(238000n), '$2,380.00'));

test('ejemplo del proyecto: $2,380 = 4×500 + 200 + 100 + 50 + 20 + 10 (billetes de $1,000 desactivados por defecto)', () => {
  // $1,000 viene desactivado por defecto.
  const b = breakdownAmount(238000n, DEFAULT_DENOMINATIONS);
  assert.ok(b.ok);
  assert.equal(b.pieces['billete-50000'], 4);
  assert.equal(b.pieces['billete-20000'], 1);
  assert.equal(b.pieces['billete-10000'], 1);
  assert.equal(b.pieces['billete-5000'], 1);
  assert.equal(b.pieces['billete-2000'], 1);
  assert.equal(b.pieces['moneda-1000'], 1);
  assert.equal(b.totalPieces, 9);
});

test('si se activa $1,000 manualmente, se usa; por defecto no', () => {
  const on = DEFAULT_DENOMINATIONS.map(d => d.id === 'billete-100000' ? { ...d, active: true } : d);
  const b = breakdownAmount(238000n, on);
  assert.equal(b.pieces['billete-100000'], 2);
  assert.equal(b.totalPieces, 7);
});

test('importe no múltiplo de $0.50 → sin combinación exacta, sin redondear', () => {
  const b = breakdownAmount(10025n, DEFAULT_DENOMINATIONS);
  assert.equal(b.ok, false);
  assert.equal(b.remainderCents, 25n);
});

test('existencias limitadas se respetan y el total general suma los individuales', () => {
  const denoms = DEFAULT_DENOMINATIONS.map(d => d.id === 'billete-50000' ? { ...d, available: 1 } : d);
  const plan = planCash([
    { employeeId: 'a', companyId: 'X', amountCents: 100000n },
    { employeeId: 'b', companyId: 'Y', amountCents: 50000n }], denoms);
  assert.equal(plan.failures.length, 0);
  assert.ok((plan.grand.pieces['billete-50000'] ?? 0) <= 1);
  assert.equal(plan.grand.amountCents, 150000n);
  assert.equal(plan.totalsByCompany['X'].amountCents, 100000n);   // empresas no se mezclan
  assert.equal(plan.totalsByCompany['Y'].amountCents, 50000n);
});

test('conciliación', () => {
  assert.equal(reconcile(100000n, 90000n).leftoverCents, 10000n);
  assert.equal(reconcile(100000n, 110000n).shortfall, true);
});
