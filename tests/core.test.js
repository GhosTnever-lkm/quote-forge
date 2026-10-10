'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

test('rounds decimal money using half-away-from-zero, including numeric input artifacts', () => {
  assert.equal(core.roundMoney('1.005'), 1.01);
  assert.equal(core.roundMoney(-1.005), -1.01);
  assert.equal(core.roundMoney('0'), 0);
});

test('validates line descriptions, positive quantities, and nonnegative prices', () => {
  assert.equal(core.validateLineItems([{ description: 'Design', quantity: '1.5', unitPrice: '20.00' }]).valid, true);
  assert.equal(core.validateLineItems([{ description: ' ', quantity: 1, unitPrice: 2 }]).valid, false);
  assert.equal(core.validateLineItems([{ description: 'Free', quantity: 1, unitPrice: 0 }]).valid, true);
  assert.equal(core.validateLineItems([{ description: 'Bad', quantity: 0, unitPrice: -2 }]).valid, false);
});

test('calculates decimal quantities, percentage discount, and tax in cents', () => {
  const totals = core.calculateTotals([{ description: 'Hours', quantity: '1.5', unitPrice: '100.00' }], { type: 'percent', value: '10' }, '8.25');
  assert.deepEqual([totals.subtotalCents, totals.discountCents, totals.taxCents, totals.totalCents], ['15000', '1500', '1114', '14614']);
});

test('fixed discount cannot reduce total below zero; null tax means no tax', () => {
  const totals = core.calculateTotals([{ description: 'Item', quantity: 1, unitPrice: '12.00' }], { type: 'fixed', value: '99' }, null);
  assert.equal(totals.discountCents, '1200');
  assert.equal(totals.totalCents, '0');
  assert.equal(totals.taxCents, '0');
});

test('rejects negative discounts, invalid tax rates, and non-finite values', () => {
  const lines = [{ description: 'Item', quantity: 1, unitPrice: 10 }];
  assert.throws(() => core.calculateTotals(lines, { type: 'fixed', value: -1 }), /negative/);
  assert.throws(() => core.calculateTotals(lines, { type: 'fixed', value: 0 }, 101), /between 0 and 100/);
  assert.equal(core.validateLineItems([{ description: 'X', quantity: Infinity, unitPrice: 1 }]).valid, false);
});

test('keeps large decimal money exact in rounding and currency formatting', () => {
  assert.equal(core.roundMoney('9007199254740993.27'), '9007199254740993.27');
  assert.match(core.formatCurrency('9007199254740993.27', 'USD', 'en-US'), /9,007,199,254,740,993\.27/);
});

test('generates document numbers with a stable prefix/date shape and avoids supplied duplicates', () => {
  const date = new Date('2026-10-10T12:00:00Z');
  const first = core.generateDocumentNumber('inv/!', date);
  const second = core.generateDocumentNumber('inv/!', date, [first]);
  assert.match(first, /^INV-20261010-[A-Z0-9]+$/);
  assert.notEqual(first, second);
});

test('creates, exports, imports, and rejects an invalid document schema', () => {
  const document = core.createDocument({ type: 'quote', from: { name: 'Studio' }, to: { name: 'Client' }, lineItems: [{ description: 'Work', quantity: 1, unitPrice: '25.00' }] });
  const imported = core.importJSON(core.exportJSON(document));
  assert.equal(imported.type, 'quote');
  assert.equal(imported.lineItems[0].unitPrice, '25.00');
  assert.throws(() => core.importJSON('{broken'), /valid JSON/);
  assert.throws(() => core.importJSON({ ...document, schemaVersion: 99 }), /schemaVersion/);
  assert.throws(() => core.importJSON({ ...document, date: '2026-02-31' }), /YYYY-MM-DD/);
});
