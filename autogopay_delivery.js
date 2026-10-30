'use strict';
// A Telegram send and a MongoDB commit cannot be one atomic transaction.
// Ambiguous sends go to REVIEW instead of automatically sending credentials twice.
module.exports = function createDelivery({ Order, telegram, formatItemsForFile, onDelivered, onReview }) {
    async function notifyReview(order) {
        if (!order || order.reviewNotifiedAt) return;
        await onReview(order, order.deliveryReviewReason || order.paymentReviewReason || 'Perlu pemeriksaan admin.');
        await Order.updateOne({ orderId: order.orderId }, { $set: { reviewNotifiedAt: new Date() } });
    }
    async function deliver(order) {
        const claimed = await Order.findOneAndUpdate({ orderId: order.orderId,
            paymentGateway: 'autogopay', status: 'PAID', delivered: { $ne: true },
            $or: [{ deliveryState: 'READY' }, { deliveryState: 'RETRY', deliveryRetryAt: { $lte: new Date() } }],
        }, { $set: { deliveryState: 'SENDING', deliveryStartedAt: new Date() }, $inc: { deliveryAttempts: 1 } }, { new: true });
        if (!claimed) return false;
        if (!claimed.customerInfo?.telegramUserId || claimed.reservedItems?.length !== claimed.quantity) {
            await Order.updateOne({ orderId: claimed.orderId }, { $set: { deliveryState: 'REVIEW',
                deliveryReviewReason: 'Penerima atau jumlah akun tidak valid.' } });
            return false;
        }
        let receipt;
        try {
            // One plain-text document contains the complete purchase. No Markdown fallback send.
            const content = await formatItemsForFile(claimed.reservedItems, claimed);
            receipt = await telegram.sendDocument(claimed.customerInfo.telegramUserId,
                { source: Buffer.from(content, 'utf8'), filename: `akun_${claimed.orderId}.txt` },
                { caption: `Pembelian berhasil\nOrder: ${claimed.orderId}\nJumlah: ${claimed.quantity}\nTotal: Rp ${claimed.totalPaid || claimed.amount}\nSimpan file akun ini.` });
        } catch (error) {
            const code = error.response?.error_code;
            const retry = code === 429 && claimed.deliveryAttempts < 3;
            const seconds = Math.max(30, Math.min(3600, Number(error.response?.parameters?.retry_after) || 60));
            await Order.updateOne({ orderId: claimed.orderId }, { $set: {
                deliveryState: retry ? 'RETRY' : 'REVIEW',
                deliveryRetryAt: new Date(Date.now() + seconds * 1000),
                deliveryReviewReason: retry ? 'Telegram membatasi request; menunggu jeda.' :
                    'Telegram menolak atau hasil pengiriman tidak pasti. Periksa chat sebelum mengirim ulang akun yang sama.',
            } });
            return false;
        }
        // If this write fails, SENDING survives. Recovery asks for manual verification, not re-send.
        await Order.updateOne({ orderId: claimed.orderId, deliveryState: 'SENDING' }, {
            $set: { delivered: true, deliveredAt: new Date(), deliveryState: 'DELIVERED', deliveryMessageId: receipt.message_id },
        });
        await onDelivered(claimed);
        return true;
    }
    async function recover() {
        await Order.updateMany({ paymentGateway: 'autogopay', deliveryState: 'SENDING', delivered: { $ne: true },
            deliveryStartedAt: { $lt: new Date(Date.now() - 5 * 60000) } }, { $set: {
                deliveryState: 'REVIEW', deliveryReviewReason: 'Bot terhenti saat mengirim akun. Periksa chat; jangan kirim ulang tanpa verifikasi.',
            } });
        const reviews = await Order.find({ paymentGateway: 'autogopay', reviewNotifiedAt: { $exists: false },
            $or: [{ deliveryState: 'REVIEW' }, { paymentReviewAt: { $exists: true } }] }).limit(20).lean();
        for (const order of reviews) await notifyReview(order);
        const pending = await Order.find({ paymentGateway: 'autogopay', status: 'PAID', delivered: { $ne: true },
            $or: [{ deliveryState: 'READY' }, { deliveryState: 'RETRY', deliveryRetryAt: { $lte: new Date() } }] }).limit(20).lean();
        for (const order of pending) await deliver(order);
    }
    return { deliver, recover };
};
