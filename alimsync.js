// alimsync.js — LAPIS CADANGAN untuk catatan "Dana Alim".
//
// Masalah sebelumnya: catatan Dana Alim HANYA diisi dari webhook Pakasir. Kalau webhook
// tidak sampai / ditolak oleh bot ini (URL webhook di dashboard Pakasir mengarah ke domain
// lain, bot sedang tidur / restart di Render, X-Secret tidak cocok, dll.), order Alim tidak
// pernah tercatat — padahal di dashboard Pakasir statusnya "completed". Pakasir API v2 juga
// TIDAK punya endpoint untuk mendaftar transaksi, jadi bot tidak bisa menanyakan
// "order apa saja yang sudah masuk".
//
// Solusinya: tarik daftar order Alim yang sudah LUNAS (bot Telegram ALIM-<idTelegram>-<waktu>
// dan website WEBALIM-XXXXXXXXXX), lalu SETIAP order dicek ulang ke Pakasir lewat txn_id
// sebelum dicatat. Hanya yang benar-benar `completed`, order_id-nya cocok, dan bukan sandbox
// yang masuk catatan. Nominal diambil dari Pakasir, jadi catatan tidak bisa digelembungkan.
//
// Sumber daftar (otomatis, tanpa Environment baru):
//   1. ALIM_MONGO_URI diisi -> baca langsung database Alim (koleksi `orders` & `web_orders`, read-only).
//   2. selain itu           -> feed website Alim https://alimcloud.id/api/alim/paid, ditandatangani
//                              HMAC dengan kunci turunan PAKASIR_API_KEY (sama di kedua sisi karena
//                              project Pakasir-nya sama). ALIM_FEED_URL=off untuk mematikan;
//                              ALIM_FEED_SECRET (opsional, isi sama di website Alim) untuk kunci terpisah.
// ALIM_SYNC_DAYS (opsional, default 3) = berapa hari ke belakang yang dicek tiap sinkron.
const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const pakasir = require('./qris_pakasir');
const { AlimSale, Settings } = require('./db');

const SYNC_DAYS = Math.max(1, parseInt(process.env.ALIM_SYNC_DAYS, 10) || 3);
const MAX_CHECKS_PER_RUN = 40;           // batas cek ke Pakasir per putaran (sisanya putaran berikut)
const WEB_COLLECTION = 'web_orders';
const BOT_COLLECTION = 'orders';
const WEB_PAID = ['PAID', 'NEEDS_ACTION']; // NEEDS_ACTION = dibayar telat tapi stok habis (uang tetap masuk)
const BOT_PAID = ['PAID'];
const PROJECTION = {
    orderId: 1, status: 1, amount: 1, paidAt: 1, createdAt: 1, paymentGateway: 1,
    pakasirTxnId: 1, txnId: 1, 'paymentDetails.txn_id': 1,
};

const FEED_URL = String(process.env.ALIM_FEED_URL || 'https://alimcloud.id/api/alim/paid').trim();

function feedKey() {
    const base = String(process.env.ALIM_FEED_SECRET || process.env.PAKASIR_API_KEY || '').trim();
    return base ? crypto.createHash('sha256').update('alim-feed|' + base).digest() : null;
}

// 'db' | 'feed' | null (nonaktif)
function source() {
    if (process.env.ALIM_MONGO_URI) return 'db';
    if (FEED_URL && FEED_URL.toLowerCase() !== 'off' && feedKey()) return 'feed';
    return null;
}
const SOURCE_LABEL = { db: 'database Alim', feed: 'website Alim (alimcloud.id)' };
const isEnabled = () => !!source();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- koneksi (read-only) ke database Alim ----------------
let alimConn = null;
let connecting = null;

async function alimDb() {
    if (!process.env.ALIM_MONGO_URI) return null;
    if (alimConn) return alimConn.db; // driver menyambung ulang sendiri bila putus
    if (!connecting) {
        const c = mongoose.createConnection(process.env.ALIM_MONGO_URI, {
            maxPoolSize: 3, serverSelectionTimeoutMS: 10000, socketTimeoutMS: 30000,
        });
        // Tanpa listener, event 'error' bisa menjatuhkan proses.
        c.on('error', (e) => console.error('[DANA ALIM SYNC] koneksi database Alim error:', e.message));
        connecting = c.asPromise()
            .then(() => { alimConn = c; console.log('[DANA ALIM SYNC] terhubung ke database Alim.'); return c; })
            .catch((e) => { c.close().catch(() => {}); throw e; })
            .finally(() => { connecting = null; });
    }
    const c = await connecting;
    return c.db;
}

