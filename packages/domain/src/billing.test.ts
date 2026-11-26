import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyCharge, payStage, siblingTargets, planChangeDifference, prepayQuote, checkCombo } from './billing.ts';

test('etapas de pago por fecha', () => {
  assert.equal(payStage('2026-12', '2026-11-28').stage, 'pronto');
  assert.equal(payStage('2026-12', '2026-12-01').stage, 'normal');
  assert.equal(payStage('2026-12', '2026-12-05').stage, 'normal');
  assert.deepEqual(payStage('2026-12', '2026-12-06'), { stage: 'recargo', bps: 500 });
  assert.deepEqual(payStage('2026-12', '2026-12-10'), { stage: 'recargo', bps: 500 });
  assert.deepEqual(payStage('2026-12', '2026-12-11'), { stage: 'recargo', bps: 1000 });
  assert.deepEqual(payStage('2026-12', '2027-01-03'), { stage: 'recargo', bps: 1000 });   // pagó el mes siguiente
});

test('mensualidad: pronto pago, normal y recargos', () => {
  const p = 201500;   // $2,015
  assert.equal(monthlyCharge({ price: p, month: '2026-12', payDate: '2026-11-30', sibling: false }).total, 191425);
  assert.equal(monthlyCharge({ price: p, month: '2026-12', payDate: '2026-12-03', sibling: false }).total, 201500);
  assert.equal(monthlyCharge({ price: p, month: '2026-12', payDate: '2026-12-08', sibling: false }).total, 211575);
  assert.equal(monthlyCharge({ price: p, month: '2026-12', payDate: '2026-12-15', sibling: false }).total, 221650);
});

test('hermana con descuento no lleva pronto pago, pero sí recargo', () => {
  const early = monthlyCharge({ price: 150000, month: '2026-12', payDate: '2026-11-20', sibling: true });
  assert.equal(early.sibling, -22500); assert.equal(early.early, 0); assert.equal(early.total, 127500);
  const late = monthlyCharge({ price: 150000, month: '2026-12', payDate: '2026-12-07', sibling: true });
  assert.equal(late.total, 127500 + 6375);
});

test('becas y descuentos van primero, por porcentaje o cantidad', () => {
  const r = monthlyCharge({ price: 200000, month: '2026-12', payDate: '2026-12-02', sibling: false,
    adjustments: [{ label: 'Beca 50 %', mode: 'pct', value: 5000 }, { label: 'Apoyo', mode: 'monto', value: 20000 }] });
  assert.deepEqual(r.adjustments.map(a => a.amount), [-100000, -20000]); assert.equal(r.total, 80000);
  assert.equal(monthlyCharge({ price: 100000, month: '2026-12', payDate: null, sibling: false, adjustments: [{ label: 'Beca', mode: 'pct', value: 10000 }] }).total, 0);
});

test('hermanos: todas menos la del plan más caro, entre sucursales; los planes familiares no cuentan', () => {
  const t = siblingTargets([
    { id: 'a', familyId: 'F', price: 201500 }, { id: 'b', familyId: 'F', price: 169500 }, { id: 'c', familyId: 'F', price: 109500 },
    { id: 'd', familyId: 'G', price: 201500 }, { id: 'e', familyId: null, price: 100000 },
    { id: 'f', familyId: 'H', price: 300000, familyPlan: true }, { id: 'g', familyId: 'H', price: 100000 }]);
  assert.deepEqual([...t].sort(), ['b', 'c']);
});

test('cambio de plan cobra la diferencia', () => {
  assert.equal(planChangeDifference(201500, 245000), 43500);
  assert.equal(planChangeDifference(245000, 201500), -43500);
});

