// =================================================================
// CEK GMAIL LIVE sebelum QRIS dibuat — pakai QuickEmailVerification (QEV).
//
// Alur: pembeli menekan tombol bayar untuk varian Gmail -> bot menampilkan
// "Tunggu sebentar, sedang mengecek akun Gmail..." -> akun dari stok dicek satu
// per satu lewat API QEV -> akun MATI dikeluarkan dari stok (disimpan di daftar
// "stok mati" + dilaporkan ke owner) -> kalau akun live cukup, QRIS dibuat
// memakai akun yang sudah lolos cek. Kalau tidak cukup, pembeli diberi tahu
// SEBELUM membayar (tidak ada urusan refund).
//
// Hemat kuota (gratis 100 cek/hari):
//   * hasil cek disimpan (cache) beberapa jam -> akun yang dikembalikan ke stok
//     karena pembeli batal tidak dicek ulang;
//   * akun yang sudah pernah dicek & masih berlaku dipakai lebih dulu (0 kuota);
//   * batas cek per pembeli per jam (anti iseng) — pesanan besar tetap dicek penuh;
//   * akun MATI selalu dibuang dari stok + dilaporkan ke owner (semua OWNER_ID);
//   * kalau API tidak bisa dipakai (kuota habis / key ditolak / jaringan), penjualan
//     tetap jalan dengan akun yang belum terverifikasi (GMAILCHECK_STRICT=1 = tahan),
//     owner diberi peringatan dan notifikasi order diberi tanda ⚠️.
//
// Hanya baris stok yang DIAWALI alamat email yang dicek (mis. email|password|recovery,
// email:password, "Email: x@gmail.com | ..."). Baris akun DigitalOcean (dop_v1...) tidak
// pernah dicek, walaupun nama produknya memuat kata "gmail".
//
// Catatan: QEV mengecek lewat server mail (SMTP). Yang terdeteksi: akun tidak
// ada/dihapus & akun di-disable Google. Password diganti / minta verifikasi HP
// TIDAK terdeteksi.
//
// ENV:
//   QEV_API_KEY              API key QuickEmailVerification (WAJIB, tanpa ini fitur nonaktif).
//                            Bisa BANYAK key, pisahkan koma: QEV_API_KEY=key1,key2,key3
//                            Dipakai berurutan: key pertama dulu; kalau kuotanya habis / ditolak,
//                            otomatis pindah ke key berikutnya. Urutan = prioritas
//                            (taruh key berbayar paling belakang sebagai cadangan).
//   GMAILCHECK_MATCH         regex nama produk/varian yang dicek (default: gmail)
//   GMAILCHECK_CACHE_HOURS   lama hasil cek dianggap berlaku (default: 6)
//   GMAILCHECK_USER_HOURLY   maks. kuota yang boleh dipakai 1 pembeli per jam (default: 20)
//   GMAILCHECK_STRICT        "1" = tahan penjualan kalau akun tidak bisa diverifikasi
// =================================================================
const axios = require('axios');

const API_URL = 'https://api.quickemailverification.com/v1/verify';
const SANDBOX_URL = 'https://api.quickemailverification.com/v1/verify/sandbox';
// Alasan QEV yang berarti akun PASTI tidak bisa dipakai (mati / tidak ada / di-disable).
const DEAD_REASONS = new Set(['rejected_email', 'invalid_email', 'invalid_domain', 'no_mx_record']);
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;

const REQ_TIMEOUT_MS = 12000;     // batas 1 request ke QEV
const TOTAL_BUDGET_MS = 40000;    // batas total 1x pengecekan, supaya pembeli tidak menunggu lama
const MIN_REQ_MS = 2000;          // sisa waktu minimal untuk memulai request baru
const MAX_PARALLEL = 5;
const HARD_CAP_PER_ORDER = 60;    // maks. kuota 1x pengecekan (pesanan besar: jumlah pesanan + 10)
const SCAN_LIMIT = 5000;          // berapa baris stok yang dipindai hasil cek lamanya (cache, 0 kuota)
const CLAIM_MS = 90 * 1000;       // akun yang sudah dipilih untuk 1 pembeli tidak dipilih pembeli lain dulu
const UNVERIFIED_TTL_MS = 48 * 60 * 60 * 1000;
const ALERT_EVERY_MS = 3 * 60 * 60 * 1000;
const KEY_QUOTA_RETRY_MS = 60 * 60 * 1000;     // key yang kuotanya habis dicoba lagi tiap 1 jam (tidak memotong kredit)
const KEY_REJECTED_RETRY_MS = 6 * 60 * 60 * 1000; // key yang ditolak (salah/diblokir) dicoba lagi tiap 6 jam
const KEY_RATE_RETRY_MS = 60 * 1000;

function num(v, def) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : def;
}

// Email diambil HANYA dari kolom pertama baris pertama. Baris yang tidak diawali
// email (mis. akun DigitalOcean "dop_v1...|email|password") -> null = tidak dicek.
const EMAIL_FULL_RE = new RegExp('^' + EMAIL_RE.source + '$');
function extractEmail(item) {
    if (!item || typeof item !== 'string') return null;
    let first = item.split(/\r?\n/)[0].trim();
    if (!first || /dop_v1/i.test(first)) return null;
    first = first.replace(/^(e-?mail|gmail|akun|account|user(name)?|login)\s*[:=]\s*/i, '');
    const token = first.split(/[|:;,\t ]+/)[0].trim();
    return EMAIL_FULL_RE.test(token) ? token.toLowerCase() : null;
}

function escMd(s) {
    return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}

