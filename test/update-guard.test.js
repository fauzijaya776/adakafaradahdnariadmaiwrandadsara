'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createGuard = require('../update_guard');
const flush = () => new Promise(resolve => setImmediate(resolve));
const ctx = (id, owner = false) => ({ from: { id }, owner });

test('a 1000-user flood has at most 8 active handlers and 24 queued updates, with owner capacity reserved', async () => {
    let active = 0; let peak = 0; const releases = [];
    const guard = createGuard({ isOwner: c => c.owner, onError: e => { throw e; } });
    function work() { active++; peak = Math.max(peak, active); return new Promise(resolve => releases.push(() => { active--; resolve(); })); }
    for (let i = 1; i <= 1000; i++) guard.dispatch(ctx(i), work);
    await flush();
    assert.equal(peak, 8); assert.deepEqual(guard.stats(), { active: 8, queued: 24, dropped: 968 });
    guard.dispatch(ctx(1001, true), work); guard.dispatch(ctx(1002, true), work); await flush();
    assert.equal(active, 10); assert.equal(guard.stats().queued, 24);
    guard.stop(); assert.equal(guard.stats().queued, 0);
    for (const release of releases) release(); await flush();
    assert.equal(guard.stats().active, 0);
});

test('updates from one user are serialized and cannot occupy all worker slots', async () => {
    const events = []; let release;
    const guard = createGuard({ isOwner: () => false, onError: e => { throw e; } });
    guard.dispatch(ctx(1), () => { events.push('first'); return new Promise(resolve => { release = resolve; }); });
    guard.dispatch(ctx(1), () => events.push('second'));
    guard.dispatch(ctx(1), () => events.push('flood'));
    guard.dispatch(ctx(2), () => events.push('other'));
    await flush(); assert.deepEqual(events, ['first', 'other']);
    assert.equal(guard.stats().dropped, 1);
    release(); await flush();
    assert.deepEqual(events, ['first', 'other', 'second']);
    assert.equal(guard.stats().active, 0); assert.equal(guard.stats().queued, 0);
    guard.dispatch(ctx(1), () => events.push('later')); await flush();
    assert.equal(events.at(-1), 'later');
});

test('failed handlers release capacity and preserve the error handler', async () => {
    const errors = []; let completed = false;
    const guard = createGuard({ isOwner: () => false, onError: async e => { errors.push(e.message); } });
    guard.dispatch(ctx(1), () => { throw new Error('database offline'); });
    guard.dispatch(ctx(1), () => { completed = true; });
    await flush(); assert.deepEqual(errors, ['database offline']); assert.equal(completed, true);
    assert.deepEqual(guard.stats(), { active: 0, queued: 0, dropped: 0 });
});

test('shutdown discards queued work and does not start another checkout', async () => {
    let release; let started = 0;
    const guard = createGuard({ isOwner: () => false, onError: () => {} });
    guard.dispatch(ctx(1), () => { started++; return new Promise(resolve => { release = resolve; }); });
    guard.dispatch(ctx(1), () => { started++; }); await flush();
    guard.stop(); guard.dispatch(ctx(2), () => { started++; }); release(); await flush();
    assert.equal(started, 1); assert.deepEqual(guard.stats(), { active: 0, queued: 0, dropped: 0 });
});
