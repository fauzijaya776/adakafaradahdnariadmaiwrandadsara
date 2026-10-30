'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(require.resolve('../qris_autogopay'), 'utf8');
function load(response, failure) {
    const calls = [];
    const context = { module: { exports: {} }, Buffer, Date, process: { env: { AUTOGOPAY_API_KEY: 'test-secret' } },
        require: name => name === 'crypto' ? crypto : { post: async (...args) => {
            calls.push(args); if (failure) throw failure;
            return { data: response };
        } } };
    vm.runInNewContext(source, context);
    return { api: context.module.exports, calls, context };
}
const invoice = () => ({ success: true, data: { transaction_id: 'tx-1', order_id: 'agp-1',
    amount: 10000, qr_string: '000201-test', expiry_time: new Date(Date.now() + 900000).toISOString() } });
test('generate uses documented origin, bearer authentication and amount; no custom order field', async () => {
    const { api, calls } = load(invoice());
    const result = await api.createTransaction('AGP-local', 10000);
    assert.equal(result.txnId, 'tx-1'); assert.equal(result.realOrderId, 'agp-1');
    assert.equal(result.totalBayar, 10000); assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'https://v1-gateway.autogopay.site/qris/generate');
    assert.equal(JSON.stringify(calls[0][1]), '{"amount":10000}');
    assert.equal(calls[0][2].headers.Authorization, 'Bearer test-secret');
    assert.equal(calls[0][2].maxRedirects, 0);
});
test('invalid and fractional amounts never reach the provider', async () => {
    const { api, calls } = load(invoice());
    for (const amount of [0, -1, 1.1, 10000001, NaN]) await assert.rejects(api.createTransaction('x', amount));
    assert.equal(calls.length, 0);
});
test('generate timeout has no retry and strips credentials from errors', async () => {
    const { api, calls } = load(null, new Error('Bearer test-secret'));
    await assert.rejects(api.createTransaction('x', 10000), error => !error.message.includes('test-secret'));
    assert.equal(calls.length, 1);
});
test('missing credentials never send a request', async () => {
    const { api, context, calls } = load(invoice()); delete context.process.env.AUTOGOPAY_API_KEY;
    await assert.rejects(api.createTransaction('x', 10000)); assert.equal(calls.length, 0);
});
test('rejects mismatched generated amount and malformed invoice', async () => {
    for (const data of [{ amount: 1 }, { ...invoice().data, amount: 9999 }, { ...invoice().data, transaction_id: '' }]) {
        await assert.rejects(load({ success: true, data }).api.createTransaction('x', 10000));
    }
});
test('provider statuses normalize without treating unknown values as paid', () => {
    const { api } = load(null);
    for (const [value, expected] of [['settlement','completed'],['pending','pending'],['expire','expired'],['cancel','cancelled'],['unrecognized','unknown']]) {
        assert.equal(api.normalizeStatus({ transaction_status: value }), expected);
    }
});
test('status requests use provider transaction ID and reject an explicit different ID', async () => {
    const { api, calls } = load({ success: true, data: { transaction_id: 'tx-1', transaction_status: 'settlement', amount: 10000 } });
    assert.equal((await api.checkPaymentStatus('tx-1')).status, 'completed');
    assert.equal(calls[0][0].endsWith('/qris/status'), true); assert.equal(calls[0][2].timeout, 6000);
    await assert.rejects(load({ success: true, data: { transaction_id: 'other', status: 'paid' } }).api.checkPaymentStatus('tx-1'));
});
test('cancel calls the documented endpoint once', async () => {
    const { api, calls } = load({ success: true, data: {} }); await api.cancelTransaction('tx-1');
    assert.equal(calls.length, 1); assert.equal(calls[0][0].endsWith('/qris/cancel'), true);
});
test('webhook HMAC verifies exact raw bytes, and rejects invalid or missing signatures', () => {
    const { api } = load(null); const raw = Buffer.from('{ "amount": 10000 }');
    const sign = crypto.createHmac('sha256','test-secret').update(raw).digest('hex');
    assert.equal(api.verifySignature(raw, sign), true);
    for (const value of [undefined, '', 'x', '0'.repeat(64)]) assert.equal(api.verifySignature(raw,value),false);
    assert.equal(api.verifySignature(Buffer.from('{"amount":10000}'), sign), false);
});
test('expiry parses timezone-less WIB timestamps independently of server timezone', () => {
    const { api } = load(null);
    const now = Date.parse('2026-10-30T09:00:00Z');
    assert.equal(api.expiryDate('2026-10-30 16:15:00', now).toISOString(), '2026-10-30T09:15:00.000Z');
    for (const value of ['', 'invalid', '2026-10-30 15:00:00']) assert.throws(() => api.expiryDate(value, now));
});

