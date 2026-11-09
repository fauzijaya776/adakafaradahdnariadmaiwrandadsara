'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { Telegraf } = require('telegraf');
const create = require('../webhook_runner');
const guardFactory = require('../update_guard');
const origin = 'https://adakafaradahdnariadmaiwrandadsara-1-bkyv.onrender.com';
const secret = 'a'.repeat(64);
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { execute = async () => {}, seen = new Set(), failReceipt = false,
    configuredSecret = secret, renderOrigin = origin } = {}) {
    const app = express();
    const bot = new Telegraf('123:test'); const calls = [];
    bot.telegram.callApi = async (method, payload) => {
        calls.push({ method, payload });
        if (method === 'getMe') return { id: 123, first_name: 'Test', username: 'test_bot', is_bot: true };
        if (method === 'setWebhook') return true;
        if (method === 'getWebhookInfo') return { url: origin + '/telegram/update' };
        assert.fail('unexpected Telegram method ' + method);
    };
    const db = { readyState: 1, collection: name => name === 'telegram_webhook_config'
        ? { findOneAndUpdate: async (key, update, options) => {
            assert.equal(key._id, '123@' + origin); assert.equal(options.upsert, true);
            assert.match(update.$setOnInsert.secret, /^[a-f0-9]{64}$/); return { secret };
        } } : { createIndex: async () => {}, insertOne: async doc => {
            if (failReceipt) throw Error('offline');
            if (seen.has(doc._id)) throw Object.assign(Error('duplicate'), { code: 11000 });
            seen.add(doc._id);
        } } };
    const runner = create({ bot, app, origin: renderOrigin, token: '123:test', configuredSecret, db, dataReady: () => true });
    const guard = guardFactory({ isOwner: () => false, onError: e => { throw e; } });
    bot.use((ctx, next) => runner.track(ctx.update, guard.dispatch(ctx, () => runner.once(ctx.update, next))));
    bot.use(execute);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const task = runner.start(); await flush();
    t.after(async () => { guard.stop(); runner.stop(); await task; server.closeAllConnections(); await new Promise(r => server.close(r)); });
    const post = (id, header = secret) => fetch('http://127.0.0.1:' + server.address().port + '/telegram/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': header },
        body: JSON.stringify({ update_id: id, message: { message_id: id, date: 1, text: '/start',
            from: { id: 2, is_bot: false, first_name: 'Buyer' }, chat: { id: 2, type: 'private' } } }),
    });
    return { runner, guard, post, calls };
}

test('Render registers the verified production URL, preserves the Telegram backlog and authenticates updates', async t => {
    let handled = 0;
    const h = await fixture(t, { configuredSecret: '', execute: () => { handled++; } });
    const registration = h.calls.find(x => x.method === 'setWebhook').payload;
    assert.equal(registration.url, origin + '/telegram/update');
    assert.equal(registration.secret_token, secret); assert.equal(registration.drop_pending_updates, false);
    assert.equal(h.runner.isHealthy(), true);
    assert.equal((await h.post(10, 'wrong')).status, 403); assert.equal(handled, 0);
    assert.equal((await h.post(-1)).status, 400);
    assert.equal((await h.post(10)).status, 200); assert.equal(handled, 1);
});

test('duplicate deliveries wait for the same handler, with replay protection across restart', async t => {
    const seen = new Set(); let handled = 0; let release, start;
    const started = new Promise(r => { start = r; });
    const h = await fixture(t, { seen, execute: () => { handled++; start(); return new Promise(r => { release = r; }); } });
    const p = h.post(20); await started; const duplicate = h.post(20); release();
    assert.equal((await p).status, 200); assert.equal((await duplicate).status, 200); assert.equal(handled, 1);
    const restarted = await fixture(t, { seen, execute: () => { handled++; } });
    assert.equal((await restarted.post(20)).status, 200); assert.equal(handled, 1);
});

test('receipt storage failure, stopped admission and shutdown request redelivery', async t => {
    let handled = 0; const h = await fixture(t, { failReceipt: true, execute: () => { handled++; } });
    assert.equal((await h.post(30)).status, 503); assert.equal(handled, 0);
    h.guard.stop(); assert.equal((await h.post(31)).status, 503);
    h.runner.stop(); assert.equal((await h.post(32)).status, 503);
    assert.ok(!h.calls.some(x => x.method === 'deleteWebhook'));
});

test('a different Render service stays on standby without claiming the production token', async t => {
    const h = await fixture(t, { renderOrigin: 'https://old.onrender.com' });
    assert.equal(h.runner.mode, 'standby'); assert.equal(h.calls.length, 0);
    assert.equal((await h.post(40)).status, 503);
});