test('con beca no hay otro descuento (sí recargo)', () => {
  const adj = [{ label: 'Beca 30 %', mode: 'pct' as const, value: 3000, kind: 'beca' as const }, { label: 'Descuento', mode: 'monto' as const, value: 10000, kind: 'descuento' as const }];
  const early = monthlyCharge({ price: 200000, month: '2026-12', payDate: '2026-11-20', sibling: true, adjustments: adj });
  assert.deepEqual([early.adjustments.length, early.sibling, early.early, early.total], [1, 0, 0, 140000]);
  // paga el día 3: con beca, sin recargo
  assert.equal(monthlyCharge({ price: 200000, month: '2026-12', payDate: '2026-12-03', sibling: false, adjustments: adj }).total, 140000);
  // la becada no cuenta para hermanos: su hermana queda sola y no lleva 15 %
  assert.deepEqual([...siblingTargets([{ id: 'a', familyId: 'F', price: 200000 }, { id: 'b', familyId: 'F', price: 150000, beca: true }])], []);
});

test('familia: 15 % al plan más barato, pronto pago al más caro', () => {
  const t = siblingTargets([{ id: 'cara', familyId: 'F', price: 201500 }, { id: 'barata', familyId: 'F', price: 169500 }]);
  const cara = monthlyCharge({ price: 201500, month: '2026-12', payDate: '2026-11-28', sibling: t.has('cara') });
  const barata = monthlyCharge({ price: 169500, month: '2026-12', payDate: '2026-11-28', sibling: t.has('barata') });
  assert.deepEqual([cara.early, cara.sibling, barata.early, barata.sibling], [-10075, 0, 0, -25425]);
  assert.equal(cara.total + barata.total, 191425 + 144075);
});

test('pago por adelantado: descuento, total y reparto por mes', () => {
  const q = prepayQuote(201500, 6, 1500);
  assert.deepEqual([q.gross, q.discount, q.total], [1209000, 181350, 1027650]);
  assert.equal(q.perMonth.reduce((a, b) => a + b, 0), q.total); assert.equal(q.perMonth[0], 171275);
  const odd = prepayQuote(100001, 3, 0); assert.deepEqual(odd.perMonth, [100001, 100001, 100001]);
});

test('becada que paga del día 6 en adelante pierde la beca: plan completo + recargo', () => {
  const adj = [{ label: 'Beca 50 %', mode: 'pct' as const, value: 5000, kind: 'beca' as const }];
  const d6 = monthlyCharge({ price: 200000, month: '2026-12', payDate: '2026-12-06', sibling: false, adjustments: adj });
  assert.deepEqual([d6.becaLost, d6.adjustments.length, d6.surcharge, d6.total], [true, 0, 10000, 210000]);
  const d12 = monthlyCharge({ price: 200000, month: '2026-12', payDate: '2026-12-12', sibling: true, adjustments: adj });
  assert.deepEqual([d12.sibling, d12.total], [0, 220000]);   // tampoco recupera el de hermanos
  assert.equal(monthlyCharge({ price: 200000, month: '2026-12', payDate: '2026-12-05', sibling: false, adjustments: adj }).total, 100000);
});

test('doble disciplina: máximo 12 h en total y 8 h por disciplina (configurable)', () => {
  const lim = { maxTotal: 12, perDiscipline: { Telas: { min: 1, max: 4 } } };
  assert.deepEqual(checkCombo([{ discipline: 'Gimnasia Regular', hours: 8 }, { discipline: 'Parkour', hours: 4 }], lim), []);
  assert.deepEqual(checkCombo([{ discipline: 'Gimnasia Regular', hours: 9 }, { discipline: 'Parkour', hours: 3 }], lim), ['Gimnasia Regular: máximo 8 h']);
  assert.deepEqual(checkCombo([{ discipline: 'Gimnasia Regular', hours: 8 }, { discipline: 'Parkour', hours: 6 }], lim), ['El total es 14 h; el máximo es 12 h']);
  assert.deepEqual(checkCombo([{ discipline: 'Gimnasia Regular', hours: 6 }, { discipline: 'Telas', hours: 5 }], lim), ['Telas: máximo 4 h']);
  assert.deepEqual(checkCombo([{ discipline: 'Parkour', hours: 3 }], lim), ['Elige al menos dos disciplinas']);
});
