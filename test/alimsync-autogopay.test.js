// Dana Alim: order Alim yang dibayar lewat AutoGoPay diverifikasi ke AutoGoPay, bukan Pakasir.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const sales = new Map();
const stub = (rel, exports) => { const f = path.join(__dirname, '..', rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
stub('db.js', {
  AlimSale: { updateOne: async (q, u) => { if (sales.has(q.orderId)) return { upsertedCount: 0 }; sales.set(q.orderId, u.$setOnInsert); return { upsertedCount: 1 }; } },
  Settings: {},
});
const calls = { agp: [], pk: [] };
const agpStatus = new Map();
stub('qris_autogopay.js', { checkPaymentStatus: async (id) => { calls.agp.push(id); if (!agpStatus.has(id)) throw new Error('offline'); return agpStatus.get(id); } });
stub('qris_pakasir.js', { checkPaymentStatus: async (id) => { calls.pk.push(id); return { status: 'completed', order_id: 'ALIM-1-OLD', amount: 7000 }; } });
const { verifyAndRecord } = require('../alimsync');

test('order bot ALIM (agp:) diverifikasi ke AutoGoPay dan dicatat sekali', async () => {
  agpStatus.set('T1', { status: 'completed' }); // status AutoGoPay biasanya tanpa nominal
  const doc = { orderId: 'ALIM-1-100', pakasirTxnId: 'agp:T1', amount: 5000, paymentGateway: 'pakasir', paidAt: new Date() };
  assert.deepEqual(await verifyAndRecord(doc), { status: 'recorded', amount: 5000 });
  assert.deepEqual(calls.agp, ['T1']); assert.equal(calls.pk.length, 0);
  assert.equal(sales.get('ALIM-1-100').txnId, 'agp:T1');
  assert.equal((await verifyAndRecord(doc)).status, 'already');
});

test('order website Alim (gateway autogopay, ID tanpa awalan) juga ke AutoGoPay', async () => {
  agpStatus.set('W1', { status: 'completed', amount: 12000 });
  const r = await verifyAndRecord({ orderId: 'WEBALIM-ABCDEFGHIJ', pakasirTxnId: 'W1', amount: 12000, paymentGateway: 'autogopay' });
  assert.deepEqual(r, { status: 'recorded', amount: 12000 });
});

test('AutoGoPay pending / expire / nominal beda / API mati tidak dicatat', async () => {
  agpStatus.set('P', { status: 'pending' }); agpStatus.set('E', { status: 'expired' }); agpStatus.set('M', { status: 'completed', amount: 1 });
  assert.equal((await verifyAndRecord({ orderId: 'ALIM-2-1', pakasirTxnId: 'agp:P', amount: 5000 })).status, 'pending');
  assert.equal((await verifyAndRecord({ orderId: 'ALIM-2-2', pakasirTxnId: 'agp:E', amount: 5000 })).status, 'rejected');
  assert.equal((await verifyAndRecord({ orderId: 'ALIM-2-3', pakasirTxnId: 'agp:M', amount: 5000 })).status, 'rejected');
  assert.equal((await verifyAndRecord({ orderId: 'ALIM-2-4', pakasirTxnId: 'agp:OFF', amount: 5000 })).status, 'check_failed');
  assert.ok(!sales.has('ALIM-2-1') && !sales.has('ALIM-2-2') && !sales.has('ALIM-2-3') && !sales.has('ALIM-2-4'));
});

test('order Pakasir lama tetap diverifikasi ke Pakasir', async () => {
  const before = calls.agp.length;
  const r = await verifyAndRecord({ orderId: 'ALIM-1-OLD', pakasirTxnId: 'pk-1', amount: 7000, paymentGateway: 'pakasir' });
  assert.equal(r.status, 'recorded'); assert.equal(calls.agp.length, before); assert.deepEqual(calls.pk, ['pk-1']);
});
