'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../all'), 'utf8');

test('Telegram startup does not wait on an unresolved database initialization', () => {
    let launched = false;
    const context = { databaseReady: new Promise(() => {}), botRunner: { start: () => { launched = true; return Promise.resolve(); } }, console };
    const start = source.indexOf('// Jalankan Telegram Bot');
    vm.runInNewContext(source.slice(start, source.indexOf('// Pembersihan storage:', start)), context);
    assert.equal(launched, true);
});

test('database outage gives a recovery response before any user/database handler executes', async () => {
    let handler; let passed = 0; let replies = 0; let callbacks = 0;
    const context = { agpReady: false, mongoose: { connection: { readyState: 0 } }, bot: { use: fn => { handler = fn; } } };
    const start = source.indexOf('bot.use(async (ctx, next) => {');
    vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), context);
    await handler({ message: {}, chat: { type: 'private' }, reply: async text => { assert.match(text, /jangan membuat pembayaran ulang/); replies++; } }, () => { passed++; });
    await handler({ callbackQuery: {}, answerCbQuery: async () => { callbacks++; } }, () => { passed++; });
    assert.equal(replies, 1); assert.equal(callbacks, 1); assert.equal(passed, 0);
    context.agpReady = true; context.mongoose.connection.readyState = 1;
    await handler({}, () => { passed++; }); assert.equal(passed, 1);
});

test('only owners can request diagnostic data, including during a database outage', async () => {
    let handler; const replies = [];
    const context = {
        bot: { command: (name, fn) => { assert.equal(name, 'botstatus'); handler = fn; } },
        ownerIdList: () => ['1'], updateGuard: { stats: () => ({ active: 1, queued: 0, dropped: 5 }) },
        botRunner: { isHealthy: () => false, lastFailure: () => ({ code: '409', at: 1000 }) },
        agpReady: false, mongoose: { connection: { readyState: 0 } },
        process: { env: { RENDER_GIT_COMMIT: 'abcdef0123456' }, memoryUsage: () => ({ rss: 104857600 }), uptime: () => 42 },
    };
    const start = source.indexOf("bot.command('botstatus'");
    vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), context);
    await handler({ from: { id: 2 }, reply: async text => replies.push(text) }); assert.equal(replies.length, 0);
    await handler({ from: { id: 1 }, reply: async text => replies.push(text) });
    assert.match(replies[0], /abcdef0/); assert.match(replies[0], /409/); assert.match(replies[0], /belum terhubung/);
    assert.match(replies[0], /100 MB/); assert.match(replies[0], /restart: 5/);
});

test('public product menus request stock counts instead of full credential arrays', async () => {
    const pipelines = [];
    const product = { id: 'p', name: 'Demo', description: '-', variants: [{ name: 'v', slug: 'v', price: 1000, stockCount: 3 }] };
    const button = (...args) => args;
    const context = {
        Product: { countDocuments: async () => 1, aggregate: async p => { pipelines.push(p); return [product]; } },
        escapeMd: text => text, PO_WA_URL: 'https://example.com',
        Markup: { button: { callback: button, url: button }, inlineKeyboard: rows => rows }, console,
    };
    const start = source.indexOf('const PRODUCT_MENU_FIELDS =');
    const end = source.indexOf('async function generateQuantityMessageAndKeyboard', start);
    vm.runInNewContext(source.slice(start, end), context);
    const list = await context.generateProductListMessageAndKeyboard(1);
    const stock = await context.generateStockMessageAndKeyboard();
    const details = await context.generateProductDetailsMessageAndKeyboard('p', 1);
    assert.match(list.message, /x3/); assert.match(stock.message, /x3/); assert.match(details.message, /Stok: 3/);
    assert.equal(pipelines.length, 3);
    for (const pipeline of pipelines) {
        const fields = pipeline.find(stage => stage.$project).$project;
        const variant = fields.variants.$map.in;
        assert.equal(variant.stock, undefined); assert.equal(variant.reserved_stock, undefined);
        assert.equal(variant.stockCount.$size.$ifNull[0], '$$v.stock');
    }
});
