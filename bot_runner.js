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
    const callApi = bot.telegram.callApi.bind(bot.telegram);

    bot.telegram.callApi = async (method, ...args) => {
        if (stopping && method === 'getUpdates') throw new Error('Bot is stopping');
        const result = await callApi(method, ...args);
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
                    lastPollAt = Date.now();
                    console.log('[BOT] Telegram terhubung; memulai polling.');
                });
                if (!stopping) console.error('[BOT] Polling berhenti tanpa permintaan shutdown.');
            } catch (err) {
                if (!stopping) {
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
        isHealthy() {
            // getUpdates normally completes within 50s, including when the bot is idle.
            return !stopping && running && Date.now() - lastPollAt < 120000;
        },
        stop(reason) {
            if (stopping) return;
            stopping = true;
            running = false;
            clearTimeout(retryTimer);
            if (wakeRetry) wakeRetry();
            try { bot.stop(reason); }
            catch (err) {
                if (err.message !== 'Bot is not running!') console.error('[BOT] Shutdown:', err);
            }
        },
    };
};
