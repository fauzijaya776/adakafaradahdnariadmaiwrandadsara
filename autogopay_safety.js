'use strict';

// Durable controls for this merchant integration. No money-moving API calls here.
module.exports = function createSafety({ mongoose, Order, Product, User, Settings }) {
    const policy = {
        cooldownMs: 60000,
        hourlyMax: 20,
        dailyMax: 100,
    }; // Conservative local policy, not official GoPay rate limits.
    async function transaction(work) {
        const session = await mongoose.startSession();
        try {
            let result;
            await session.withTransaction(async () => { result = await work(session); });
            return result;
        } finally { await session.endSession(); }
    }
    async function claimGeneration(orderId, buyerId, session, now = new Date()) {
        let settings = await Settings.findOne({ identifier: 'global-settings' }).session(session);
        if (!settings) settings = new Settings({ identifier: 'global-settings' });
        if (settings.autogopayActiveOrder) throw new Error('Merchant masih memiliki invoice yang belum selesai. Tunggu atau hubungi admin.');
        if (settings.autogopayCircuitOpen) throw new Error('Pembuatan QRIS dihentikan sementara. Admin harus memeriksa provider.');
        if (settings.autogopayNextGenerateAt && settings.autogopayNextGenerateAt > now) {
            throw new Error('Mohon tunggu jeda pembuatan QRIS merchant (60 detik).');
        }
        const hour = Math.floor(now.getTime() / 3600000);
        const day = Math.floor(now.getTime() / 86400000);
        const hourCount = settings.autogopayHour === hour ? settings.autogopayHourCount || 0 : 0;
        const dayCount = settings.autogopayDay === day ? settings.autogopayDayCount || 0 : 0;
        if (hourCount >= policy.hourlyMax || dayCount >= policy.dailyMax) {
            throw new Error('Batas pembuatan QRIS merchant tercapai. Hubungi admin.');
        }
        settings.autogopayActiveOrder = orderId;
        settings.autogopayNextGenerateAt = new Date(now.getTime() + policy.cooldownMs);
        settings.autogopayHour = hour; settings.autogopayHourCount = hourCount + 1;
        settings.autogopayDay = day; settings.autogopayDayCount = dayCount + 1;
        await settings.save({ session });
    }
    async function releaseGate(orderId, session, notBefore) {
        await Settings.updateOne({ identifier: 'global-settings', autogopayActiveOrder: orderId },
            { $unset: { autogopayActiveOrder: '' }, ...(notBefore ? { $max: { autogopayNextGenerateAt: notBefore } } : {}) }, { session });
    }
    async function flagReview(orderId, reason) {
        // A timeout is ambiguous: retain inventory and the merchant gate until resolved.
        await Order.updateOne({ orderId, paymentGateway: 'autogopay', status: 'PENDING' }, {
            $set: { paymentReviewReason: reason, paymentReviewAt: new Date() }, $unset: { expiresAt: '' },
        });
        await Settings.updateOne({ identifier: 'global-settings' }, { $set: { autogopayCircuitOpen: true } });
    }
    function variantFor(product, order) {
        return product && product.variants.find(v => v.slug === order.variantSlug);
    }
    function heldItems(order, variant) {
        const items = Array.from(order.reservedItems || []);
        return variant && items.length === order.quantity && new Set(items).size === items.length &&
            items.every(item => variant.reserved_stock.includes(item) && !variant.stock.includes(item));
    }
    async function expire(orderId, terminalStatus) {
        if (!['expired', 'cancelled'].includes(terminalStatus)) throw new Error('Status terminal provider wajib terverifikasi.');
        return transaction(async session => {
            const order = await Order.findOne({ orderId, paymentGateway: 'autogopay' }).session(session);
            if (!order || order.status !== 'PENDING') return false;
            const product = await Product.findOne({ id: order.productId }).session(session);
            const variant = variantFor(product, order);
            if (!heldItems(order, variant)) throw new Error('Reservasi stok tidak cocok; perlu pemeriksaan admin.');
            const items = Array.from(order.reservedItems);
            variant.reserved_stock = variant.reserved_stock.filter(item => !items.includes(item));
            variant.stock.push(...items);
            order.status = terminalStatus === 'cancelled' ? 'CANCELLED' : 'EXPIRED';
            order.inventoryState = 'RELEASED';
            order.providerTerminalAt = new Date();
            // Keep the paid/cancelled audit trail. No TTL on unresolved or protected orders.
            order.expiresAt = undefined; order.activeBuyerKey = undefined;
            await product.save({ session }); await order.save({ session });
            // Documentation allows a new QR only after success or expiry. Cancellation
            // alone does not shorten the merchant cooldown to the old invoice expiry.
            const notBefore = terminalStatus === 'cancelled'
                ? (order.autogopayExpiresAt || new Date(new Date(order.createdAt || Date.now()).getTime() + 20 * 60000))
                : undefined;
            await releaseGate(orderId, session, notBefore);
            return true;
        });
    }
    async function settle(orderId) {
        return transaction(async session => {
            const order = await Order.findOne({ orderId, paymentGateway: 'autogopay' }).session(session);
            if (!order) throw new Error('Pesanan AutoGoPay tidak ditemukan.');
            if (order.status === 'PAID') return order;
            const product = await Product.findOne({ id: order.productId }).session(session);
            const variant = variantFor(product, order);
            let items;
            if (order.inventoryState === 'HELD' && heldItems(order, variant)) {
                items = Array.from(order.reservedItems);
                variant.reserved_stock = variant.reserved_stock.filter(item => !items.includes(item));
            } else if (order.inventoryState === 'RELEASED' && variant && variant.stock.length >= order.quantity) {
                // Late payment: allocate fresh inventory; never send released credentials blindly.
                items = variant.stock.slice(0, order.quantity);
                if (new Set(items).size !== order.quantity || items.some(i => variant.reserved_stock.includes(i))) items = null;
                else variant.stock.splice(0, order.quantity);
            }
            if (!order.reservationAudit) order.reservationAudit = Array.from(order.reservedItems || []);
            order.reservedItems = items || [];
            order.inventoryState = items ? 'SOLD' : 'REVIEW';
            order.deliveryState = items ? 'READY' : 'REVIEW';
            order.deliveryReviewReason = items ? undefined : 'Pembayaran diterima; stok perlu ditangani admin atau refund manual.';
            order.status = 'PAID'; order.paidAt = new Date();
            order.expiresAt = undefined; order.activeBuyerKey = undefined;
            // Order + inventory + customer accounting commit together or all roll back.
            if (items) await product.save({ session });
            await User.updateOne({ id: order.customerInfo.telegramUserId }, { $inc: { totalSpent: order.amount } }, { session });
            await order.save({ session }); await releaseGate(orderId, session);
            return order;
        });
    }
    return { claimGeneration, expire, settle, flagReview, policy };
};