// ---------------- feed website Alim (ditandatangani HMAC) ----------------
async function fetchFeed({ days = '', id = '' }) {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', feedKey()).update(`${ts}|${days}|${id}`).digest('hex');
    const params = {};
    if (days) params.days = days;
    if (id) params.id = id;
    let res;
    try {
        res = await axios.get(FEED_URL, { params, headers: { 'X-Alim-Ts': ts, 'X-Alim-Sig': sig }, timeout: 25000 });
    } catch (e) {
        const st = e.response ? e.response.status : null;
        const hint = st === 401 ? ' (kunci tidak cocok: PAKASIR_API_KEY di Render & Vercel website Alim harus sama, atau isi ALIM_FEED_SECRET yang sama di keduanya)' : '';
        throw new Error(`feed website Alim ${st ? 'HTTP ' + st : e.message}${hint}`);
    }
    const list = res.data && Array.isArray(res.data.orders) ? res.data.orders : null;
    if (!list) throw new Error('feed website Alim: format jawaban tidak dikenal');
    return list.map((o) => ({
        orderId: String(o.orderId), pakasirTxnId: o.txnId || null, status: o.status, amount: o.amount,
        paidAt: o.paidAt ? new Date(o.paidAt) : null, createdAt: o.createdAt ? new Date(o.createdAt) : null,
        paymentGateway: o.gateway || null,
    }));
}

// Daftar order Alim yang sudah lunas sejak `since` (sumber db / feed).
async function listPaidAlimOrders(since) {
    if (source() === 'feed') return fetchFeed({ days: String(SYNC_DAYS) });
    const db = await alimDb();
    const when = { $or: [{ paidAt: { $gte: since } }, { createdAt: { $gte: since } }] };
    const [web, tele] = await Promise.all([
        db.collection(WEB_COLLECTION)
            .find({ orderId: { $regex: '^WEBALIM-' }, status: { $in: WEB_PAID }, ...when })
            .project(PROJECTION).sort({ createdAt: -1 }).limit(1000).toArray(),
        db.collection(BOT_COLLECTION)
            .find({ orderId: { $regex: '^ALIM-' }, status: { $in: BOT_PAID }, ...when })
            .project(PROJECTION).sort({ createdAt: -1 }).limit(1000).toArray(),
    ]);
    return web.concat(tele);
}

// Satu order Alim (status apa pun) atau null.
async function findAlimOrder(id) {
    if (source() === 'feed') return (await fetchFeed({ id }))[0] || null;
    const db = await alimDb();
    const coll = sourceOf(id) === 'web' ? WEB_COLLECTION : BOT_COLLECTION;
    return db.collection(coll).findOne({ orderId: id }, { projection: PROJECTION });
}

function txnOf(doc) {
    return doc.pakasirTxnId || doc.txnId || (doc.paymentDetails && doc.paymentDetails.txn_id) || null;
}

function sourceOf(orderId) {
    return /^WEBALIM-/.test(String(orderId || '')) ? 'web' : 'tele';
}

// ---------------- simpan catatan (dipakai webhook & sinkron) ----------------
// Idempoten: orderId unik, jadi webhook yang dikirim ulang / sinkron berulang tidak menghitung dobel.
async function upsertAlimSale({ orderId, txnId, amount, completedAt, via }) {
    let when = completedAt ? new Date(completedAt) : new Date();
    if (isNaN(when.getTime())) when = new Date();
    const doc = { amount, completedAt: when, settled: false, via };
    if (txnId) doc.txnId = String(txnId);
    try {
        const r = await AlimSale.updateOne({ orderId: String(orderId) }, { $setOnInsert: doc }, { upsert: true });
        return r.upsertedCount > 0
            ? { recorded: true, amount }
            : { recorded: false, reason: 'sudah tercatat sebelumnya' };
    } catch (e) {
        if (e && e.code === 11000) return { recorded: false, reason: 'sudah tercatat sebelumnya' };
        throw e;
    }
}

