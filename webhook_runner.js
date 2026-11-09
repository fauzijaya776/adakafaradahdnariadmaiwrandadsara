'use strict';
const crypto = require('node:crypto');
const express = require('express');

const PATH = '/telegram/update';
const PRIMARY = 'https://adakafaradahdnariadmaiwrandadsara-1-bkyv.onrender.com';

module.exports = function createWebhookRunner({ bot, app, origin, db, token, dataReady,
    primary = PRIMARY, configuredSecret }) {
    const url = new URL(PATH, origin);
    if (url.protocol !== 'https:') throw Error('Webhook Telegram memerlukan HTTPS.');
    const enabled = url.origin === new URL(primary).origin;
    const botId = String(token).split(':')[0];
    const pending = new Map();
    const admissions = new WeakMap();
    let secret, stopped = false, registered = false, failure = null, task, timer, wake;
    let indexed = false;
    const receipts = () => db.collection('telegram_update_receipts');

    async function loadSecret() {
        if (configuredSecret) {
            if (!/^[A-Za-z0-9_-]{32,256}$/.test(configuredSecret)) throw Error('TELEGRAM_WEBHOOK_SECRET harus 32–256 karakter alfanumerik, - atau _.');
            return configuredSecret;
        }
        if (db.readyState !== 1) throw Error('Menunggu database untuk memuat rahasia webhook.');
        const config = db.collection('telegram_webhook_config');
        const key = { _id: botId + '@' + url.origin };
        try {
            return (await config.findOneAndUpdate(key,
                { $setOnInsert: { secret: crypto.randomBytes(32).toString('hex') } },
                { upsert: true, returnDocument: 'after', includeResultMetadata: false })).secret;
        } catch (err) {
            if (err.code !== 11000) throw err;
            return (await config.findOne(key)).secret;
        }
    }

    async function supervise() {
        if (!enabled) {
            console.warn('[BOT] Standby: URL service berbeda dari URL production Telegram.');
            return;
        }
        let delay = 5000;
        while (!stopped) {
            try {
                secret ||= await loadSecret();
                bot.botInfo ||= await bot.telegram.callApi('getMe', {}, { signal: AbortSignal.timeout(20000) });
                if (stopped) return;
                const info = registered && await bot.telegram.getWebhookInfo();
                if (stopped) return;
                if (!info || info.url !== url.href) {
                    await bot.telegram.setWebhook(url.href, {
                        secret_token: secret, max_connections: 8, drop_pending_updates: false,
                    });
                    console.log('[BOT] Webhook Telegram terdaftar di ' + url.origin);
                }
                registered = true;
                delay = 5000;
            } catch (err) {
                registered = false;
                failure = { code: String(err.code || err.name || 'Error'), at: Date.now() };
                // TelegramError can contain the setWebhook payload, including the secret.
                console.warn('[BOT] Webhook belum siap; mencoba kembali.', failure.code);
            }
            if (stopped) return;
            await new Promise(resolve => {
                wake = resolve;
                timer = setTimeout(resolve, registered ? 60000 : delay);
            });
            if (!registered) delay = Math.min(delay * 2, 60000);
        }
    }

    async function processUpdate(update) {
        const admission = { work: null, retry: false };
        admissions.set(update, admission);
        try {
            await bot.handleUpdate(update);
            return Boolean(await admission.work) && !admission.retry;
        } finally {
            admissions.delete(update);
        }
    }
    app.post(PATH, (req, res, next) => {
        if (stopped || !enabled || !secret || !bot.botInfo) return res.sendStatus(503);
        const supplied = Buffer.from(req.get('X-Telegram-Bot-Api-Secret-Token') || '');
        const expected = Buffer.from(secret);
        if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.sendStatus(403);
        next();
    }, express.json({ limit: '1mb' }), async (req, res) => {
        const update = req.body;
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return res.sendStatus(400);
        const id = update.update_id;
        if (!pending.has(id)) {
            if (pending.size >= 48) return res.sendStatus(503);
            pending.set(id, processUpdate(update).finally(() => pending.delete(id)));
        }
        try { res.sendStatus(await pending.get(id) ? 200 : 503); }
        catch { res.sendStatus(503); }
    });

    return {
        mode: enabled ? 'webhook' : 'standby',
        start() { return task ||= supervise(); },
        stop() {
            stopped = true; clearTimeout(timer); wake?.();
            // Leave the registration intact so the next inbound message can wake Render.
        },
        isAlive: () => !stopped,
        isHealthy: () => !stopped && registered,
        lastFailure: () => failure,
        track(update, work) {
            const admission = admissions.get(update);
            if (admission) admission.work = work;
        },
        async once(update, next) {
            const admission = admissions.get(update);
            if (!admission) throw Error('Update di luar route webhook.');
            // When data is unavailable only the maintenance/status handlers may run.
            if (!dataReady()) return next();
            try {
                if (!indexed) {
                    await receipts().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
                    indexed = true;
                }
                // Claim before any side effects. Replays, including after restart, must
                // never execute a checkout or an owner action twice.
                await receipts().insertOne({ _id: botId + ':' + update.update_id,
                    expiresAt: new Date(Date.now() + 2 * 86400000) }, { writeConcern: { w: 'majority' } });
            } catch (err) {
                if (err.code !== 11000) admission.retry = true;
                return;
            }
            return next();
        },
    };
};
