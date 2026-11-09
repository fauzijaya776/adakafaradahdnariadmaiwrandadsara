'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Telegraf, Telegram } = require('telegraf');
const attach = require('../quick_stock_menu');
function setup(t) {
    const bot = new Telegraf('123:test');
    bot.botInfo = { id: 123, is_bot: true, username: 'test_bot', first_name: 'Test' };
    const out = []; let saves = 0, maps = 0, previews = 0, passed = 0, update = 0;
    t.mock.method(Telegram.prototype, 'callApi', async (method, data) => { out.push({method,data}); return true; });
    const states = {};
    const dest = { label:'DO / 3 Droplet', id:'v' };
    attach(bot, {userStates:states, adminMiddleware:(ctx,next)=>ctx.from.id === 1 ? next() : undefined,
        getAdminMenuMessageAndKeyboard:async()=>({message:'Panel Admin',keyboard:{reply_markup:{inline_keyboard:[]}}})}, {
        preview:async text=>{previews++;return [{n:1,email:'buyer@example.invalid',line:text,limit:3,target:dest},
            {n:2,error:'Duplikat'}];},
        save:async()=>{saves++;return {added:1,skipped:[]};},
        choices:async()=>[dest],map:async(limit,id)=>{assert.equal(limit,3);assert.equal(id,'v');maps++;},
    });
    bot.use(()=>{passed++;});
    async function send(value, { callback = false, id = 1, type = 'private' } = {}) {
        const from = { id, is_bot:false, first_name:'Test' }, chat = { id, type };
        const msg = { message_id: ++update, date: 1, from, chat, text: value };
        await bot.handleUpdate(callback ? { update_id:update,callback_query:{id:String(update),from,data:value,message:msg,chat_instance:'1'} }
            : {update_id:update,message:msg});
    }
    const click = (v,opts) => send(v,{callback:true,...opts});
    const last = () => out.filter(x=>['editMessageText','sendMessage'].includes(x.method)).at(-1)?.data;
    const button = (label) => last().reply_markup.inline_keyboard.flat().find(b=>b.text.includes(label)).callback_data;
    t.after(()=>{ Object.values(states).forEach(s=>clearTimeout(s.timer)); });
    return {states,out,click,send,last,button,get saves(){return saves;},get maps(){return maps;},get previews(){return previews;},get passed(){return passed;} };
}
test('Back discards the preview, restores the main panel and invalidates the old Save button',async t=>{
    const h=setup(t);await h.click('qs:open');
    await h.send('private-test-input'); assert.ok(h.out.some(x=>x.method==='deleteMessage'));
    assert.match(h.last().text,/3 droplet: 1 akun/);assert.match(h.last().text,/Duplikat: 1/);
    assert.ok(!h.last().text.includes('private-test-input'));assert.ok(!h.last().text.includes('buyer@example.invalid'));
    const save=h.button('Simpan');await h.click(h.button('Kembali'));
    assert.equal(h.last().text,'Panel Admin');assert.equal(h.states[1],undefined);
    await h.click(save);assert.equal(h.saves,0);
    await h.send('ordinary stock input');assert.equal(h.passed,1);
});
test('Save commits once, shows Add Again and Panel Admin, and a new preview has a fresh nonce',async t=>{
    const h=setup(t);await h.click('qs:open');const nonce=h.states[1].nonce;
    await h.send('private-test-input');const save=h.button('Simpan');await h.click(save);await h.click(save);
    assert.equal(h.saves,1);assert.equal(h.button('Panel Admin'),'admin_menu');assert.equal(h.states[1],undefined);
    await h.click(h.button('Tambah Lagi'));assert.notEqual(h.states[1].nonce,nonce);
    await h.click('admin_add_stock_select_product_1');assert.equal(h.states[1],undefined);
});
test('owner can map a limit to a catalog variant and continue directly to stock input',async t=>{
    const h=setup(t); await h.click('qs:open');await h.click(h.button('Pasangkan'));
    await h.send('3');await h.click(h.button('3 Droplet'));
    assert.equal(h.maps,1);assert.equal(h.states[1].step,'input');assert.equal(h.saves,0);
});
test('non-owner and group inputs cannot create a preview or save stock',async t=>{
    const h=setup(t);await h.click('qs:open',{id:2});await h.click('qs:open',{type:'group'});
    assert.equal(Object.keys(h.states).length,0);await h.click('qs:open');
    await h.send('private-test-input',{type:'group'});assert.equal(h.previews,0);
    await h.send('/admin');assert.equal(h.states[1],undefined);
});
