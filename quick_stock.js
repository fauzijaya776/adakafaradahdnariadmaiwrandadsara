'use strict';
const axios = require('axios');
const { extractToken } = require('./docheck');
const MAX_BATCH = 20;
const TOKEN = /^dop_v1_?[a-f0-9]{64}$/i;

function parse(line) {
    const parts = line.split('|').map(s => s.trim());
    if (parts.length !== 4 || !TOKEN.test(parts[0]) || !/^[^\s|@]+@[^\s|@]+\.[^\s|@]+$/.test(parts[1]) || !parts[2] || !parts[3]) return null;
    return { token: parts[0], email: parts[1].toLowerCase(), line: parts.join('|') };
}

async function lookup(row, get = axios.get) {
    try {
        const res = await get('https://api.digitalocean.com/v2/account', {
            headers: { Authorization: 'Bearer ' + row.token }, timeout: 6000,
            maxRedirects: 0, validateStatus: () => true,
        });
        if ([401, 403].includes(res.status)) return { error: 'Token ditolak atau izin account:read kurang' };
        if (res.status !== 200) return { error: 'API belum tersedia; coba lagi nanti' };
        const a = res.data?.account;
        if (a?.status !== 'active') return { error: 'Status akun tidak aktif atau tidak terbaca' };
        if (!a.email || a.email.trim().toLowerCase() !== row.email) return { error: 'Email tidak cocok dengan akun token' };
        if (!Number.isSafeInteger(a.droplet_limit) || a.droplet_limit < 1) return { error: 'Limit tidak terbaca' };
        return { limit: a.droplet_limit };
    } catch { return { error: 'Pengecekan API gagal; coba lagi nanti' }; }
}

function catalog(products) {
    return products.flatMap(p => (p.variants || []).map(v => ({
        id: String(v._id), product: String(p._id), label: p.name + ' / ' + v.name,
        productName: p.name, variantName: v.name,
    })));
}
function target(limit, choices, routes) {
    if (routes[limit]) return choices.find(c => c.id === routes[limit]);
    // Infer only an unambiguous DO label, e.g. “DigitalOcean / 3 Droplet”.
    const matches = choices.filter(c => {
        if (Object.values(routes).includes(c.id) || /manual/i.test(c.label) || !/digital[\s_-]*ocean|\bdo\b/i.test(c.label)) return false;
        const unit = /\b(droplets?|drops?)\b/i;
        const specific = /^\d+$/.test(c.variantName) || (unit.test(c.variantName) && /\d/.test(c.variantName));
        const label = specific ? c.variantName : c.label;
        const numbers = label.match(/\d+/g) || [];
        return numbers.length > 0 && numbers.every(n => Number(n) === limit) &&
            (unit.test(label) || /^\d+$/.test(label));
    });
    return matches.length === 1 ? matches[0] : undefined;
}
async function workers(rows, fn) {
    let pos = 0;
    await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
        while (pos < rows.length) { const row = rows[pos++]; await fn(row); }
    }));
}
function markDuplicates(rows, stock) {
    const tokens = new Set(), emails = new Set();
    for (const line of stock) {
        const token = extractToken(line);
        if (!token) continue;
        tokens.add(token);
        const email = line.split('|')[1]?.trim().toLowerCase();
        if (email) emails.add(email);
    }
    for (const row of rows) {
        if (row.error) continue;
        if (tokens.has(row.token) || emails.has(row.email)) row.error = 'Duplikat';
        else { tokens.add(row.token); emails.add(row.email); }
    }
}

function createService({ Product, Settings, mongoose, inspect = lookup }) {
    const settingsKey = { identifier: 'global-settings' };
    const choices = async (session = null) => catalog(await Product.find({}, 'name variants._id variants.name').session(session).lean());
    async function inventory(rows, session = null) {
        const values = rows.filter(r => !r.error).flatMap(r => [r.token, r.email]);
        if (!values.length) return [];
        const pattern = values.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const re = new RegExp(pattern, 'i');
        const matches = await Product.aggregate([
            { $match: { $or: [{ 'variants.stock': re }, { 'variants.reserved_stock': re }] } },
            { $unwind: '$variants' },
            { $project: { hits: { $filter: { input: { $concatArrays: [
                { $ifNull: ['$variants.stock', []] }, { $ifNull: ['$variants.reserved_stock', []] },
            ] }, as: 'line', cond: { $regexMatch: { input: '$$line', regex: re } } } } } },
            { $unwind: '$hits' },
        ]).session(session);
        return matches.map(r => r.hits);
    }
    const lock = session => Settings.findOneAndUpdate(settingsKey, { $inc: { quickStockRevision: 1 } },
        { session, upsert: true, new: true }).lean();
    async function map(limit, id) {
        if (!Number.isSafeInteger(limit) || limit < 1) throw Error('Limit tidak valid.');
        await mongoose.connection.transaction(async session => {
            const settings = await lock(session);
            if (!(await choices(session)).some(v => v.id === id)) throw Error('Varian sudah berubah.');
            if (Object.entries(settings.quickStockRoutes || {}).some(([n, v]) => Number(n) !== limit && v === id)) throw Error('Varian sudah dipakai limit lain.');
            await Settings.updateOne(settingsKey, { $set: { ['quickStockRoutes.' + limit]: id } }, { session });
        });
    }
    async function preview(text) {
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (!lines.length || lines.length > MAX_BATCH) throw Error('Kirim 1–20 akun per batch.');
        const rows = lines.map((line, i) => ({ n: i + 1, ...(parse(line) || { error: 'Format tidak valid' }) }));
        const [stock, variants, settings] = await Promise.all([inventory(rows), choices(), Settings.findOne(settingsKey, 'quickStockRoutes').lean()]);
        markDuplicates(rows, stock);
        await workers(rows.filter(r => !r.error), async row => {
            Object.assign(row, await inspect(row));
            if (row.error) return;
            row.target = target(row.limit, variants, settings?.quickStockRoutes || {});
            if (!row.target) row.error = 'Belum ada satu varian yang cocok untuk limit ' + row.limit;
        });
        return rows;
    }
    async function save(batchId, previewRows) {
        const rows = previewRows.filter(r => !r.error).map(r => ({ ...r }));
        await workers(rows, async row => {
            const check = await inspect(row);
            if (check.error || check.limit !== row.limit) row.error = check.error || 'Limit berubah';
        });
        return mongoose.connection.transaction(async session => {
            const settings = await lock(session);
            const receipts = mongoose.connection.collection('quick_stock_saves');
            const previous = await receipts.findOne({ _id: batchId }, { session });
            if (previous) return previous.result;
            // Rebuild the list on each transaction retry, including after checkout conflicts.
            const candidates = rows.map(r => ({ ...r }));
            const variants = await choices(session);
            markDuplicates(candidates, await inventory(candidates, session));
            const result = { added: 0, skipped: [] };
            for (const row of candidates) {
                const dest = target(row.limit, variants, settings.quickStockRoutes || {});
                if (!row.error && dest?.id !== row.target.id) row.error = 'Tujuan berubah; buat pratinjau baru';
                if (row.error) { result.skipped.push('Baris ' + row.n + ': ' + row.error); continue; }
                const write = await Product.updateOne({ _id: dest.product, 'variants._id': dest.id },
                    { $push: { 'variants.$.stock': row.line } }, { session });
                if (write.modifiedCount !== 1) throw Error('Varian berubah.');
                result.added++;
            }
            await receipts.insertOne({ _id: batchId, result, createdAt: new Date() }, { session });
            return result;
        });
    }
    return { choices, map, preview, save };
}
module.exports = { createService, lookup, parse, target, markDuplicates };