module.exports = function createGmailCheck(cfg) {
    const { Product, Settings, GmailCheck, GmailDead } = cfg;
    // Daftar API key (boleh lebih dari satu, dipisah koma/spasi/baris baru).
    const KEYS = [...new Set(String(process.env.QEV_API_KEY || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))]
        .map((key, i) => ({
            key,
            no: i + 1,
            mask: key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-2)}` : '****',
            remaining: null,   // dari header X-QEV-Remaining-Credits
            downUntil: 0,      // > sekarang = key sedang diistirahatkan
            downReason: '',
            used: 0,           // kredit terpakai sejak bot jalan
            lastUsedAt: null,
        }));
    const HAS_KEY = KEYS.length > 0;
    let MATCH;
    try { MATCH = new RegExp(process.env.GMAILCHECK_MATCH || 'gmail', 'i'); } catch (e) { MATCH = /gmail/i; }
    const CACHE_MS = num(process.env.GMAILCHECK_CACHE_HOURS, 6) * 60 * 60 * 1000;
    const USER_HOURLY = num(process.env.GMAILCHECK_USER_HOURLY, 20);
    const STRICT = String(process.env.GMAILCHECK_STRICT || '').trim() === '1';

    let bot = null;
    const state = {
        lastApiAt: null,
        usedSinceStart: 0,
        lastAlert: {},
    };
    const busyUsers = new Set();
    const userUsage = new Map();  // userId -> [timestamp kuota dipakai]
    const claimed = new Map();    // item -> { uid, exp } (sedang dipegang 1 pembeli)
    const unverifiedItems = new Map(); // item -> { reason, exp } (terjual tanpa lolos cek)

    // ---------- util owner ----------
    function ownerIds() {
        return (process.env.OWNER_ID || '').split(',').map((id) => id.trim()).filter(Boolean);
    }
    function isOwner(ctx) {
        return !!(ctx && ctx.from && ownerIds().includes(String(ctx.from.id)));
    }
    async function notifyOwner(text, key) {
        if (!bot) return;
        if (key) {
            const last = state.lastAlert[key] || 0;
            if (Date.now() - last < ALERT_EVERY_MS) return;
            state.lastAlert[key] = Date.now();
        }
        for (const id of ownerIds()) await bot.telegram.sendMessage(id, text).catch(() => {});
    }
    async function sendOwnerFile(buffer, filename, caption) {
        if (!bot) return;
        for (const id of ownerIds()) {
            await bot.telegram.sendDocument(id, { source: buffer, filename }, { caption }).catch(() => {});
        }
    }

    // ---------- pengaturan ----------
    async function getEnabledSetting() {
        try {
            const s = await Settings.findOne({ identifier: 'global-settings' }).lean();
            return s && typeof s.gmailcheck_enabled === 'boolean' ? s.gmailcheck_enabled : true;
        } catch (e) {
            return true;
        }
    }
    async function isActive() {
        if (!HAS_KEY) return false;
        return getEnabledSetting();
    }
    function isGmailVariant(product, variant) {
        const hay = `${product && product.name || ''} ${variant && variant.name || ''} ${variant && variant.slug || ''}`;
        return MATCH.test(hay);
    }

    // ---------- kuota per pembeli ----------
    // Batas per jam minimal cukup untuk mengecek pesanan yang sedang dibuat,
    // jadi pembeli banyak sekaligus tetap dicek penuh; yang dibatasi hanya
    // percobaan berulang (beli-batal-beli).
    function userCanSpend(uid, quantity) {
        const now = Date.now();
        const arr = (userUsage.get(uid) || []).filter((t) => now - t < 60 * 60 * 1000);
        if (arr.length) userUsage.set(uid, arr); else userUsage.delete(uid);
        // Cukup untuk mengecek 1 pesanan (jumlah + 10). Percobaan ulang (beli-batal-beli)
        // hampir tidak memakai kuota karena akun yang sudah dicek dipakai ulang dari cache.
        return arr.length < Math.max(USER_HOURLY, quantity + 10);
    }
    function userSpend(uid) {
        const arr = userUsage.get(uid) || [];
        arr.push(Date.now());
        userUsage.set(uid, arr);
    }
    // Kuota yang terpakai untuk menemukan akun MATI tidak dibebankan ke pembeli
    // (membersihkan stok mati = kepentingan toko, pembeli tidak boleh ikut terblokir).
    function userRefund(uid) {
        const arr = userUsage.get(uid);
        if (arr && arr.length) arr.pop();
        if (arr && !arr.length) userUsage.delete(uid);
    }

    function cleanupClaims() {
        const now = Date.now();
        for (const [item, c] of claimed) if (c.exp <= now) claimed.delete(item);
        for (const [item, u] of unverifiedItems) if (u.exp <= now) unverifiedItems.delete(item);
    }
    function claimedByOther(item, uid) {
        const c = claimed.get(item);
        return !!(c && c.exp > Date.now() && c.uid !== uid);
    }
    function claim(item, uid) {
        claimed.set(item, { uid, exp: Date.now() + CLAIM_MS });
    }
    // Lepas pegangan akun (dipanggil handler saat pembuatan invoice GAGAL).
    function release(items) {
        for (const it of items || []) claimed.delete(it);
    }
    // Berapa item order ini yang terkirim TANPA lolos cek (untuk tanda ⚠️ di notifikasi owner).
    function countUnverified(items) {
        cleanupClaims();
        let n = 0;
        for (const it of items || []) if (unverifiedItems.has(it)) n += 1;
        return n;
    }

    // ---------- multi API key ----------
    function activeKeys() {
        const now = Date.now();
        return KEYS.filter((k) => k.downUntil <= now);
    }
    function apiUnavailable() {
        return !HAS_KEY || activeKeys().length === 0;
    }
    function apiDownReason() {
        if (!HAS_KEY) return 'QEV_API_KEY belum diisi';
        const reasons = [...new Set(KEYS.map((k) => k.downReason).filter(Boolean))];
        return `semua API key tidak bisa dipakai (${reasons.join(', ') || 'sementara'})`;
    }
    function totalRemaining() {
        const known = KEYS.filter((k) => k.remaining != null);
        return known.length ? known.reduce((a, k) => a + k.remaining, 0) : null;
    }
    function keyLabel(k) {
        return `key #${k.no} (${k.mask})`;
    }
    function markKeyDown(k, ms, reason) {
        k.downUntil = Date.now() + ms;
        k.downReason = reason;
        if (apiUnavailable()) {
            notifyOwner(
                `⚠️ Cek Gmail: SEMUA API key QuickEmailVerification tidak bisa dipakai (${KEYS.length} key).\n` +
                KEYS.map((x) => `• ${keyLabel(x)}: ${x.downReason || 'aktif'}`).join('\n') + '\n\n' +
                (STRICT
                    ? 'Mode ketat aktif: penjualan Gmail DITAHAN sampai ada key yang bisa dipakai lagi.'
                    : 'Penjualan Gmail tetap jalan TANPA pengecekan sampai ada key yang bisa dipakai lagi.') +
                '\nKuota gratis reset harian; bisa juga tambah key / beli kredit di quickemailverification.com.',
                'alldown'
            ).catch(() => {});
        }
    }
    function updateRemaining(k, res) {
        const rem = res.headers && (res.headers['x-qev-remaining-credits'] ?? res.headers['X-QEV-Remaining-Credits']);
        if (rem !== undefined && rem !== null && rem !== '' && Number.isFinite(Number(rem))) k.remaining = Number(rem);
    }
    // Hasil request 200 -> { status: 'live' | 'dead' | 'unknown' } ; selain itu null.
    function parseOk(res) {
        const body = res.data && typeof res.data === 'object' ? res.data : {};
        if (res.status !== 200 || String(body.success) === 'false') return null;
        const result = String(body.result || '').toLowerCase();
        const reason = String(body.reason || '').toLowerCase();
        if (result === 'valid') return { status: 'live', reason: reason || 'accepted_email' };
        if (result === 'invalid' && DEAD_REASONS.has(reason)) return { status: 'dead', reason };
        return { status: 'unknown', reason: reason || result || 'unknown' };
    }

    // Tes 1 key lewat mode SANDBOX (gratis, tidak memotong kredit).
    async function testKey(k) {
        try {
            const res = await axios.get(SANDBOX_URL, {
                params: { email: 'valid@example.com', apikey: k.key },
                timeout: REQ_TIMEOUT_MS,
                validateStatus: () => true,
            });
            // (sisa kredit TIDAK diambil dari mode sandbox — angkanya belum tentu kredit asli)
            const ok = parseOk(res);
            if (ok && ok.status === 'live') {
                if (k.downReason === 'ditolak') { k.downUntil = 0; k.downReason = ''; }
                return { ok: true };
            }
            const body = res.data && typeof res.data === 'object' ? res.data : {};
            return { ok: false, reason: `${res.status} ${body.message || ''}`.trim() };
        } catch (e) {
            return { ok: false, reason: e.code || e.message || 'network error' };
        }
    }

    // ---------- panggil API (otomatis pindah key) ----------
    // Hasil: { status: 'live' | 'dead' | 'unknown' | 'error', reason }
    async function callApi(email, { timeoutMs = REQ_TIMEOUT_MS } = {}) {
        if (!HAS_KEY) return { status: 'error', reason: 'QEV_API_KEY belum diisi' };
        const started = Date.now();
        const tried = new Set();
        for (;;) {
            const now = Date.now();
            const k = KEYS.find((x) => x.downUntil <= now && !tried.has(x.no));
            if (!k) return { status: 'error', reason: apiDownReason() };
            tried.add(k.no);
            const left = timeoutMs - (Date.now() - started);
            if (left < 1000) return { status: 'error', reason: 'waktu cek habis (API lambat)' };
            let res;
            try {
                res = await axios.get(API_URL, {
                    params: { email, apikey: k.key },
                    timeout: Math.max(1000, Math.min(REQ_TIMEOUT_MS, left)),
                    validateStatus: () => true,
                });
            } catch (e) {
                // gangguan jaringan -> tidak ganti key (kemungkinan semua key kena)
                return { status: 'error', reason: e.code || e.message || 'network error' };
            }
            updateRemaining(k, res);
            const ok = parseOk(res);
            if (ok) {
                // hanya request yang berhasil yang memotong kredit
                k.used += 1;
                k.lastUsedAt = new Date();
                state.usedSinceStart += 1;
                state.lastApiAt = k.lastUsedAt;
                if (k.remaining === 0) markKeyDown(k, KEY_QUOTA_RETRY_MS, 'kuota habis');
                return ok;
            }
            const body = res.data && typeof res.data === 'object' ? res.data : {};
            const msg = String(body.message || `HTTP ${res.status}`);
            if (res.status === 402 || /credit/i.test(msg)) {
                k.remaining = 0;
                const next = KEYS.find((x) => x.no !== k.no && x.downUntil <= Date.now());
                markKeyDown(k, KEY_QUOTA_RETRY_MS, 'kuota habis');
                if (next) {
                    notifyOwner(`ℹ️ Cek Gmail: kuota ${keyLabel(k)} habis, otomatis pindah ke ${keyLabel(next)}.`, `switch:${k.no}`).catch(() => {});
                }
                continue;
            }
            if (res.status === 401 || res.status === 403) {
                markKeyDown(k, KEY_REJECTED_RETRY_MS, 'ditolak');
                notifyOwner(`⚠️ Cek Gmail: ${keyLabel(k)} DITOLAK QuickEmailVerification (${res.status} ${msg}).\n` +
                    'Periksa key tersebut di QEV_API_KEY (.env / Render). Key lain tetap dipakai.', `rej:${k.no}`).catch(() => {});
                continue;
            }
            if (res.status === 429) {
                markKeyDown(k, KEY_RATE_RETRY_MS, 'rate limit');
                continue;
            }
            return { status: 'error', reason: `${res.status} ${msg}` };
        }
    }

    // Cek 1 item stok. spend() dipanggil sebelum memakai kuota -> false = jatah habis.
    async function checkItem(item, cache, spend, deadline) {
        const email = extractEmail(item);
        if (!email) return { item, email: null, status: 'noemail', reason: 'tidak ada email di baris stok' };
        const c = cache.get(email);
        if (c && c.checkedAt && Date.now() - new Date(c.checkedAt).getTime() < CACHE_MS && (c.status === 'live' || c.status === 'dead')) {
            return { item, email, status: c.status, reason: c.reason, cached: true };
        }
        if (apiUnavailable()) return { item, email, status: 'error', reason: apiDownReason() };
        const left = deadline - Date.now();
        if (left < MIN_REQ_MS) return { item, email, status: 'error', reason: 'waktu cek habis (API lambat)' };
        if (!spend()) return { item, email, status: 'skipped', reason: 'jatah cek habis' };
        const r = await callApi(email, { timeoutMs: left });
        r.spent = true;
        if (r.status === 'live' || r.status === 'dead') {
            const now = new Date();
            await GmailCheck.updateOne(
                { email },
                { $set: { status: r.status, reason: r.reason, checkedAt: now, expireAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) } },
                { upsert: true }
            ).catch((e) => console.error('[GMAILCHECK] gagal simpan cache:', e.message));
        }
        return { item, email, status: r.status, reason: r.reason, spent: true };
    }

    // Pilih akun live dari stok sampai cukup.
    //   Tahap 1: pakai akun yang hasil cek lamanya masih berlaku (0 kuota), dan
    //            buang akun yang sudah diketahui mati.
    //   Tahap 2: cek akun baru dari depan stok lewat API.
    // Hasil: live (lolos cek), fillable (tidak bisa dicek krn API bermasalah/tanpa email),
    //        skipped (tidak dicek krn jatah habis -> TIDAK dijual), dead (dibuang).
    async function selectLive(stock, quantity, uid) {
        cleanupClaims();
        const live = [];
        const fillable = [];
        const passthrough = [];
        const skipped = [];
        const dead = [];
        const mine = new Set();
        const done = new Set(); // index stok yang sudah diklasifikasi
        let apiCalls = 0;
        let budgetOut = false;
        // Kuota per pesanan: jumlah pesanan + 5, ditambah 1 untuk setiap akun mati yang
        // ditemukan (kuota untuk membersihkan stok mati tidak dianggap boros).
        const spend = () => {
            const cap = Math.min(quantity + 5 + dead.length, Math.max(HARD_CAP_PER_ORDER, quantity + 10));
            if (apiCalls >= cap || !userCanSpend(uid, quantity)) { budgetOut = true; return false; }
            apiCalls += 1;
            userSpend(uid);
            return true;
        };
        const deadline = Date.now() + TOTAL_BUDGET_MS;
        const take = (k, it) => { done.add(k); mine.add(it); claim(it, uid); };

        // ---- Tahap 1: hasil cek lama (cache) ----
        const scanN = Math.min(stock.length, SCAN_LIMIT);
        const scanEmails = new Set();
        for (let k = 0; k < scanN; k++) {
            const em = extractEmail(stock[k]);
            if (em) scanEmails.add(em);
        }
        if (scanEmails.size) {
            const docs = await GmailCheck.find({
                email: { $in: [...scanEmails] },
                checkedAt: { $gte: new Date(Date.now() - CACHE_MS) },
            }).lean().catch(() => []);
            const cacheAll = new Map((docs || []).map((doc) => [doc.email, doc]));
            for (let k = 0; k < scanN; k++) {
                const it = stock[k];
                if (mine.has(it) || claimedByOther(it, uid)) continue;
                const c = cacheAll.get(extractEmail(it));
                if (!c) continue;
                if (c.status === 'dead') {
                    take(k, it);
                    dead.push({ item: it, email: c.email, status: 'dead', reason: c.reason, cached: true });
                } else if (c.status === 'live' && live.length < quantity) {
                    take(k, it);
                    live.push({ item: it, email: c.email, status: 'live', reason: c.reason, cached: true });
                }
            }
        }

        // ---- Tahap 2: cek akun baru lewat API ----
        let i = 0;
        while (i < stock.length && live.length + passthrough.length < quantity && Date.now() < deadline) {
            const apiDown = apiUnavailable();
            if (budgetOut) break; // jatah habis: sisa akun tidak dicek -> tidak dijual
            if (apiDown && live.length + passthrough.length + fillable.length >= quantity) break;
            const need = quantity - live.length - passthrough.length;
            const size = Math.min(Math.max(need, 1), MAX_PARALLEL);
            const batch = [];
            while (i < stock.length && batch.length < size) {
                const k = i++;
                const it = stock[k];
                if (done.has(k) || mine.has(it) || claimedByOther(it, uid)) continue;
                take(k, it);
                batch.push(it);
            }
            if (!batch.length) break;
            const emails = batch.map(extractEmail).filter(Boolean);
            const cache = new Map();
            if (emails.length) {
                const docs = await GmailCheck.find({ email: { $in: emails } }).lean().catch(() => []);
                for (const doc of docs || []) cache.set(doc.email, doc);
            }
            const results = await Promise.all(batch.map((it) => checkItem(it, cache, spend, deadline)
                .catch((err) => ({ item: it, status: 'error', reason: err.message }))));
            for (const r of results) {
                if (r.status === 'live') live.push(r);
                else if (r.status === 'dead') { dead.push(r); if (r.spent) userRefund(uid); }
                else if (r.status === 'skipped') skipped.push(r);
                else if (r.status === 'noemail') passthrough.push(r); // baris tanpa email: tidak dicek, dijual biasa
                else { fillable.push(r); if (r.status === 'error' && r.spent) userRefund(uid); } // unknown / error
            }
        }
        // Pegangan (claim) TIDAK dilepas di sini: precheck() melepas akun yang tidak dipakai
        // SETELAH akun terpilih dipegang, supaya pembeli lain tidak menyerobot di sela-selanya.
        return { live, fillable, passthrough, skipped, dead, apiCalls, mine };
    }

    async function removeDead(product, variant, deadIn, buyerId) {
        // Ambil stok terbaru: catat & laporkan hanya akun yang benar-benar masih ada di stok
        // (mencegah akun yang sama tercatat dua kali saat dua pengecekan berjalan bersamaan).
        const fresh = await Product.findOne({ id: product.id }, { variants: 1 }).lean().catch(() => null);
        const fv = fresh && (fresh.variants || []).find((v) => v.slug === variant.slug);
        const present = new Set(fv && Array.isArray(fv.stock) ? fv.stock : []);
        const dead = deadIn.filter((x, i, arr) => present.has(x.item) && arr.findIndex((y) => y.item === x.item) === i);
        if (!dead.length) return;
        const items = dead.map((d) => d.item);
        await Product.updateOne(
            { id: product.id, 'variants.slug': variant.slug },
            { $pull: { 'variants.$.stock': { $in: items } } }
        );
        const now = new Date();
        await GmailDead.insertMany(dead.map((d) => ({
            item: d.item, email: d.email, reason: d.reason,
            productId: product.id, variantSlug: variant.slug,
            productName: product.name, variantName: variant.name,
            removedAt: now, handled: false,
        }))).catch((e) => console.error('[GMAILCHECK] gagal simpan stok mati:', e.message));

        // Notifikasi owner dikirim di BELAKANG supaya pembeli tidak ikut menunggu.
        const lines = dead.slice(0, 20).map((d) => `• ${d.email} — ${d.reason}`);
        if (dead.length > 20) lines.push(`… dan ${dead.length - 20} lainnya (lihat file)`);
        const text =
            `🧹 Cek Gmail: ${dead.length} akun TIDAK LIVE dibuang dari stok\n` +
            `Produk: ${product.name} - ${variant.name}\n` +
            (buyerId ? `Terdeteksi saat user ${buyerId} akan membeli.\n` : '') +
            `\n${lines.join('\n')}\n\n` +
            'Akun ini tersimpan di "Stok Mati" (Panel Admin -> 📧 Cek Gmail). File lengkap terlampir.';
        const file = Buffer.from(dead.map((d) => d.item).join('\n'), 'utf8');
        setImmediate(() => {
            notifyOwner(text)
                .then(() => sendOwnerFile(file, `gmail-mati-${Date.now()}.txt`,
                    `Akun Gmail tidak live (${dead.length}) - ${product.name} - ${variant.name}`))
                .catch((e) => console.error('[GMAILCHECK] notif owner gagal:', e.message));
        });
    }

    // =================================================================
    // precheck — dipanggil di handler tombol bayar SEBELUM stok direservasi.
    // Return { proceed, preferred }:
    //   proceed=false -> handler harus berhenti (pembeli sudah diberi pesan).
    //   preferred     -> akun yang lolos cek; dipakai takeFromStock().
    // Tidak pernah melempar error: kalau ada masalah, penjualan tetap jalan normal.
    // =================================================================
    async function precheck(ctx, productId, variantSlug, quantity) {
        const pass = { proceed: true, preferred: [], resultMsgId: null };
        if (!(quantity > 0)) return pass;
        let product, variant;
        try {
            if (!(await isActive())) return pass;
            product = await Product.findOne({ id: productId }).lean();
            if (!product) return pass;
            variant = (product.variants || []).find((v) => v.slug === variantSlug);
            if (!variant || !isGmailVariant(product, variant)) return pass;
            if (!Array.isArray(variant.stock) || variant.stock.length < quantity) return pass; // handler yang bilang stok kurang
            // Stok yang barisnya tidak diawali email (mis. akun DigitalOcean) tidak dicek sama sekali.
            if (!variant.stock.slice(0, Math.max(50, quantity)).some((it) => extractEmail(it))) return pass;
        } catch (e) {
            console.error('[GMAILCHECK] precheck (load) error:', e.message);
            return pass;
        }

        const uid = String(ctx.from.id);
        if (busyUsers.has(uid)) {
            await ctx.answerCbQuery('⏳ Akun sedang dicek, mohon tunggu...').catch(() => {});
            return { proceed: false, preferred: [] };
        }
        busyUsers.add(uid);
        let waitMsg = null;
        let heldByMe = null; // akun yang sedang dipegang pengecekan ini (dilepas bila error)
        try {
            await ctx.answerCbQuery().catch(() => {});
            waitMsg = await ctx.reply(
                '⏳ *Tunggu sebentar...*\n\n' +
                'Sedang mengecek akun Gmail yang akan dikirim ke Anda, supaya yang Anda terima benar-benar *aktif*. ' +
                'Biasanya hanya beberapa detik.',
                { parse_mode: 'Markdown' }
            ).catch(() => null);

            const res = await selectLive(variant.stock, quantity, uid);
            heldByMe = res.mine;
            // urutan prioritas: lolos cek -> baris tanpa email -> (mode normal) belum bisa dicek
            const usable = res.live.concat(res.passthrough, STRICT ? [] : res.fillable);
            const chosenSet = new Set(usable.length >= quantity ? usable.slice(0, quantity).map((r) => r.item) : []);
            const deadSet = new Set(res.dead.map((r) => r.item));
            // Pegang akun terpilih, lepas akun lain yang tadi ikut dipegang selama pengecekan.
            for (const it of chosenSet) claim(it, uid);
            for (const it of res.mine) if (!chosenSet.has(it) && !deadSet.has(it)) claimed.delete(it);
            if (res.dead.length) {
                await removeDead(product, variant, res.dead, uid).catch((e) => console.error('[GMAILCHECK] removeDead error:', e.message));
            }
            for (const it of deadSet) claimed.delete(it);
            heldByMe = null;
            console.log(`[GMAILCHECK] ${uid} ${productId}/${variantSlug} x${quantity}: live=${res.live.length} dead=${res.dead.length} passthrough=${res.passthrough.length} fillable=${res.fillable.length} skipped=${res.skipped.length} api=${res.apiCalls}`);

            if (usable.length < quantity) {
                let text;
                if (STRICT && res.fillable.length) {
                    text = '❌ *Maaf, pengecekan akun sedang tidak tersedia.*\n\nSilakan coba lagi beberapa saat lagi. Anda belum dikenakan biaya apa pun.';
                } else if (res.skipped.length) {
                    text = `⏳ *Akun Gmail aktif yang siap kirim belum cukup.*\n\nBaru *${usable.length}* dari *${quantity}* akun yang lolos pengecekan. ` +
                        'Silakan coba lagi beberapa menit lagi atau kurangi jumlah pembelian.\n\nAnda belum dikenakan biaya apa pun.';
                } else {
                    text = `❌ *Maaf, stok Gmail aktif tidak mencukupi.*\n\nSaat ini hanya *${usable.length}* akun aktif yang tersedia, sedangkan Anda memesan *${quantity}*. ` +
                        'Silakan kurangi jumlah pembelian atau coba lagi nanti.\n\nAnda belum dikenakan biaya apa pun.';
                }
                if (waitMsg) {
                    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: 'Markdown' })
                        .catch(() => ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {}));
                } else {
                    await ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {});
                }
                return { proceed: false, preferred: [] };
            }

            const chosen = usable.slice(0, quantity);
            const preferred = chosen.map((r) => r.item);
            for (const r of chosen) {
                if (r.status === 'live' || r.status === 'noemail') unverifiedItems.delete(r.item);
                else unverifiedItems.set(r.item, { reason: r.reason, exp: Date.now() + UNVERIFIED_TTL_MS });
            }

            // Semua akun lolos cek -> pesan "tunggu" diubah jadi HASIL pengecekan yang tetap
            // tinggal di chat (QRIS muncul di bawahnya). Kalau ada akun yang belum sempat
            // dicek, pesan hasil tidak ditampilkan (pesan tunggu dihapus seperti biasa).
            let resultMsgId = null;
            if (chosen.every((r) => r.status === 'live')) {
                const text = buildResultText(product, variant, quantity);
                if (waitMsg) {
                    const edited = await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: 'Markdown' })
                        .then(() => true).catch(() => false);
                    if (edited) resultMsgId = waitMsg.message_id;
                    else await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
                }
                if (!resultMsgId) {
                    const m = await ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => null);
                    resultMsgId = m ? m.message_id : null;
                }
            } else if (waitMsg) {
                await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
            }
            return { proceed: true, preferred, resultMsgId };
        } catch (e) {
            console.error('[GMAILCHECK] precheck error:', e);
            if (heldByMe) for (const it of heldByMe) claimed.delete(it);
            if (waitMsg) await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
            return pass;
        } finally {
            busyUsers.delete(uid);
        }
    }

    // Teks hasil pengecekan untuk pembeli (tampil di atas QRIS).
    function buildResultText(product, variant, quantity) {
        const wib = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(11, 16); // WIB = UTC+7
        const label = [product && product.name, variant && variant.name].filter(Boolean).join(' - ');
        return '✅ *Pengecekan Otomatis Selesai*\n\n' +
            '🤖 Bot telah mengecek akun secara otomatis\n' +
            'agar akun yang dikirim ke anda aman dan hidup.\n\n' +
            `📧 Produk : ${escMd(label)}\n` +
            `🔢 Jumlah : ${quantity} akun\n` +
            '🟢 Status : AKTIF & HIDUP ✓\n' +
            `🕒 Dicek  : ${wib} WIB\n\n` +
            '🔒 Akun sudah diamankan khusus untuk Anda.\n' +
            'Silakan selesaikan pembayaran QRIS di bawah,\n' +
            'akun dikirim otomatis setelah pembayaran berhasil.';
    }

    // Hapus pesan hasil pengecekan (dipanggil saat invoice gagal dibuat / kedaluwarsa / dibatalkan),
    // supaya tidak tertinggal tulisan "selesaikan pembayaran QRIS di bawah" tanpa QRIS.
    async function dropResult(telegram, chatId, msgId) {
        if (!telegram || !chatId || !msgId) return;
        await telegram.deleteMessage(chatId, msgId).catch(() => {});
    }

    // Ambil `quantity` item dari variant.stock (dokumen Mongoose), mendahulukan
    // akun yang sudah lolos cek. Sisanya (kalau ada yang keburu diambil pembeli
    // lain) diisi dari depan stok seperti perilaku lama.
    function takeFromStock(variant, quantity, preferred) {
        const stock = variant.stock;
        const idx = [];
        const used = new Set();
        for (const p of preferred || []) {
            if (idx.length >= quantity) break;
            for (let k = 0; k < stock.length; k++) {
                if (!used.has(k) && stock[k] === p) { idx.push(k); used.add(k); break; }
            }
        }
        // Varian Gmail: kalau akun hasil pengecekan ternyata sudah tidak ada (keburu dibeli
        // orang lain), JANGAN diganti akun yang belum dicek — batalkan, pembeli coba lagi.
        if (preferred && preferred.length && idx.length < Math.min(quantity, preferred.length)) {
            throw new Error('Maaf, stok tidak mencukupi.');
        }
        cleanupClaims();
        // isi sisa (produk non-Gmail): dahulukan akun yang tidak sedang "dipegang" pembeli lain
        for (let k = 0; k < stock.length && idx.length < quantity; k++) {
            if (!used.has(k) && !claimed.has(stock[k])) { idx.push(k); used.add(k); }
        }
        for (let k = 0; k < stock.length && idx.length < quantity; k++) {
            if (!used.has(k)) { idx.push(k); used.add(k); }
        }
        const picked = idx.map((k) => stock[k]);
        idx.slice().sort((a, b) => b - a).forEach((k) => stock.splice(k, 1));
        // "Tanda terjual" sementara: pengecekan lain yang masih memakai salinan stok lama
        // tidak akan memilih akun ini lagi.
        const tomb = { uid: '__sold__', exp: Date.now() + TOTAL_BUDGET_MS + CLAIM_MS };
        for (const it of picked) claimed.set(it, tomb);
        return picked;
    }

    // =================================================================
    // Panel owner: /cekgmail & tombol "📧 Cek Gmail" di Panel Admin Telegram.
    // =================================================================
    async function buildView(notice) {
        const enabled = await getEnabledSetting();
        const deadCount = await GmailDead.countDocuments({ handled: false }).catch(() => 0);
        const wib = (d) => (d ? new Date(d).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '-');
        const hhmm = (ms) => new Date(ms).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
        let apiLine;
        if (!HAS_KEY) apiLine = '❌ QEV\\_API\\_KEY belum diisi di .env';
        else if (apiUnavailable()) apiLine = `⚠️ Semua key sedang tidak bisa dipakai (0/${KEYS.length})`;
        else apiLine = `✅ Siap (${activeKeys().length}/${KEYS.length} key aktif)`;
        const keyLines = KEYS.map((k) => {
            let st;
            if (k.downUntil > Date.now()) {
                st = k.downReason === 'ditolak' ? `❌ ditolak (dicoba lagi ${hhmm(k.downUntil)})`
                    : k.downReason === 'kuota habis' ? `⛔ kuota habis (dicoba lagi ${hhmm(k.downUntil)})`
                    : `⏳ ${escMd(k.downReason)} (dicoba lagi ${hhmm(k.downUntil)})`;
            } else {
                st = '✅ aktif';
            }
            return `#${k.no} \`${k.mask}\` — ${st} · sisa ${k.remaining == null ? '?' : k.remaining} · terpakai ${k.used}`;
        });
        const total = totalRemaining();
        const message =
            '📧 *Cek Gmail Live* (QuickEmailVerification)\n\n' +
            `Status fitur: *${enabled ? 'AKTIF' : 'MATI'}*${HAS_KEY ? '' : ' (tidak jalan tanpa API key)'}\n` +
            `API: ${apiLine}\n` +
            (keyLines.length ? keyLines.join('\n') + '\n' : '') +
            `Total sisa kredit: *${total == null ? 'belum diketahui' : total}*\n` +
            `Cek terakhir: ${wib(state.lastApiAt)}\n` +
            `Kredit terpakai sejak bot jalan: ${state.usedSinceStart}\n` +
            `Mode: ${STRICT ? 'ketat (tahan penjualan bila tidak bisa dicek)' : 'normal (tetap jual bila API tidak bisa dipakai)'}\n` +
            `Produk yang dicek: nama cocok /${escMd(MATCH.source)}/i\n\n` +
            `🪦 Stok mati belum diurus: *${deadCount}*` +
            (notice ? `\n\n${notice}` : '');
        const rows = [
            [{ text: enabled ? '⏸️ Matikan cek Gmail' : '▶️ Aktifkan cek Gmail', callback_data: 'gmc_toggle' }],
            [{ text: KEYS.length > 1 ? `🔎 Tes ${KEYS.length} API key (gratis)` : '🔎 Tes API key (gratis)', callback_data: 'gmc_test' }],
        ];
        if (deadCount > 0) {
            rows.push([{ text: '📥 Unduh stok mati', callback_data: 'gmc_dead_dl' }]);
            rows.push([{ text: '✅ Tandai stok mati sudah diurus', callback_data: 'gmc_dead_ok' }]);
        }
        rows.push([{ text: '♻️ Muat ulang', callback_data: 'admin_gmail' }]);
        rows.push([{ text: '⬅️ Kembali', callback_data: 'admin_menu' }]);
        return { message, reply_markup: { inline_keyboard: rows } };
    }

    async function showView(ctx, notice, edit = true) {
        const v = await buildView(notice);
        const opts = { parse_mode: 'Markdown', reply_markup: v.reply_markup };
        if (edit && ctx.callbackQuery) {
            return ctx.editMessageText(v.message, opts).catch((err) => {
                if (String(err && (err.description || err.message) || '').includes('message is not modified')) return;
                return ctx.reply(v.message, opts).catch(() => {});
            });
        }
        return ctx.reply(v.message, opts).catch(() => {});
    }

    function attach(b) {
        bot = b;
        if (!HAS_KEY) console.warn('[GMAILCHECK] QEV_API_KEY kosong -> cek Gmail live NONAKTIF (penjualan tetap normal).');
        else console.log(`[GMAILCHECK] ${KEYS.length} API key QuickEmailVerification dimuat: ${KEYS.map((k) => '#' + k.no + ' ' + k.mask).join(', ')}`);

        // /cekgmail            -> status & menu
        // /cekgmail email@x.com -> cek 1 email sekarang (memakai 1 kredit)
        bot.command('cekgmail', async (ctx) => {
            if (!isOwner(ctx)) return;
            const arg = (ctx.message.text.split(/\s+/)[1] || '').trim();
            if (!arg) return showView(ctx, null, false);
            const email = extractEmail(arg);
            if (!email) return ctx.reply('Format: /cekgmail email@gmail.com');
            const r = await callApi(email);
            if (r.status === 'live' || r.status === 'dead') {
                const now = new Date();
                await GmailCheck.updateOne({ email }, { $set: { status: r.status, reason: r.reason, checkedAt: now, expireAt: new Date(now.getTime() + 7 * 86400000) } }, { upsert: true }).catch(() => {});
            }
            const label = { live: '✅ LIVE', dead: '❌ MATI', unknown: '❔ Tidak pasti', error: '⚠️ Gagal cek' }[r.status] || r.status;
            const total = totalRemaining();
            return ctx.reply(`${label}\n${email}\nAlasan: ${r.reason}\nTotal sisa kredit: ${total == null ? '-' : total}`);
        });

        bot.action('admin_gmail', async (ctx) => {
            if (!isOwner(ctx)) return ctx.answerCbQuery('❌ Khusus admin.').catch(() => {});
            await ctx.answerCbQuery().catch(() => {});
            return showView(ctx);
        });

        bot.action('gmc_toggle', async (ctx) => {
            if (!isOwner(ctx)) return ctx.answerCbQuery('❌ Khusus admin.').catch(() => {});
            const next = !(await getEnabledSetting());
            await Settings.updateOne({ identifier: 'global-settings' }, { $set: { gmailcheck_enabled: next } }, { upsert: true });
            await ctx.answerCbQuery(next ? '▶️ Cek Gmail AKTIF' : '⏸️ Cek Gmail MATI (stok dijual tanpa cek)', { show_alert: true }).catch(() => {});
            return showView(ctx);
        });

        bot.action('gmc_test', async (ctx) => {
            if (!isOwner(ctx)) return ctx.answerCbQuery('❌ Khusus admin.').catch(() => {});
            await ctx.answerCbQuery('Mengetes API key...').catch(() => {});
            if (!HAS_KEY) return showView(ctx, '❌ Belum ada API key. Isi QEV\\_API\\_KEY di .env / Render.');
            const results = await Promise.all(KEYS.map((k) => testKey(k).then((r) => ({ k, r }))));
            const lines = results.map(({ k, r }) => r.ok
                ? `✅ #${k.no} \`${k.mask}\` berhasil`
                : `❌ #${k.no} \`${k.mask}\` gagal: ${escMd(r.reason)}`);
            return showView(ctx, '*Hasil tes (mode sandbox, tidak memakai kredit):*\n' + lines.join('\n'));
        });

        bot.action('gmc_dead_dl', async (ctx) => {
            if (!isOwner(ctx)) return ctx.answerCbQuery('❌ Khusus admin.').catch(() => {});
            await ctx.answerCbQuery().catch(() => {});
            const docs = await GmailDead.find({ handled: false }).sort({ removedAt: 1 }).lean();
            if (!docs.length) return showView(ctx, 'Tidak ada stok mati.');
            const wib = (d) => new Date(d).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            const content = docs.map((d) => `${d.item}\t# ${d.reason} | ${d.productName} - ${d.variantName} | ${wib(d.removedAt)}`).join('\n');
            await ctx.replyWithDocument({ source: Buffer.from(content, 'utf8'), filename: `stok-gmail-mati-${Date.now()}.txt` },
                { caption: `🪦 ${docs.length} akun Gmail mati (belum diurus)` }).catch(() => {});
        });

        bot.action('gmc_dead_ok', async (ctx) => {
            if (!isOwner(ctx)) return ctx.answerCbQuery('❌ Khusus admin.').catch(() => {});
            const r = await GmailDead.updateMany({ handled: false }, { $set: { handled: true } });
            await ctx.answerCbQuery(`✅ ${r.modifiedCount || 0} akun ditandai sudah diurus.`, { show_alert: true }).catch(() => {});
            return showView(ctx);
        });
    }

    return { precheck, takeFromStock, release, countUnverified, dropResult, attach, extractEmail, isGmailVariant, callApi, _state: state, _keys: KEYS };
};