// Execute actual payment functions without starting Telegram, Express or MongoDB.
const appSource = fs.readFileSync(require.resolve('../all'), 'utf8');
const statusCode = appSource.slice(appSource.indexOf('async function autogopayStatusOf('), appSource.indexOf("app.post('/autogopay/callback'"));
test('status checks reject amount mismatch and outages', async () => {
    const context = { autogopay: { checkPaymentStatus: async () => ({status:'completed',amount:9999}) } };
    vm.createContext(context); vm.runInContext(statusCode, context);
    assert.equal(await context.autogopayStatusOf('tx', 10000), null);
    context.autogopay.checkPaymentStatus = async () => { throw new Error('offline'); };
    assert.equal(await context.autogopayStatusOf('tx', 10000), null);
});
test('sweeper keeps reservations on pending/outage and reconciles settled invoices after restart', async () => {
    let value = null, settled = 0, expired = 0;
    const row = { _id:'id',orderId:'agp',autogopayTxnId:'tx',amount:10000,status:'PENDING' };
    const context = { agpReady:true, agpDelivery:{recover:async()=>{}}, process:{env:{AUTOGOPAY_API_KEY:'test'}}, Date, console,
        Order:{find:()=>({sort:()=>({limit:()=>({lean:async()=>[row]})})}),updateOne:async()=>{}},
        paymentSessions:new Map(), autogopay:{checkPaymentStatus:async()=>{if(value===null)throw Error();return {status:value};}},
        fulfillAutoGoPayPaidOrder:async()=>{settled++;return {ok:true};},
        expireAutoGoPayOrder:async()=>{expired++;} };
    vm.createContext(context); vm.runInContext(statusCode,context);
    for (value of [null,'pending','unknown']) await context.sweepAutoGoPayOrders();
    assert.equal(expired,0); assert.equal(settled,0);
    value='completed'; await context.sweepAutoGoPayOrders(); assert.equal(settled,1);
    value='expired'; await context.sweepAutoGoPayOrders(); assert.equal(expired,1);
});

test('provider identity is persisted before expiry validation fails, enabling reconciliation',async()=>{
    const data=invoice();data.data.expiry_time='malformed';const {api}=load(data);let identity;
    await assert.rejects(api.createTransaction('local',10000,async value=>{identity=value;}));
    assert.equal(identity.txnId,'tx-1');assert.equal(identity.realOrderId,'agp-1');
});
test('parallel status reads share one network request',async()=>{
    const {api,calls}=load({success:true,data:{transaction_status:'pending'}});
    await Promise.all([api.checkPaymentStatus('same'),api.checkPaymentStatus('same'),api.checkPaymentStatus('same')]);
    assert.equal(calls.length,1);
});
test('rate-limit responses impose backoff rather than repeatedly calling provider',async()=>{
    const error=Error('sensitive config');error.response={status:429};const {api,calls}=load(null,error);
    await assert.rejects(api.checkPaymentStatus('tx'));await assert.rejects(api.checkPaymentStatus('tx'));
    await assert.rejects(api.createTransaction('local',10000));assert.equal(calls.length,1);
});

