'use strict';
const { randomBytes } = require('node:crypto');
const { Markup } = require('telegraf');
const { createService } = require('./quick_stock');

module.exports = function attach(bot, deps, service = createService(deps)) {
    const { userStates, adminMiddleware, getAdminMenuMessageAndKeyboard } = deps;
    const key = (label, data) => Markup.button.callback(label, data);
    const keyboard = rows => Markup.inlineKeyboard(rows);
    function clear(id) {
        if (userStates[id]?.state !== 'quick_stock') return;
        clearTimeout(userStates[id].timer);
        delete userStates[id];
    }
    function start(id) {
        clear(id);
        const s = { state: 'quick_stock', step: 'input', nonce: randomBytes(12).toString('hex') };
        s.timer = setTimeout(() => { if (userStates[id] === s) clear(id); }, 10 * 60000);
        s.timer.unref();
        userStates[id] = s;
        return s;
    }
    const back = s => [key('⬅️ Kembali', 'qs:back:' + s.nonce)];
    const inputKeys = s => keyboard([[key('⚙️ Pasangkan Limit ke Varian', 'qs:map:' + s.nonce)], back(s)]);
    const prompt = '⚡ Tambah Stok Cepat\nTempel 1–20 akun DigitalOcean, satu akun per baris:\ntoken_DO|email|password|secret_2FA\n\nStok ditambahkan setelah kamu periksa pratinjau dan menekan Simpan.';
    async function show(ctx, message, extra) {
        if (ctx.callbackQuery) {
            try { return await ctx.editMessageText(message, extra); }
            catch (e) { if (e.description?.includes('message is not modified')) return; }
        }
        return ctx.reply(message, extra);
    }
    function page(ctx, s, n) {
        const last = Math.ceil(s.choices.length / 8) - 1;
        n = Math.max(0, Math.min(n, last));
        const rows = s.choices.slice(n * 8, n * 8 + 8).map((v, i) => [
            key(v.label.slice(0, 60), 'qs:pick:' + s.nonce + ':' + (n * 8 + i)),
        ]);
        const nav = [];
        if (n > 0) nav.push(key('⬅️ Sebelumnya', 'qs:page:' + s.nonce + ':' + (n - 1)));
        if (n < last) nav.push(key('Selanjutnya ➡️', 'qs:page:' + s.nonce + ':' + (n + 1)));
        if (nav.length) rows.push(nav);
        rows.push(back(s));
        return show(ctx, 'Pilih tujuan stok DigitalOcean untuk limit ' + s.limit + ' droplet. Ketukan ini menyimpan pasangan.', keyboard(rows));
    }
    async function preview(ctx, s, text) {
        // Remove the owner's pasted credentials from the private chat when Telegram permits it.
        await ctx.deleteMessage().catch(() => {});
        const count = text.split(/\r?\n/).filter(l => l.trim()).length;
        if (!count || count > 20) return ctx.reply('Kirim 1–20 akun per batch.', inputKeys(s));
        const rows = await service.preview(text);
        if (userStates[ctx.from.id] !== s) return;
        s.rows = rows.filter(r => !r.error);
        s.step = s.rows.length ? 'preview' : 'input';
        const lines = rows.map(r => {
            if (r.error) return 'Baris ' + r.n + ' — ' + r.error;
            const email = r.email.split('@');
            return 'Baris ' + r.n + ' — ' + email[0].slice(0, 2) + '***@' + email[1].slice(0, 40) + ' → ' + r.limit + ' droplet → ' + r.target.label.slice(0, 65);
        });
        const buttons = s.rows.length ? keyboard([[key('✅ Simpan ' + s.rows.length + ' akun', 'qs:save:' + s.nonce)], back(s)]) : inputKeys(s);
        const totals = new Map();
        for (const r of s.rows) totals.set(r.limit, (totals.get(r.limit) || 0) + 1);
        const summary = [...totals].map(([limit, count]) => limit + ' droplet: ' + count + ' akun');
        const duplicates = rows.filter(r => r.error === 'Duplikat').length;
        if (duplicates) summary.push('Duplikat: ' + duplicates);
        await ctx.reply(['Pratinjau · siap ' + s.rows.length + ' · dilewati ' + (rows.length - s.rows.length),
            summary.join(' · '), ...lines].filter(Boolean).join('\n'), buttons);
    }

    bot.use(async (ctx, next) => {
        const s = userStates[ctx.from?.id];
        if (s?.state !== 'quick_stock' || ctx.chat?.type !== 'private') return next();
        if (ctx.callbackQuery?.data && !ctx.callbackQuery.data.startsWith('qs:') || ctx.message?.text?.startsWith('/')) {
            clear(ctx.from.id); return next();
        }
        if (!ctx.message?.text) return next();
        return adminMiddleware(ctx, async () => {
            try {
                if (s.step === 'input') return await preview(ctx, s, ctx.message.text);
                if (s.step === 'limit') {
                    if (!/^\d{1,6}$/.test(ctx.message.text.trim()) || Number(ctx.message.text) < 1) return ctx.reply('Masukkan angka limit, misalnya 3 atau 10.', keyboard([back(s)]));
                    s.limit = Number(ctx.message.text);
                    s.choices = await service.choices();
                    if (!s.choices.length) return ctx.reply('Belum ada varian di katalog.', keyboard([back(s)]));
                    s.step = 'choose';
                    return await page(ctx, s, 0);
                }
                return ctx.reply('Gunakan tombol pada layar terakhir.', keyboard([back(s)]));
            } catch { return ctx.reply('Gagal membaca data stok. Coba lagi dari menu ini.', keyboard([back(s)])); }
        });
    });
    bot.action(/^qs:(open|back|map|page|pick|save)(?::([a-f0-9]{24}))?(?::(\d+))?$/, adminMiddleware, async ctx => {
        if (ctx.chat?.type !== 'private') return ctx.answerCbQuery('Buka di chat pribadi bot.', { show_alert: true });
        const [, action, nonce, index] = ctx.match;
        const id = ctx.from.id;
        let s = userStates[id];
        if (action !== 'open' && (s?.state !== 'quick_stock' || s.nonce !== nonce)) {
            return ctx.answerCbQuery('Sesi sudah berakhir. Buka Tambah Stok Cepat lagi.', { show_alert: true });
        }
        await ctx.answerCbQuery().catch(() => {});
        try {
            if (action === 'open') { s = start(id); return await show(ctx, prompt, inputKeys(s)); }
            if (action === 'back') {
                clear(id);
                const { message, keyboard: menu } = await getAdminMenuMessageAndKeyboard();
                return await show(ctx, message, { parse_mode: 'Markdown', reply_markup: menu.reply_markup });
            }
            if (action === 'map' && s.step === 'input') {
                s.step = 'limit';
                return await show(ctx, 'Ketik jumlah droplet yang ingin dipasangkan, misalnya 3 atau 10.', keyboard([back(s)]));
            }
            if (action === 'page' && s.step === 'choose' && index !== undefined) return await page(ctx, s, Number(index));
            if (action === 'pick' && s.step === 'choose' && s.choices[index]) {
                const v = s.choices[index];
                await service.map(s.limit, v.id);
                const message = '✅ Limit ' + s.limit + ' → ' + v.label + '\n\n' + prompt;
                s = start(id);
                return await show(ctx, message, inputKeys(s));
            }
            if (action === 'save' && s.step === 'preview') {
                const result = await service.save(nonce, s.rows);
                clear(id);
                return await show(ctx, '✅ Stok bertambah: ' + result.added + ' akun.' +
                    (result.skipped.length ? '\nDilewati saat simpan:\n' + result.skipped.join('\n') : ''),
                    keyboard([[key('➕ Tambah Lagi', 'qs:open')], [key('⬅️ Panel Admin', 'admin_menu')]]));
            }
            return await ctx.reply('Tombol sudah kedaluwarsa. Gunakan layar terakhir.');
        } catch {
            // Never forward database/HTTP errors — they can contain the full stock line.
            return ctx.reply('Proses belum terkonfirmasi. Coba lagi; jika mengatur pasangan, pastikan varian masih ada dan belum dipakai limit lain.');
        }
    });
};
