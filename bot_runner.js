'use strict';

// Telegraf retries transient polling errors internally; relaunch when its loop exits.
module.exports = function createBotRunner(bot) {
    let stopping = false;
    let running = false;
    let lastPollAt = 0;
    let retryDelay = 5000;
    let retryTimer;
    let wakeRetry;
    let task;
    let lastFailure = null;
    const requests = new Set();
    const callApi = bot.telegram.callApi.bind(bot.telegram);

    bot.telegram.callApi = async (method, payload, options) => {
        const lifecycle = ['getMe', 'deleteWebhook', 'getUpdates'].includes(method);
        if (stopping && lifecycle) throw new Error('Bot is stopping');
        if (!lifecycle) return callApi(method, payload, options);
        // Telegraf's default HTTP timeout is 500s; a stuck request must release the poller.
        const timeout = method === 'getUpdates' && payload?.timeout ? 75000 : 20000;
        const controller = new AbortController();
        const upstream = options?.signal;
        const abort = () => controller.abort();
        if (upstream?.aborted) abort();
        else upstream?.addEventListener('abort', abort, { once: true });
        requests.add(controller);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
        let result;
        try {
            result = await callApi(method, payload, { ...options, signal: controller.signal });
        } catch (err) {
            if (timedOut) throw new Error(`${method} timeout setelah ${timeout / 1000} detik`);
            throw err;
        } finally {
            clearTimeout(timer);
            upstream?.removeEventListener('abort', abort);
            requests.delete(controller);
        }
        // Shutdown can arrive while launch is waiting for deleteWebhook.
        if (stopping && method === 'deleteWebhook') throw new Error('Bot is stopping');
        if (!stopping && running && method === 'getUpdates') {
            lastPollAt = Date.now();
            retryDelay = 5000;
        }
        return result;
    };

    async function run() {
        while (!stopping) {
            try {
                await bot.launch({}, () => {
                    if (stopping) throw new Error('Bot is stopping');
                    running = true;
                    lastPollAt = 0;
                    console.log('[BOT] Telegram terhubung; memulai polling.');
                });
                if (!stopping) console.error('[BOT] Polling berhenti tanpa permintaan shutdown.');
            } catch (err) {
                if (!stopping) {
                    lastFailure = { code: String(err.code || err.response?.error_code || err.name || 'Error'), at: Date.now() };
                    console.error('[BOT] Polling/launch gagal:', err);
                    if (Number(err.code || err.response?.error_code) === 409) {
                        console.error('[BOT] 409 Conflict: pastikan hanya satu proses/server memakai BOT_TOKEN ini.');
                    }
                }
            } finally {
                running = false;
            }
            if (stopping) break;
            console.warn(`[BOT] Mencoba kembali dalam ${retryDelay / 1000} detik.`);
            await new Promise(resolve => {
                wakeRetry = resolve;
                retryTimer = setTimeout(resolve, retryDelay);
            });
            retryTimer = undefined;
            wakeRetry = undefined;
            retryDelay = Math.min(retryDelay * 2, 60000);
        }
    }

    return {
        start() {
            if (!task) task = run();
            return task;
        },
        isAlive() {
            // Dependency outages are retried here; restarting Render can prolong a 409 deploy conflict.
            return !stopping;
        },
        lastFailure() {
            return lastFailure && { ...lastFailure };
        },
        isHealthy() {
            // getUpdates normally completes within 50s, including when the bot is idle.
            return !stopping && running && lastPollAt > 0 && Date.now() - lastPollAt < 120000;
        },
        stop(reason) {
            if (stopping) return;
            stopping = true;
            running = false;
            for (const controller of requests) controller.abort();
            clearTimeout(retryTimer);
            if (wakeRetry) wakeRetry();
            try { bot.stop(reason); }
            catch (err) {
                if (err.message !== 'Bot is not running!') console.error('[BOT] Shutdown:', err);
            }
        },
    };
};
