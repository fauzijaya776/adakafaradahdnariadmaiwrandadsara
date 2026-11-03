'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../bot_runner'), 'utf8');
const appSource = fs.readFileSync(require.resolve('../all'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(api = async () => []) {
    let now = 1000;
    let poll;
    let launches = 0;
    const timers = new Map();
    const logs = [];
    const methods = [];
    const bot = {
        telegram: { callApi: async (method, ...args) => { methods.push(method); return api(method, ...args); } },
        async launch(config, onLaunch) {
            launches++;
            await this.telegram.callApi('getMe');
            onLaunch();
            await this.telegram.callApi('deleteWebhook');
            return new Promise((resolve, reject) => { poll = { resolve, reject }; });
        },
        stop() {
            if (!poll) throw new Error('Bot is not running!');
            poll.resolve();
        },
    };
    const context = {
        module: { exports: {} }, Date: { now: () => now },
        setTimeout: (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; },
        clearTimeout: id => timers.delete(id),
        console: Object.fromEntries(['log', 'warn', 'error'].map(name => [name, (...args) => logs.push(args.join(' '))])),
    };
    vm.runInNewContext(source, context);
    const runner = context.module.exports(bot);
    return {
        bot, runner, timers, logs, methods,
        get launches() { return launches; },
        get delay() { return [...timers.values()][0]?.delay; },
        advance(ms) { now += ms; },
        fail(error = new Error('polling stopped')) { poll.reject(error); },
        end() { poll.resolve(); },
        async retry() {
            const [id, timer] = [...timers.entries()][0];
            timers.delete(id); now += timer.delay; timer.callback(); await flush();
        },
    };
}

test('fatal polling error retries once after delay; start does not create duplicate loops', async () => {
    const h = harness();
    assert.equal(h.runner.isHealthy(), false);
    const task = h.runner.start();
    assert.equal(h.runner.start(), task);
    await flush(); assert.equal(h.runner.isHealthy(), true);
    h.fail({ code: 409 }); await flush();
    assert.equal(h.runner.isHealthy(), false);
    assert.equal(h.launches, 1); assert.equal(h.delay, 5000);
    assert.ok(h.logs.some(line => line.includes('409 Conflict')));
    await h.retry();
    assert.equal(h.launches, 2); assert.equal(h.runner.isHealthy(), true);
    h.runner.stop('test'); await task;
    assert.equal(h.runner.isHealthy(), false); assert.equal(h.timers.size, 0);
});

test('startup errors back off to 60s; successful polling resets the delay', async () => {
    let offline = true;
    const h = harness(async method => {
        if (offline && method === 'getMe') throw new Error('offline');
        return [];
    });
    const task = h.runner.start(); await flush();
    for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
        assert.equal(h.delay, delay); assert.equal(h.runner.isHealthy(), false);
        await h.retry();
    }
    offline = false; await h.retry();
    await h.bot.telegram.callApi('getUpdates', { timeout: 50 });
    h.fail(); await flush(); assert.equal(h.delay, 5000);
    h.runner.stop('test'); await task;
});

test('normal idle polling renews health; unrelated API success cannot hide stalled polling', async () => {
    const h = harness(); const task = h.runner.start(); await flush();
    h.advance(119999); assert.equal(h.runner.isHealthy(), true);
    h.advance(1); assert.equal(h.runner.isHealthy(), false);
    await h.bot.telegram.callApi('getMe'); assert.equal(h.runner.isHealthy(), false);
    await h.bot.telegram.callApi('getUpdates'); assert.equal(h.runner.isHealthy(), true);
    h.runner.stop('test'); await task;
});

test('unexpected clean polling exit is also recovered', async () => {
    const h = harness(); const task = h.runner.start(); await flush();
    h.end(); await flush(); assert.equal(h.delay, 5000);
    assert.equal(h.runner.isHealthy(), false);
    await h.retry(); assert.equal(h.launches, 2);
    h.runner.stop('test'); await task;
});

test('shutdown cancels pending retry and never starts another loop', async () => {
    const h = harness(); const task = h.runner.start(); await flush();
    h.fail(); await flush(); h.runner.stop('SIGTERM'); h.runner.stop('SIGINT'); await task;
    assert.equal(h.timers.size, 0); assert.equal(h.launches, 1);
    const stopped = harness(); stopped.runner.stop('SIGTERM'); await stopped.runner.start();
    assert.equal(stopped.launches, 0);
});

for (const pendingMethod of ['getMe', 'deleteWebhook']) {
    test(`shutdown during ${pendingMethod} prevents polling from starting afterward`, async () => {
        let release;
        const h = harness(method => method === pendingMethod ? new Promise(resolve => { release = resolve; }) : []);
        const task = h.runner.start(); await flush();
        h.runner.stop('SIGTERM'); release([]); await task;
        assert.equal(h.runner.isHealthy(), false); assert.equal(h.timers.size, 0);
        await assert.rejects(h.bot.telegram.callApi('getUpdates'), /stopping/);
        assert.ok(!h.methods.includes('getUpdates'));
    });
}

test('public health routes return 503 for stopped polling or disconnected DB and disable caching', () => {
    let handler;
    const context = {
        app: { get: (paths, fn) => { assert.equal(JSON.stringify(paths), '["/health","/ping"]'); handler = fn; } },
        mongoose: { connection: { readyState: 1 } }, botRunner: { isHealthy: () => true },
    };
    const start = appSource.indexOf("app.get(['/health', '/ping']");
    vm.runInNewContext(appSource.slice(start, appSource.indexOf('\n});', start) + 4), context);
    function request() {
        const result = {};
        handler({}, { set: (key, value) => { result[key] = value; }, status(code) {
            result.status = code; return { send: text => { result.text = text; } };
        } });
        return result;
    }
    assert.deepEqual(request(), { 'Cache-Control': 'no-store', status: 200, text: 'OK' });
    context.botRunner.isHealthy = () => false;
    assert.equal(request().status, 503);
    context.botRunner.isHealthy = () => true; context.mongoose.connection.readyState = 0;
    assert.equal(request().status, 503);
});

test('fatal exceptions stop polling and exit with failure instead of leaving a live HTTP shell', () => {
    let handler; let exitCode; let stopped; let exitTimer;
    const context = {
        process: { on: (_, fn) => { handler = fn; }, env: {}, exit: code => { exitCode = code; } },
        botRunner: { stop: reason => { stopped = reason; } }, console: { error() {} },
        setTimeout: (fn, delay) => { assert.equal(delay, 1000); exitTimer = fn; return { unref() {} }; },
    };
    const start = appSource.indexOf("process.on('uncaughtException'");
    vm.runInNewContext(appSource.slice(start, appSource.indexOf('\n});', start) + 4), context);
    handler(new Error('fatal')); assert.equal(stopped, 'uncaughtException');
    exitTimer(); assert.equal(exitCode, 1);
});

test('installed Telegraf recovers from 409 with a fresh poller and stops on SIGTERM', async t => {
    const { Telegraf, TelegramError } = require('telegraf');
    const createRunner = require('../bot_runner');
    const bot = new Telegraf('test-token');
    let polls = 0;
    let deletedWebhooks = 0;
    bot.telegram.callApi = async (method, payload, controller) => {
        if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
        if (method === 'deleteWebhook') { deletedWebhooks++; return true; }
        assert.equal(method, 'getUpdates');
        assert.notEqual(payload.drop_pending_updates, true);
        polls++;
        if (polls === 1) throw new TelegramError({ error_code: 409, description: 'Conflict' });
        return new Promise((resolve, reject) => {
            controller.signal.addEventListener('abort', () => {
                const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
            }, { once: true });
        });
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const runner = createRunner(bot);
    t.after(() => runner.stop('test cleanup'));
    const task = runner.start(); await flush();
    assert.equal(polls, 1); assert.equal(runner.isHealthy(), false);
    t.mock.timers.tick(5000); await flush();
    assert.equal(polls, 2); assert.equal(deletedWebhooks, 2);
    assert.equal(runner.isHealthy(), true);
    runner.stop('SIGTERM'); await task;
    t.mock.timers.tick(60000); await flush();
    assert.equal(polls, 2); assert.equal(runner.isHealthy(), false);
});
