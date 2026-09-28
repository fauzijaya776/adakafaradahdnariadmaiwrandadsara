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
//   * batas cek per pembeli per jam (anti iseng);
//   * kalau kuota habis / API error, penjualan TETAP jalan dengan akun yang
//     belum terverifikasi (bisa diubah jadi ketat lewat GMAILCHECK_STRICT=1),
//     dan owner diberi tahu.
//
// Catatan: QEV mengecek lewat server mail (SMTP). Yang terdeteksi: akun tidak
// ada/dihapus & akun di-disable Google. Password diganti / minta verifikasi HP
// TIDAK terdeteksi.
//
// ENV:
//   QEV_API_KEY              API key QuickEmailVerification (WAJIB, tanpa ini fitur nonaktif)
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

const REQ_TIMEOUT_MS = 25000;     // QEV bisa beberapa detik (cek SMTP)
const TOTAL_BUDGET_MS = 75000;    // batas total 1x pengecekan, supaya pembeli tidak menunggu lama
const MAX_PARALLEL = 5;
const CLAIM_MS = 90 * 1000;       // akun yang sudah dipilih untuk 1 pembeli tidak dipilih pembeli lain dulu
const ALERT_EVERY_MS = 3 * 60 * 60 * 1000;

function num(v, def) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : def;
}

function extractEmail(item) {
    if (!item || typeof item !== 'string') return null;
    const firstLine = item.split(/\r?\n/)[0];
    const m = firstLine.match(EMAIL_RE);
    return m ? m[0].toLowerCase() : null;
}

function escMd(s) {
    return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}

