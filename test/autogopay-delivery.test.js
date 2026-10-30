'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createDelivery = require('../autogopay_delivery');
function harness() {
    const state={orderId:'agp-1',paymentGateway:'autogopay',status:'PAID',delivered:false,
        deliveryState:'READY',deliveryAttempts:0,reservedItems:['same-account'],quantity:1,
        customerInfo:{telegramUserId:'u'},amount:10000};
    let sent=0, notified=0, failSave=false, sendError;
    function matches(filter) {
        return filter.$or.some(f=>state.deliveryState===f.deliveryState &&
            (!f.deliveryRetryAt || state.deliveryRetryAt<=f.deliveryRetryAt.$lte)) && state.delivered!==true;
    }
    const Order={findOneAndUpdate:async(filter,update)=>{
        if(!matches(filter))return null;
        Object.assign(state,update.$set);state.deliveryAttempts+=update.$inc.deliveryAttempts;
        return structuredClone(state);
    },updateOne:async(_,update)=>{
        if(failSave && update.$set.delivered)throw Error('DB offline after Telegram accepted');
        Object.assign(state,update.$set);
    },updateMany:async(filter,update)=>{
        if(state.deliveryState==='SENDING' && state.deliveryStartedAt<filter.deliveryStartedAt.$lt)Object.assign(state,update.$set);
    },find:filter=>({limit:()=>({lean:async()=>{
        if(filter.reviewNotifiedAt)return state.deliveryState==='REVIEW' && !state.reviewNotifiedAt?[structuredClone(state)]:[];
        return ['READY','RETRY'].includes(state.deliveryState)?[structuredClone(state)]:[];
    }})})};
    const api=createDelivery({Order,telegram:{sendDocument:async()=>{sent++;if(sendError)throw sendError;return {message_id:42};}},
        formatItemsForFile:items=>items.join('\n'),onDelivered:async()=>{},onReview:async()=>{notified++;}});
    return {api,state,get sent(){return sent;},get notified(){return notified;},
        set failSave(value){failSave=value;},set sendError(value){sendError=value;}};
}
test('parallel delivery requests produce one document containing the same allocated inventory',async()=>{
    const h=harness();await Promise.all([h.api.deliver(h.state),h.api.deliver(h.state)]);
    assert.equal(h.sent,1);assert.equal(h.state.delivered,true);assert.equal(h.state.deliveryMessageId,42);
});
test('Telegram timeout moves to REVIEW and never automatically sends again',async()=>{
    const h=harness();h.sendError=Error('connection reset after send');await h.api.deliver(h.state);
    assert.equal(h.state.deliveryState,'REVIEW');await h.api.recover();await h.api.recover();
    assert.equal(h.sent,1);assert.equal(h.notified,1);assert.deepEqual(h.state.reservedItems,['same-account']);
});
test('DB failure after Telegram acceptance does not trigger duplicate sends after restart',async()=>{
    const h=harness();h.failSave=true;await assert.rejects(h.api.deliver(h.state));
    assert.equal(h.state.deliveryState,'SENDING');h.state.deliveryStartedAt=new Date(Date.now()-6*60000);
    await h.api.recover();assert.equal(h.state.deliveryState,'REVIEW');assert.equal(h.sent,1);assert.equal(h.notified,1);
});
test('explicit Telegram 429 retries only after retry_after without regenerating or changing inventory',async()=>{
    const h=harness();h.sendError={response:{error_code:429,parameters:{retry_after:120}}};
    await h.api.deliver(h.state);assert.equal(h.state.deliveryState,'RETRY');await h.api.deliver(h.state);
    assert.equal(h.sent,1);h.state.deliveryRetryAt=new Date(Date.now()-1000);h.sendError=null;
    await h.api.deliver(h.state);assert.equal(h.sent,2);assert.equal(h.state.delivered,true);
});
test('blocked customer and missing inventory enter manual review rather than repeated sends',async()=>{
    const h=harness();h.sendError={response:{error_code:403}};await h.api.deliver(h.state);await h.api.recover();assert.equal(h.sent,1);
    const invalid=harness();invalid.state.reservedItems=[];await invalid.api.deliver(invalid.state);
    assert.equal(invalid.sent,0);assert.equal(invalid.state.deliveryState,'REVIEW');
});
