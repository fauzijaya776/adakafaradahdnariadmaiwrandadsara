'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, lookup, parse, target } = require('../quick_stock');
const token = n => 'dop_v1_' + n.toString(16).padStart(64, '0');
const line = (n, email = 'buyer' + n + '@example.invalid') => [token(n), email, 'fake-pass', 'fake-otp'].join('|');

function harness() {
    const initial = { products: [{ _id: 'p', name: 'DigitalOcean', variants: [
        { _id: 'v3', name: '3 Droplet', stock: [], reserved_stock: [] },
        { _id: 'v10', name: '10 Droplet', stock: [], reserved_stock: [] },
    ] }], routes: {}, receipts: {} };
    let state = initial, chain = Promise.resolve(), failAt = '', writes = 0;
    const limits = new Map();
    const query = fn => ({ session() { return this; }, lean: async () => fn() });
    const service = createService({
        mongoose: { connection: {
            transaction(work) {
                const task = chain.then(async () => {
                    const before = structuredClone(state);
                    try { return await work({}); } catch (err) { state = before; throw err; }
                });
                chain = task.catch(() => {}); return task;
            },
            collection: () => ({
                findOne: async ({ _id }) => state.receipts[_id],
                insertOne: async doc => { state.receipts[doc._id] = doc; },
            }),
        } },
        Settings: {
            findOne: () => query(() => ({ quickStockRoutes: state.routes })),
            findOneAndUpdate: () => query(() => ({ quickStockRoutes: state.routes })),
            updateOne: async (_, u) => { for (const [k,v] of Object.entries(u.$set)) state.routes[k.split('.')[1]] = v; },
        },
        Product: {
            find: () => query(() => state.products),
            aggregate: pipeline => ({ session: async () => {
                const regex = pipeline[0].$match.$or[0]['variants.stock'];
                return state.products.flatMap(p => p.variants.flatMap(v => v.stock.concat(v.reserved_stock)))
                    .filter(x => regex.test(x)).map(hits => ({ hits }));
            } }),
            updateOne: async (f, u) => {
                const variant = state.products.find(p => p._id === f._id)?.variants.find(v => v._id === f['variants._id']);
                if (failAt === variant?._id) throw Error('interrupted');
                if (!variant) return { modifiedCount: 0 };
                variant.stock.push(u.$push['variants.$.stock']); writes++; return { modifiedCount: 1 };
            },
        },
        inspect: async row => ({ limit: limits.get(row.token) ?? 3 }),
    });
    return { service, limits, get state() { return state; }, set failAt(v) { failAt = v; }, get writes() { return writes; } };
}

test('account lookup sends only token to the fixed endpoint and uses the actual account limit', async () => {
    const row = parse(line(1));
    const account = { status: 'active', email: row.email.toUpperCase(), droplet_limit: 10 };
    const get = async (url, opts) => {
        assert.equal(url, 'https://api.digitalocean.com/v2/account');
        assert.equal(opts.headers.Authorization, 'Bearer ' + row.token); assert.equal(opts.maxRedirects, 0);
        assert.ok(!JSON.stringify(opts).includes('fake-pass'));
        return { status: 200, data: { account } };
    };
    assert.deepEqual(await lookup(row, get), { limit: 10 });
    account.email = 'other@example.invalid'; assert.ok((await lookup(row, get)).error);
    account.email = row.email; account.status = 'locked'; assert.ok((await lookup(row, get)).error);
    for (const status of [401,403,429,500]) assert.ok((await lookup(row, async () => ({ status }))).error);
});

test('preview splits mixed limits without writing, skips invalid, duplicate, held and unmapped lines', async () => {
    const h = harness();
    h.state.products[0].variants[1].reserved_stock = [line(11, 'held@example.invalid')];
    h.limits.set(token(2), 10); h.limits.set(token(3), 5);
    const rows = await h.service.preview([line(1),line(2),line(3),line(1),line(12,'HELD@example.invalid'),'bad'].join('\n'));
    assert.equal(rows[0].target.id, 'v3'); assert.equal(rows[1].target.id, 'v10');
    assert.match(rows[2].error,/5/); assert.equal(rows[3].error,'Duplikat'); assert.equal(rows[4].error,'Duplikat'); assert.ok(rows[5].error);
    assert.equal(h.writes, 0);
    const r = await h.service.save('batch',rows);
    assert.equal(r.added, 2); assert.deepEqual(h.state.products[0].variants.map(v=>v.stock.length),[1,1]);
});

test('ambiguous names require an explicit mapping and stale mappings cannot silently redirect', async () => {
    const h = harness(); const variant = h.state.products[0].variants[0];
    h.state.products[0].variants.push({ ...variant, _id:'other', name:'3 Drop' });
    assert.ok((await h.service.preview(line(1)))[0].error);
    await h.service.map(3,'other'); const rows = await h.service.preview(line(1));
    assert.equal(rows[0].target.id,'other');
    await assert.rejects(h.service.map(10,'other'),/limit lain/);
    await h.service.map(3,'v3');
    assert.equal((await h.service.save('changed',rows)).added,0);
    h.state.products[0].variants.shift();
    assert.ok((await h.service.preview(line(1)))[0].error);
    assert.equal(target(10,[{id:'x',label:'DO 3 / 10 Droplet / Biasa',variantName:'Biasa'}],{}),undefined);
});

test('concurrent saves, repeats after sale, and stock newly held cannot duplicate an accepted account', async () => {
    const h = harness();
    const rows = await h.service.preview(line(1));
    const saved = await Promise.all([h.service.save('a',rows),h.service.save('b',rows)]);
    assert.equal(saved.reduce((sum,r)=>sum+r.added,0),1);
    h.state.products[0].variants[0].stock = []; // Original account sold after first commit.
    assert.equal((await h.service.save('a',rows)).added,1);
    assert.equal(h.state.products[0].variants[0].stock.length,0);
    const held = await h.service.preview(line(3));
    h.state.products[0].variants[1].reserved_stock.push(line(15,'buyer3@example.invalid'));
    assert.equal((await h.service.save('c',held)).added,0);
});

test('changed limit is skipped; failure halfway rolls back stock and the receipt', async () => {
    const h = harness();
    const single = await h.service.preview(line(1)); h.limits.set(token(1),10);
    assert.equal((await h.service.save('different',single)).added,0);
    const rows = await h.service.preview([line(2),line(1)].join('\n'));
    h.failAt = 'v10'; await assert.rejects(h.service.save('retry',rows),/interrupted/);
    assert.deepEqual(h.state.products[0].variants.map(v=>v.stock.length),[0,0]);
    assert.equal(h.state.receipts.retry,undefined);
    h.failAt = ''; assert.equal((await h.service.save('retry',rows)).added,2);
});
