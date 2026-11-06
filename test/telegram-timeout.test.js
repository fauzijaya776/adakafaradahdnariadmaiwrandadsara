'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../telegram_timeout'), 'utf8');
function load() {
    const timers = new Map();
    const context = { module: { exports: {} }, AbortController,
        setTimeout: (fn, delay) => { const id = {}; timers.set(id, { fn, delay }); return id; },
        clearTimeout: id => timers.delete(id) };
    vm.runInNewContext(source, context);
    return { protect: context.module.exports, timers };
}
for (const [method, timeout] of [['sendMessage', 20000], ['sendDocument', 60000], ['getChatMember', 20000]]) {
    test(`${method} aborts a hung request exactly once without retrying`, async () => {
        const h = load(); let calls = 0;
        const telegram = { callApi: async (name, payload, { signal }) => {
            calls++; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
        } };
        h.protect(telegram); h.protect(telegram);
        const rejected = assert.rejects(telegram.callApi(method, {}), /timeout/);
        assert.equal(h.timers.size, 1);
        const timer = [...h.timers.values()][0]; assert.equal(timer.delay, timeout); timer.fn();
        await rejected; assert.equal(calls, 1); assert.equal(h.timers.size, 0);
    });
}
test('successful sends and explicit errors are preserved; polling remains owned by the runner', async () => {
    const h = load(); let supplied;
    const telegram = { callApi: async (method, payload, options) => {
        supplied = options;
        if (method === 'sendMessage') return { message_id: 42 };
        if (method === 'sendDocument') throw Object.assign(Error('429'), { response: { error_code: 429 } });
        return [];
    } };
    h.protect(telegram);
    assert.equal((await telegram.callApi('sendMessage', {})).message_id, 42); assert.equal(h.timers.size, 0);
    await assert.rejects(telegram.callApi('sendDocument', {}), e => e.response.error_code === 429);
    assert.equal(h.timers.size, 0);
    const options = { signal: new AbortController().signal };
    await telegram.callApi('getUpdates', { timeout: 50 }, options);
    assert.equal(supplied, options); assert.equal(h.timers.size, 0);
});
test('caller cancellation reaches the underlying request and clears the deadline', async () => {
    const h = load(); const upstream = new AbortController();
    const telegram = { callApi: (method, payload, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Error('caller cancelled')), { once: true });
    }) };
    h.protect(telegram);
    const rejected = assert.rejects(telegram.callApi('sendMessage', {}, { signal: upstream.signal }), /caller cancelled/);
    upstream.abort(); await rejected; assert.equal(h.timers.size, 0);
});
