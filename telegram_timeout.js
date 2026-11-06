'use strict';

const protectedClients = new WeakSet();

// Contexts use separate Telegram clients, so protecting only bot.telegram is insufficient.
module.exports = function protectTelegram(telegram) {
    if (protectedClients.has(telegram)) return;
    protectedClients.add(telegram);
    const callApi = telegram.callApi.bind(telegram);
    telegram.callApi = async (method, payload, options) => {
        // The runner already owns polling/startup deadlines and shutdown cancellation.
        if (['getMe', 'deleteWebhook', 'getUpdates'].includes(method)) return callApi(method, payload, options);
        const timeout = /^send(Photo|Document|Video|Audio|Animation|MediaGroup)$/.test(method) ? 60000 : 20000;
        const controller = new AbortController();
        const upstream = options?.signal;
        const abort = () => controller.abort();
        if (upstream?.aborted) abort();
        else upstream?.addEventListener('abort', abort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
        try {
            return await callApi(method, payload, { ...options, signal: controller.signal });
        } catch (error) {
            // Never retry a send: Telegram might already have accepted it.
            if (timedOut) throw new Error(`Telegram ${method} timeout setelah ${timeout / 1000} detik`);
            throw error;
        } finally {
            clearTimeout(timer);
            upstream?.removeEventListener('abort', abort);
        }
    };
};