function webhookHarness() {
    const row={orderId:'AGP-local',autogopayTxnId:'tx-1',depositId:'provider-1',totalPaid:10000,amount:10000};
    let handler,settled=0,reads=0,status='completed';
    const {api}=load(null);
    const start=appSource.indexOf("app.post('/autogopay/callback'");
    const end=appSource.indexOf('// ===== Webhook / Callback QRIN',start);
    const context={agpReady:true,app:{post:(_,fn)=>{handler=fn;}},autogopay:api,console,
        Order:{findOne:query=>({lean:async()=>{reads++;return query.autogopayTxnId===row.autogopayTxnId?row:null;}})},
        autogopayStatusOf:async()=>status,settleAutoGoPay:async()=>{settled++;}};
    vm.runInNewContext(appSource.slice(start,end),context);
    async function invoke(change={},signatureOverride) {
        const payload={event:'transaction.received',transaction:{transaction_id:'tx-1',order_id:'provider-1',amount:10000,
            status:'PAID',payment_method:'QRIS',...change}};
        const raw=Buffer.from(JSON.stringify(payload));
        const signature=signatureOverride===undefined?crypto.createHmac('sha256','test-secret').update(raw).digest('hex'):signatureOverride;
        const response={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
        await handler({rawBody:raw,headers:{'x-signature':signature},body:payload},response);
        return response.code;
    }
    return {invoke,get settled(){return settled;},get reads(){return reads;},set status(value){status=value;}};
}
test('forged webhook signature cannot query or fulfill any order',async()=>{
    const h=webhookHarness();assert.equal(await h.invoke({},'0'.repeat(64)),401);assert.equal(h.reads,0);assert.equal(h.settled,0);
});
test('signed webhook must match provider order, transaction and amount',async()=>{
    for(const change of [{amount:1},{order_id:'wrong'},{transaction_id:'wrong'},{payment_method:'QRIS_SHOPEEPAY'}]){
        const h=webhookHarness();assert.notEqual(await h.invoke(change),200);assert.equal(h.settled,0);
    }
});
test('valid signed PAID webhook still requires authenticated provider settlement',async()=>{
    const h=webhookHarness();h.status='pending';assert.equal(await h.invoke(),503);assert.equal(h.settled,0);
    h.status='completed';assert.equal(await h.invoke(),200);assert.equal(h.settled,1);
});
function cancellationHarness(buyer='owner-of-order', paid=false) {
    let handler,cancelled=0,settled=0,expired=0,reads=0;
    const start=appSource.indexOf('bot.action(/^cancel_payment_autogopay_');
    const end=appSource.indexOf("bot.action(/^cancel_payment_(.*)",start);
    const row={status:paid?'PAID':'PENDING',orderId:'agp-1',autogopayTxnId:'tx',amount:10000,totalPaid:10000,customerInfo:{telegramUserId:'owner-of-order'}};
    const context={bot:{action:(_,fn)=>{handler=fn;}},paymentSessions:new Map(),clearInterval,clearTimeout,
        Order:{findOne:query=>({lean:async()=>query['customerInfo.telegramUserId']===row.customerInfo.telegramUserId?row:null})},
        autogopayStatusOf:async()=>++reads===1?'pending':'completed',
        autogopay:{cancelTransaction:async()=>{cancelled++;}},settleAutoGoPay:async()=>{settled++;},
        expireAutoGoPayOrder:async()=>{expired++;}};
    vm.runInNewContext(appSource.slice(start,end),context);
    return {invoke:()=>handler({from:{id:buyer},match:['','agp-1'],answerCbQuery:async()=>{},reply:async()=>{}}),
        get cancelled(){return cancelled;},get settled(){return settled;},get expired(){return expired;}};
}
test('a different buyer cannot cancel or inspect another buyer payment',async()=>{
    const h=cancellationHarness('other');await h.invoke();assert.equal(h.cancelled,0);assert.equal(h.settled,0);assert.equal(h.expired,0);
});
test('payment confirmed during cancel goes to fulfillment instead of returning inventory',async()=>{
    const h=cancellationHarness();await h.invoke();assert.equal(h.cancelled,1);assert.equal(h.settled,1);assert.equal(h.expired,0);
});

test('an already-paid local order is never sent to the provider cancellation endpoint',async()=>{
    const h=cancellationHarness('owner-of-order',true);await h.invoke();
    assert.equal(h.cancelled,0);assert.equal(h.expired,0);assert.equal(h.settled,1);
});
