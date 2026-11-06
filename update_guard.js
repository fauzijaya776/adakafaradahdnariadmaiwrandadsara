'use strict';

module.exports = function createUpdateGuard({ isOwner, onError }) {
    const users = new Map();
    const busy = new Set();
    const regular = { active: 0, limit: 8, queueLimit: 24, queue: [] };
    const owner = { active: 0, limit: 2, queueLimit: 8, queue: [] };
    let dropped = 0;
    let stopped = false;
    let lastNoticeAt = 0;

    function release(key) {
        const count = users.get(key) - 1;
        if (count) users.set(key, count);
        else users.delete(key);
    }
    function run(job, lane) {
        lane.active++;
        busy.add(job.key);
        Promise.resolve().then(job.next)
            .catch(error => onError(error, job.ctx))
            .catch(error => console.error('[BOT] Error handler gagal:', error.message))
            .finally(() => {
                lane.active--;
                busy.delete(job.key);
                release(job.key);
                while (!stopped && lane.active < lane.limit) {
                    const index = lane.queue.findIndex(next => !busy.has(next.key));
                    if (index === -1) break;
                    run(lane.queue.splice(index, 1)[0], lane);
                }
            });
    }
    return {
        dispatch(ctx, next) {
            if (stopped) return;
            const key = String(ctx.from?.id || ctx.chat?.id || 'channel');
            const lane = isOwner(ctx) ? owner : regular;
            const canRun = lane.active < lane.limit && !busy.has(key);
            if ((users.get(key) || 0) >= 2 || (!canRun && lane.queue.length >= lane.queueLimit)) {
                dropped++;
                // No per-update rejection send: that would turn a flood into more API requests.
                if (Date.now() - lastNoticeAt > 2000 && ctx.callbackQuery) {
                    lastNoticeAt = Date.now();
                    Promise.resolve().then(() => ctx.answerCbQuery('Bot sedang sibuk. Coba lagi sebentar.', { show_alert: true })).catch(() => {});
                }
                return;
            }
            users.set(key, (users.get(key) || 0) + 1);
            const job = { ctx, next, key };
            if (canRun) run(job, lane);
            else lane.queue.push(job);
        },
        stats() {
            return { active: regular.active + owner.active, queued: regular.queue.length + owner.queue.length, dropped };
        },
        stop() {
            stopped = true;
            for (const lane of [regular, owner]) {
                for (const job of lane.queue.splice(0)) release(job.key);
            }
        },
    };
};