module.exports = function createGmailCheck(cfg) {
    const { Product, Settings, GmailCheck, GmailDead } = cfg;
    const API_KEY = (process.env.QEV_API_KEY || '').trim();
    let MATCH;
    try { MATCH = new RegExp(process.env.GMAILCHECK_MATCH || 'gmail', 'i'); } catch (e) { MATCH = /gmail/i; }
    const CACHE_MS = num(process.env.GMAILCHECK_CACHE_HOURS, 6) * 60 * 60 * 1000;
    const USER_HOURLY = num(process.env.GMAILCHECK_USER_HOURLY, 20);
    const STRICT = String(process.env.GMAILCHECK_STRICT || '').trim() === '1';

    let bot = null;
    const state = {
        remainingCredits: null,   // dari header X-QEV-Remaining-Credits
        lastApiAt: null,
        apiDownUntil: 0,
        apiDownReason: '',
        usedSinceStart: 0,
        lastAlert: {},
    };
    const busyUsers = new Set();
    const userUsage = new Map();  // userId -> [timestamp kuota dipakai]
    const claimed = new Map();    // item -> expiry ms

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
        if (!API_KEY) return false;
        return getEnabledSetting();
    }
    function isGmailVariant(product, variant) {
        const hay = `${product && product.name || ''} ${variant && variant.name || ''} ${variant && variant.slug || ''}`;
        return MATCH.test(hay);
    }

    // ---------- kuota per pembeli ----------
    function userCanSpend(uid) {
        const now = Date.now();
        const arr = (userUsage.get(uid) || []).filter((t) => now - t < 60 * 60 * 1000);
        userUsage.set(uid, arr);
        return arr.length < USER_HOURLY;
    }
    function userSpend(uid) {
        const arr = userUsage.get(uid) || [];
        arr.push(Date.now());
        userUsage.set(uid, arr);
    }

    function cleanupClaims() {
        const now = Date.now();
        for (const [item, exp] of claimed) if (exp <= now) claimed.delete(item);
    }

    function markApiDown(ms, reason, alertText) {
        state.apiDownUntil = Date.now() + ms;
        state.apiDownReason = reason;
        if (alertText) notifyOwner(alertText, `down:${reason.slice(0, 40)}`).catch(() => {});
    }

    // ---------- panggil API ----------
    // Hasil: { status: 'live' | 'dead' | 'unknown' | 'error', reason }
    async function callApi(email, { sandbox = false } = {}) {
        if (!API_KEY) return { status: 'error', reason: 'QEV_API_KEY belum diisi' };
        if (!sandbox && Date.now() < state.apiDownUntil) return { status: 'error', reason: state.apiDownReason || 'API sementara tidak dipakai' };
        let res;
        try {
            res = await axios.get(sandbox ? SANDBOX_URL : API_URL, {
                params: { email, apikey: API_KEY },
                timeout: REQ_TIMEOUT_MS,
                validateStatus: () => true,
            });
        } catch (e) {
            return { status: 'error', reason: e.code || e.message || 'network error' };
        }
        const rem = res.headers && (res.headers['x-qev-remaining-credits'] ?? res.headers['X-QEV-Remaining-Credits']);
        if (rem !== undefined && rem !== null && rem !== '' && Number.isFinite(Number(rem))) state.remainingCredits = Number(rem);
        if (!sandbox) {
            state.lastApiAt = new Date();
            state.usedSinceStart += 1;
        }
        const body = res.data && typeof res.data === 'object' ? res.data : {};
        const msg = String(body.message || `HTTP ${res.status}`);

        if (res.status === 200 && String(body.success) !== 'false') {
            const result = String(body.result || '').toLowerCase();
            const reason = String(body.reason || '').toLowerCase();
            if (result === 'valid') return { status: 'live', reason: reason || 'accepted_email' };
            if (result === 'invalid' && DEAD_REASONS.has(reason)) return { status: 'dead', reason };
            return { status: 'unknown', reason: reason || result || 'unknown' };
        }
        if (sandbox) return { status: 'error', reason: `${res.status} ${msg}` };

        if (res.status === 402 || /credit/i.test(msg)) {
            state.remainingCredits = 0;
            markApiDown(30 * 60 * 1000, 'kuota habis',
                '⚠️ Cek Gmail: kuota QuickEmailVerification HABIS.\n' +
                (STRICT
                    ? 'Mode ketat aktif: penjualan Gmail DITAHAN sampai kuota tersedia lagi.'
                    : 'Penjualan Gmail tetap jalan TANPA pengecekan sampai kuota tersedia lagi.') +
                '\nKuota gratis reset harian; bisa juga beli kredit di quickemailverification.com.');
        } else if (res.status === 401 || res.status === 403) {
            markApiDown(30 * 60 * 1000, 'API key ditolak',
                `⚠️ Cek Gmail: API key QuickEmailVerification DITOLAK (${res.status} ${msg}).\nPeriksa QEV_API_KEY di .env / Render.`);
        } else if (res.status === 429) {
            markApiDown(60 * 1000, 'rate limit');
        }
        return { status: 'error', reason: `${res.status} ${msg}` };
    }

    // Cek 1 item stok. spend() dipanggil sebelum memakai kuota -> false = jatah habis.
    async function checkItem(item, cache, spend) {
        const email = extractEmail(item);
        if (!email) return { item, email: null, status: 'noemail', reason: 'tidak ada email di baris stok' };
        const c = cache.get(email);
        if (c && c.checkedAt && Date.now() - new Date(c.checkedAt).getTime() < CACHE_MS && (c.status === 'live' || c.status === 'dead')) {
            return { item, email, status: c.status, reason: c.reason, cached: true };
        }
        if (Date.now() < state.apiDownUntil) return { item, email, status: 'error', reason: state.apiDownReason };
        if (!spend()) return { item, email, status: 'skipped', reason: 'jatah cek habis' };
        const r = await callApi(email);
        if (r.status === 'live' || r.status === 'dead') {
            const now = new Date();
            await GmailCheck.updateOne(
                { email },
                { $set: { status: r.status, reason: r.reason, checkedAt: now, expireAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) } },
                { upsert: true }
            ).catch((e) => console.error('[GMAILCHECK] gagal simpan cache:', e.message));
        }
        return { item, email, status: r.status, reason: r.reason };
    }

    // Pilih akun live dari stok (urut dari depan) sampai cukup.
    async function selectLive(stock, quantity, uid) {
        cleanupClaims();
        const live = [];
        const unverified = [];
        const dead = [];
        const maxApiCalls = quantity * 2 + 5;
        let apiCalls = 0;
        let budgetOut = false;
        const spend = () => {
            if (apiCalls >= maxApiCalls || !userCanSpend(uid)) { budgetOut = true; return false; }
            apiCalls += 1;
            userSpend(uid);
            return true;
        };
        const deadline = Date.now() + TOTAL_BUDGET_MS;
        const mine = new Set(); // item yang sedang dipegang pemanggil ini (anti dobel dengan pembeli lain)
        let i = 0;
        while (i < stock.length && live.length < quantity && Date.now() < deadline) {
            const apiUnavailable = budgetOut || Date.now() < state.apiDownUntil;
            if (apiUnavailable && live.length + unverified.length >= quantity) break;
            const need = quantity - live.length;
            const size = Math.min(Math.max(need, 1), MAX_PARALLEL);
            const batch = [];
            while (i < stock.length && batch.length < size) {
                const it = stock[i++];
                if (claimed.has(it) || mine.has(it)) continue; // sedang dipegang pembeli lain
                claimed.set(it, Date.now() + CLAIM_MS);
                mine.add(it);
                batch.push(it);
            }
            if (!batch.length) break;
            const emails = batch.map(extractEmail).filter(Boolean);
            const cache = new Map();
            if (emails.length) {
                const docs = await GmailCheck.find({ email: { $in: emails } }).lean().catch(() => []);
                for (const d of docs || []) cache.set(d.email, d);
            }
            const results = await Promise.all(batch.map((it) => checkItem(it, cache, spend)
                .catch((e) => ({ item: it, status: 'error', reason: e.message }))));
            for (const r of results) {
                if (r.status === 'live') live.push(r);
                else if (r.status === 'dead') dead.push(r);
                else unverified.push(r);
            }
        }
        // lepas pegangan sementara; precheck() memegang ulang akun yang benar-benar dipakai
        for (const it of mine) claimed.delete(it);
        return { live, unverified, dead, apiCalls };
    }

    async function removeDead(product, variant, dead) {
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

        const lines = dead.slice(0, 20).map((d) => `• ${d.email} — ${d.reason}`);
        if (dead.length > 20) lines.push(`… dan ${dead.length - 20} lainnya (lihat file)`);
        await notifyOwner(
            `🧹 Cek Gmail: ${dead.length} akun MATI dikeluarkan dari stok\n` +
            `Produk: ${product.name} - ${variant.name}\n\n${lines.join('\n')}\n\n` +
            'Akun ini tersimpan di "Stok Mati" (Panel Admin -> 📧 Cek Gmail). File lengkap terlampir.'
        );
        await sendOwnerFile(
            Buffer.from(dead.map((d) => d.item).join('\n'), 'utf8'),
            `gmail-mati-${Date.now()}.txt`,
            `Akun Gmail mati (${dead.length}) - ${product.name} - ${variant.name}`
        );
    }

    // =================================================================
    // precheck — dipanggil di handler tombol bayar SEBELUM stok direservasi.
    // Return { proceed, preferred }:
    //   proceed=false -> handler harus berhenti (pembeli sudah diberi pesan).
    //   preferred     -> akun yang lolos cek; dipakai takeFromStock().
    // Tidak pernah melempar error: kalau ada masalah, penjualan tetap jalan normal.
    // =================================================================
    async function precheck(ctx, productId, variantSlug, quantity) {
        const pass = { proceed: true, preferred: [] };
        if (!(quantity > 0)) return pass;
        let product, variant;
        try {
            if (!(await isActive())) return pass;
            product = await Product.findOne({ id: productId }).lean();
            if (!product) return pass;
            variant = (product.variants || []).find((v) => v.slug === variantSlug);
            if (!variant || !isGmailVariant(product, variant)) return pass;
            if (!Array.isArray(variant.stock) || variant.stock.length < quantity) return pass; // handler yang bilang stok kurang
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
        try {
            await ctx.answerCbQuery().catch(() => {});
            waitMsg = await ctx.reply(
                '⏳ *Tunggu sebentar...*\n\n' +
                'Sedang mengecek akun Gmail yang akan dikirim ke Anda, supaya yang Anda terima benar-benar *aktif*. ' +
                'Biasanya hanya beberapa detik.',
                { parse_mode: 'Markdown' }
            ).catch(() => null);

            const res = await selectLive(variant.stock, quantity, uid);
            if (res.dead.length) {
                await removeDead(product, variant, res.dead).catch((e) => console.error('[GMAILCHECK] removeDead error:', e.message));
            }
            const usable = STRICT ? res.live : res.live.concat(res.unverified);
            console.log(`[GMAILCHECK] ${uid} ${productId}/${variantSlug} x${quantity}: live=${res.live.length} dead=${res.dead.length} unverified=${res.unverified.length} api=${res.apiCalls}`);

            if (usable.length < quantity) {
                const text = STRICT && res.unverified.length && !res.live.length
                    ? '❌ *Maaf, pengecekan akun sedang tidak tersedia.*\n\nSilakan coba lagi beberapa saat lagi. Anda belum dikenakan biaya apa pun.'
                    : `❌ *Maaf, stok Gmail aktif tidak mencukupi.*\n\nSaat ini hanya *${usable.length}* akun aktif yang tersedia, sedangkan Anda memesan *${quantity}*. ` +
                      'Silakan kurangi jumlah pembelian atau coba lagi nanti.\n\nAnda belum dikenakan biaya apa pun.';
                if (waitMsg) {
                    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: 'Markdown' })
                        .catch(() => ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {}));
                } else {
                    await ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {});
                }
                return { proceed: false, preferred: [] };
            }

            const preferred = usable.slice(0, quantity).map((r) => r.item);
            const exp = Date.now() + CLAIM_MS;
            for (const it of preferred) claimed.set(it, exp);
            if (waitMsg) await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
            return { proceed: true, preferred };
        } catch (e) {
            console.error('[GMAILCHECK] precheck error:', e);
            if (waitMsg) await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
            return pass;
        } finally {
            busyUsers.delete(uid);
        }
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
        cleanupClaims();
        // isi sisa: dahulukan akun yang tidak sedang "dipegang" pembeli lain
        for (let k = 0; k < stock.length && idx.length < quantity; k++) {
            if (!used.has(k) && !claimed.has(stock[k])) { idx.push(k); used.add(k); }
        }
        for (let k = 0; k < stock.length && idx.length < quantity; k++) {
            if (!used.has(k)) { idx.push(k); used.add(k); }
        }
        const picked = idx.map((k) => stock[k]);
        idx.slice().sort((a, b) => b - a).forEach((k) => stock.splice(k, 1));
        for (const it of picked) claimed.delete(it);
        return picked;
    }

    // =================================================================
    // Panel owner: /cekgmail & tombol "📧 Cek Gmail" di Panel Admin Telegram.
    // =================================================================
    async function buildView(notice) {
        const enabled = await getEnabledSetting();
        const deadCount = await GmailDead.countDocuments({ handled: false }).catch(() => 0);
        const wib = (d) => (d ? new Date(d).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '-');
        let apiLine;
        if (!API_KEY) apiLine = '❌ QEV_API_KEY belum diisi di .env';
        else if (Date.now() < state.apiDownUntil) apiLine = `⚠️ Sementara tidak dipakai (${escMd(state.apiDownReason)})`;
        else apiLine = '✅ Siap';
        const message =
            '📧 *Cek Gmail Live* (QuickEmailVerification)\n\n' +
            `Status fitur: *${enabled ? 'AKTIF' : 'MATI'}*${API_KEY ? '' : ' (tidak jalan tanpa API key)'}\n` +
            `API: ${apiLine}\n` +
            `Sisa kredit: *${state.remainingCredits == null ? 'belum diketahui' : state.remainingCredits}*\n` +
            `Cek terakhir: ${wib(state.lastApiAt)}\n` +
            `Kredit terpakai sejak bot jalan: ${state.usedSinceStart}\n` +
            `Mode: ${STRICT ? 'ketat (tahan penjualan bila tidak bisa dicek)' : 'normal (tetap jual bila API tidak bisa dipakai)'}\n` +
            `Produk yang dicek: nama cocok /${escMd(MATCH.source)}/i\n\n` +
            `🪦 Stok mati belum diurus: *${deadCount}*` +
            (notice ? `\n\n${notice}` : '');
        const rows = [
            [{ text: enabled ? '⏸️ Matikan cek Gmail' : '▶️ Aktifkan cek Gmail', callback_data: 'gmc_toggle' }],
            [{ text: '🔎 Tes API key (gratis)', callback_data: 'gmc_test' }],
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
            return ctx.editMessageText(v.message, opts).catch(() => ctx.reply(v.message, opts).catch(() => {}));
        }
        return ctx.reply(v.message, opts).catch(() => {});
    }

    function attach(b) {
        bot = b;
        if (!API_KEY) console.warn('[GMAILCHECK] QEV_API_KEY kosong -> cek Gmail live NONAKTIF (penjualan tetap normal).');

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
            return ctx.reply(`${label}\n${email}\nAlasan: ${r.reason}\nSisa kredit: ${state.remainingCredits == null ? '-' : state.remainingCredits}`);
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
            const r = await callApi('valid@example.com', { sandbox: true });
            const ok = r.status === 'live';
            return showView(ctx, ok
                ? '✅ Tes API key berhasil (mode sandbox, tidak memakai kredit).'
                : `❌ Tes API key gagal: ${escMd(r.reason)}`);
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

    return { precheck, takeFromStock, attach, extractEmail, isGmailVariant, callApi, _state: state };
};
