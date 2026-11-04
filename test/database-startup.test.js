'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../all'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('database startup retries outages and index failures before enabling payments', async () => {
    let connects = 0; let indexes = 0; let protectedOrders = 0; let restoredGate;
    const timers = [];
    const context = {
        connectDB: async () => { if (++connects === 1) throw Error('database offline'); },
        Order: {
            createIndexes: async () => { if (++indexes === 1) throw Error('index creation interrupted'); },
            updateMany: async (filter, update) => {
                assert.equal(filter.paymentGateway, 'autogopay');
                assert.equal(update.$unset.expiresAt, ''); protectedOrders++;
            },
            find: () => ({ limit: () => ({ lean: async () => [{ orderId: 'held-1' }, { orderId: 'held-2' }] }) }),
        },
        Settings: { createIndexes: async () => {}, updateOne: async (filter, update) => { restoredGate = update.$set; } },
        console: { error() {} }, setTimeout: (fn, delay) => { timers.push({ fn, delay }); },
    };
    const start = source.indexOf('let agpReady = false;');
    const end = source.indexOf('// Inisialisasi Express App', start);
    vm.runInNewContext(source.slice(start, end) + '\nglobalThis.done = databaseReady; globalThis.isReady = () => agpReady;', context);
    await flush();
    assert.equal(context.isReady(), false); assert.equal(timers[0].delay, 5000);
    timers.shift().fn(); await flush();
    assert.equal(context.isReady(), false); assert.equal(timers[0].delay, 10000);
    timers.shift().fn(); await context.done;
    assert.equal(context.isReady(), true); assert.equal(connects, 3); assert.equal(indexes, 2);
    assert.equal(protectedOrders, 1); assert.equal(restoredGate.autogopayActiveOrder, 'held-1');
    assert.equal(restoredGate.autogopayCircuitOpen, true); assert.equal(timers.length, 0);
});

test('connectDB bounds connection attempts and propagates failures for controlled retry', async () => {
    const db = fs.readFileSync(require.resolve('../db'), 'utf8');
    let supplied;
    const context = {
        mongoose: { connect: async (uri, options) => { supplied = options; throw Error('offline'); } },
        process: { env: { MONGO_URI: 'mongodb://test' }, exit: () => { throw Error('must not exit'); } },
        console: { log() {} },
    };
    const start = db.indexOf('const connectDB =');
    const end = db.indexOf('// Skema untuk Variant', start);
    vm.runInNewContext(db.slice(start, end) + '\nglobalThis.connect = connectDB;', context);
    await assert.rejects(context.connect(), /offline/);
    assert.equal(supplied.serverSelectionTimeoutMS, 15000);
    assert.equal(supplied.connectTimeoutMS, 10000);
});