// Cek satu order ke Pakasir lalu catat bila benar-benar lunas.
// status: recorded | already | no_txn | check_failed | pending | rejected
async function verifyAndRecord(doc) {
    const orderId = String(doc.orderId);
    const txnId = txnOf(doc);
    if (!txnId) return { status: 'no_txn', reason: 'tidak ada txn_id Pakasir di database Alim' };

    const detail = await pakasir.checkPaymentStatus(txnId);
    if (!detail) return { status: 'check_failed', reason: 'gagal cek ke Pakasir (jaringan / rate limit)' };

    const st = String(detail.status || '').toLowerCase();
    if (detail.order_id && String(detail.order_id) !== orderId) {
        return { status: 'rejected', reason: `txn_id milik order lain (${detail.order_id})` };
    }
    if (detail.is_sandbox === true || String(detail.is_sandbox).toLowerCase() === 'true') {
        return { status: 'rejected', reason: 'transaksi sandbox' };
    }
    if (st !== 'completed') {
        return { status: st === 'pending' ? 'pending' : 'rejected', reason: `status ${st || '-'}` };
    }
    const amount = Number(detail.amount) > 0 ? Number(detail.amount) : (Number(doc.amount) || 0);
    if (amount <= 0) return { status: 'rejected', reason: 'nominal kosong' };

    const r = await upsertAlimSale({
        orderId, txnId, amount, via: 'sync',
        completedAt: detail.completed_at || doc.paidAt || doc.createdAt,
    });
    return r.recorded ? { status: 'recorded', amount } : { status: 'already', reason: r.reason };
}

// Jangan tanya Pakasir terus-menerus untuk order yang sama.
const retryAfter = new Map(); // orderId -> timestamp boleh dicek lagi
const RETRY_MS = { pending: 10 * 60 * 1000, rejected: 6 * 60 * 60 * 1000 };

// ---------------- sinkron berkala ----------------
let running = null;
let lastRun = null;
let lastNoTxnLog = ''; // log peringatan "tanpa txn_id" hanya saat daftarnya berubah

async function runSync() {
    if (!isEnabled()) return { enabled: false };

    const since = new Date(Date.now() - SYNC_DAYS * 24 * 60 * 60 * 1000);
    const candidates = (await listPaidAlimOrders(since))
        .filter((d) => /^(ALIM|WEBALIM)-/.test(String(d.orderId || '')));
    const ids = candidates.map((d) => String(d.orderId));
    const have = new Set(ids.length
        ? (await AlimSale.find({ orderId: { $in: ids } }, { orderId: 1 }).lean()).map((d) => d.orderId)
        : []);

    const summary = {
        enabled: true, days: SYNC_DAYS, source: source(),
        scanned: candidates.length, alreadyRecorded: have.size,
        recorded: 0, recordedAmount: 0, recordedIds: [],
        pending: 0, failed: 0, deferred: 0, noTxn: [], rejected: [],
    };

    const now = Date.now();
    const todo = candidates.filter((d) => !have.has(String(d.orderId)) && !((retryAfter.get(String(d.orderId)) || 0) > now));
    let checks = 0;
    for (const doc of todo) {
        const orderId = String(doc.orderId);
        if (!txnOf(doc)) {
            // Order non-Pakasir (mis. bayar saldo) memang tidak masuk akun Pakasir -> diam saja.
            if (!doc.paymentGateway || String(doc.paymentGateway).toLowerCase() === 'pakasir') summary.noTxn.push(orderId);
            continue;
        }
        if (checks >= MAX_CHECKS_PER_RUN) { summary.deferred += 1; continue; }
        checks += 1;
        if (checks > 1) await sleep(300); // jangan membanjiri API Pakasir

        let r;
        try {
            r = await verifyAndRecord(doc);
        } catch (e) {
            r = { status: 'check_failed', reason: e.message };
        }
        if (r.status === 'recorded') {
            summary.recorded += 1;
            summary.recordedAmount += r.amount;
            summary.recordedIds.push(orderId);
        } else if (r.status === 'pending') {
            summary.pending += 1;
            retryAfter.set(orderId, now + RETRY_MS.pending);
        } else if (r.status === 'rejected') {
            summary.rejected.push(`${orderId} (${r.reason})`);
            retryAfter.set(orderId, now + RETRY_MS.rejected);
        } else if (r.status === 'check_failed') {
            summary.failed += 1;
        }
    }
    // Buang entri retry yang sudah lewat supaya Map tidak terus membesar.
    for (const [k, t] of retryAfter) if (t <= now) retryAfter.delete(k);

    if (summary.recorded > 0) {
        console.log(`[DANA ALIM SYNC] ${summary.recorded} order baru dicatat (Rp ${summary.recordedAmount}): ${summary.recordedIds.join(', ')}`);
    }
    const noTxnKey = summary.noTxn.join(',');
    if (noTxnKey && noTxnKey !== lastNoTxnLog) {
        console.warn(`[DANA ALIM SYNC] ${summary.noTxn.length} order lunas tanpa txn_id Pakasir (tidak bisa diverifikasi): ${summary.noTxn.slice(0, 10).join(', ')}`);
    }
    lastNoTxnLog = noTxnKey;
    return summary;
}

