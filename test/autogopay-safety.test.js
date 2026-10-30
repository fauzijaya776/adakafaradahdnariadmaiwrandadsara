'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createSafety = require('../autogopay_safety');
const clone = value => structuredClone(value);
// Transactional in-memory harness: serializes commits and rolls back on injected failures.
// Exercises the actual safety module, without contacting a production database.
function harness() {
    let state = { settings: { identifier:'global-settings' }, order:{orderId:'AGP-1',paymentGateway:'autogopay',
        status:'PENDING',inventoryState:'HELD',quantity:1,reservedItems:['A'],amount:10000,
        productId:'p',variantSlug:'v',customerInfo:{telegramUserId:'u'}},
        product:{id:'p',variants:[{slug:'v',stock:['B'],reserved_stock:['A']}]}, spent:0 };
    let queue = Promise.resolve(), failOn;
    function doc(kind) { const value = clone(state[kind]); if(!value)return null;
        value.save = async () => { if(failOn === kind) throw Error('injected failure');
            const data={...value};delete data.save;state[kind]=clone(data);}; return value; }
    function query(kind, filter) {
        return { session: async () => {
            const item=state[kind];
            if(!item || Object.entries(filter).some(([key,value])=>item[key]!==value))return null;
            return doc(kind);
        } };
    }
    const Settings = function(value){Object.assign(this,value);this.save=async()=>{state.settings=clone(value);};};
    Settings.findOne = filter => query('settings',filter);
    Settings.updateOne = async (filter,update) => {
        if(Object.entries(filter).every(([k,v])=>state.settings[k]===v)) {
            for(const key of Object.keys(update.$unset||{})) delete state.settings[key];
            Object.assign(state.settings,update.$set||{});
            for(const [key,value] of Object.entries(update.$max||{})) {
                if(!state.settings[key] || state.settings[key]<value) state.settings[key]=value;
            }
        }
    };
    const deps={ Settings,
        mongoose:{startSession:async()=>({withTransaction:async work=>{
            let unlock;const prior=queue;queue=new Promise(r=>{unlock=r;});await prior;
            const snapshot=clone(state);try{return await work();}catch(e){state=snapshot;throw e;}finally{unlock();}
        },endSession:async()=>{}})},
        Order:{findOne:f=>query('order',f),updateOne:async()=>{}},
        Product:{findOne:f=>query('product',f)},
        User:{updateOne:async(_,update)=>{if(failOn==='user')throw Error('injected failure');state.spent+=update.$inc.totalSpent;}}
    };
    return { safety:createSafety(deps), get state(){return state;}, set fail(value){failOn=value;},
        tx:work=>deps.mongoose.startSession().then(async s=>{try{await s.withTransaction(()=>work(s));}finally{await s.endSession();}}) };
}
test('two simultaneous paid notifications commit inventory and accounting exactly once', async()=>{
    const h=harness();h.state.settings.autogopayActiveOrder='AGP-1';
    await Promise.all([h.safety.settle('AGP-1'),h.safety.settle('AGP-1')]);
    assert.equal(h.state.spent,10000);assert.equal(h.state.order.status,'PAID');
    assert.equal(h.state.order.inventoryState,'SOLD');assert.deepEqual(h.state.order.reservedItems,['A']);
    assert.deepEqual(h.state.product.variants[0].reserved_stock,[]);
    assert.deepEqual(h.state.product.variants[0].stock,['B']);assert.equal(h.state.settings.autogopayActiveOrder,undefined);
});
test('DB failure after inventory change rolls back order, stock, accounting and gate', async()=>{
    const h=harness();h.state.settings.autogopayActiveOrder='AGP-1';h.fail='order';
    await assert.rejects(h.safety.settle('AGP-1'));
    assert.equal(h.state.order.status,'PENDING');assert.equal(h.state.spent,0);
    assert.deepEqual(h.state.product.variants[0].reserved_stock,['A']);
    assert.equal(h.state.settings.autogopayActiveOrder,'AGP-1');
});
test('expiry only accepts confirmed terminal status and returns stock once', async()=>{
    const h=harness();
    for(const status of ['pending',null,'unknown','completed'])await assert.rejects(h.safety.expire('AGP-1',status));
    await Promise.all([h.safety.expire('AGP-1','expired'),h.safety.expire('AGP-1','expired')]);
    assert.deepEqual(h.state.product.variants[0].stock,['B','A']);assert.equal(h.state.order.status,'EXPIRED');
});
test('expiry failure rolls back stock and status together', async()=>{
    const h=harness();h.fail='order';await assert.rejects(h.safety.expire('AGP-1','cancelled'));
    assert.equal(h.state.order.status,'PENDING');assert.deepEqual(h.state.product.variants[0].stock,['B']);
});
test('payment racing cancellation never both sells and releases the same stock', async()=>{
    const h=harness();await Promise.all([h.safety.settle('AGP-1'),h.safety.expire('AGP-1','cancelled')]);
    assert.equal(h.state.order.status,'PAID');assert.deepEqual(h.state.product.variants[0].stock,['B']);
    assert.equal(h.state.spent,10000);
});
test('late settlement allocates fresh stock instead of sending released credentials', async()=>{
    const h=harness();await h.safety.expire('AGP-1','expired');
    h.state.product.variants[0].stock=['B']; // A was sold to someone else.
    await h.safety.settle('AGP-1');assert.deepEqual(h.state.order.reservedItems,['B']);
    assert.deepEqual(h.state.product.variants[0].stock,[]);
});
test('late payment with no stock records paid and enters manual fulfillment, never sends old credentials', async()=>{
    const h=harness();await h.safety.expire('AGP-1','expired');h.state.product.variants[0].stock=[];
    await h.safety.settle('AGP-1');assert.equal(h.state.order.status,'PAID');
    assert.equal(h.state.order.deliveryState,'REVIEW');assert.deepEqual(h.state.order.reservedItems,[]);
    assert.equal(h.state.spent,10000);
});
test('inconsistent reservation is not silently returned to sale', async()=>{
    const h=harness();h.state.product.variants[0].reserved_stock=[];
    await assert.rejects(h.safety.expire('AGP-1','expired'));assert.equal(h.state.order.status,'PENDING');
    await h.safety.settle('AGP-1');assert.equal(h.state.order.deliveryState,'REVIEW');
});
test('durable merchant gate accepts only one concurrent generate claim', async()=>{
    const h=harness();const now=new Date();
    const results=await Promise.allSettled(['one','two'].map(id=>h.tx(s=>h.safety.claimGeneration(id,'u',s,now))));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(h.state.settings.autogopayHourCount,1);assert.equal(h.state.settings.autogopayDayCount,1);
});
test('cooldown, hourly/day caps and circuit breaker all block without consuming another attempt', async()=>{
    const h=harness();const now=new Date();
    for(const settings of [
        {autogopayNextGenerateAt:new Date(now.getTime()+1000)},
        {autogopayCircuitOpen:true},
        {autogopayHour:Math.floor(+now/3600000),autogopayHourCount:20},
        {autogopayDay:Math.floor(+now/86400000),autogopayDayCount:100},
    ]){
        h.state.settings={identifier:'global-settings',...settings};
        await assert.rejects(h.tx(s=>h.safety.claimGeneration('new','u',s,now)));
        assert.equal(h.state.settings.autogopayActiveOrder,undefined);
    }
});
test('rolled-back checkout does not consume gate or generation budget', async()=>{
    const h=harness();await assert.rejects(h.tx(async s=>{await h.safety.claimGeneration('new','u',s);throw Error('stock conflict');}));
    assert.equal(h.state.settings.autogopayActiveOrder,undefined);assert.equal(h.state.settings.autogopayDayCount,undefined);
});

test('cancelled invoices block new generation until their original expiry, even after the normal cooldown', async()=>{
    const h=harness();const now=new Date();h.state.order.autogopayExpiresAt=new Date(+now+15*60000);
    h.state.settings.autogopayActiveOrder='AGP-1';
    await h.safety.expire('AGP-1','cancelled');
    await assert.rejects(h.tx(s=>h.safety.claimGeneration('next','u',s,new Date(+now+120000))));
    assert.equal(+h.state.settings.autogopayNextGenerateAt,+h.state.order.autogopayExpiresAt);
});