// Satu proses sinkron dalam satu waktu; pemanggil yang datang bersamaan ikut menunggu hasilnya.
async function syncAlimSales() {
    if (!isEnabled()) return { enabled: false };
    if (!running) {
        running = runSync()
            .then((s) => { lastRun = { at: new Date(), ok: true, ...s }; return lastRun; })
            .catch((e) => {
                console.error('[DANA ALIM SYNC] gagal:', e.message);
                lastRun = { at: new Date(), ok: false, enabled: true, error: e.message };
                return lastRun;
            })
            .finally(() => { running = null; });
    }
    return running;
}

// Lacak satu ID langsung ke database Alim (dipakai fitur "Lacak ID pesanan"):
// bila ternyata sudah lunas di Pakasir tapi belum tercatat, langsung dicatat.
async function syncAlimOrder(rawId) {
    if (!isEnabled()) return { enabled: false };
    let id = String(rawId || '').trim().toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(id)) id = 'WEBALIM-' + id; // 10 karakter terakhir pesanan web
    if (!/^(WEBALIM|ALIM)-[A-Z0-9-]+$/.test(id)) return { enabled: true, found: false, orderId: id };
    try {
        const doc = await findAlimOrder(id);
        if (!doc) return { enabled: true, found: false, orderId: id };
        // Dicek ke Pakasir walau status di database Alim belum PAID (bisa jadi bayar telat).
        const r = await verifyAndRecord(doc);
        return { enabled: true, found: true, orderId: id, alimStatus: doc.status, ...r };
    } catch (e) {
        console.error('[DANA ALIM SYNC] lacak gagal:', e.message);
        return { enabled: true, found: false, orderId: id, error: e.message };
    }
}

// ---------------- pemantau webhook Pakasir (untuk diagnosa di halaman Dana Alim) ----------------
// Disimpan di Settings (tahan restart Render), maksimal 1 tulis/menit per jenis.
const lastNoteAt = { ok: 0, rejected: 0 };
function noteWebhook(kind) {
    const now = Date.now();
    if (now - lastNoteAt[kind] < 60 * 1000) return;
    lastNoteAt[kind] = now;
    const field = kind === 'ok' ? 'pakasir_webhook_ok_at' : 'pakasir_webhook_rejected_at';
    Settings.updateOne({ identifier: 'global-settings' }, { $set: { [field]: new Date(now) } }, { upsert: true })
        .catch((e) => console.error('[PAKASIR] gagal menyimpan waktu webhook:', e.message));
}

async function alimSyncStatus() {
    const st = await Settings.findOne({ identifier: 'global-settings' },
        { pakasir_webhook_ok_at: 1, pakasir_webhook_rejected_at: 1 }).lean().catch(() => null);
    const src = source();
    return {
        enabled: !!src,
        source: src,
        sourceLabel: src ? SOURCE_LABEL[src] : '',
        days: SYNC_DAYS,
        lastRun,
        webhookOkAt: st && st.pakasir_webhook_ok_at ? st.pakasir_webhook_ok_at : null,
        webhookRejectedAt: st && st.pakasir_webhook_rejected_at ? st.pakasir_webhook_rejected_at : null,
    };
}

module.exports = {
    isEnabled,
    syncAlimSales,
    syncAlimOrder,
    upsertAlimSale,
    noteWebhook,
    alimSyncStatus,
    SYNC_DAYS,
};
