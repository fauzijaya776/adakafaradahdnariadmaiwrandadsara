'use strict';
const axios = require('axios');
const crypto = require('crypto');

// Fixed origin: credentials must only be sent to AutoGoPay.
const BASE_URL = 'https://v1-gateway.autogopay.site';
let backoffUntil = 0;
const statusFlights = new Map();
function apiKey() {
    const key = process.env.AUTOGOPAY_API_KEY;
    if (!key) throw new Error('AUTOGOPAY_API_KEY belum diatur di environment server.');
    return key;
}
async function request(path, body, timeout = 20000) {
    if (Date.now() < backoffUntil) throw new Error('AutoGoPay sedang dalam jeda pemulihan; jangan membuat ulang QRIS.');
    let response;
    try {
        response = await axios.post(BASE_URL + path, body, {
            headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
            timeout,
            maxRedirects: 0,
        });
    } catch (error) {
        const status = error.response?.status;
        if (status === 429 || status === 403 || status === 401) backoffUntil = Date.now() + 60000;
        else backoffUntil = Date.now() + 15000;
        // Never expose Axios errors/config: they contain the Authorization header.
        throw new Error('AutoGoPay tidak dapat dihubungi. Cek dashboard sebelum membuat QRIS lagi.');
    }
    const envelope = response.data;
    if (!envelope || envelope.success !== true || !envelope.data) {
        throw new Error('AutoGoPay menolak request. Cek koneksi merchant/langganan di dashboard.');
    }
    return envelope.data;
}
function normalizeStatus(data) {
    const status = String(data.transaction_status || data.status || '').toLowerCase();
    return ({ settlement: 'completed', paid: 'completed', success: 'completed',
        expire: 'expired', expired: 'expired', cancel: 'cancelled', cancelled: 'cancelled',
        pending: 'pending' })[status] || 'unknown';
}
function expiryDate(value, now = Date.now()) {
    // API timestamps are WIB, not the timezone of the hosting server.
    const text = String(value || '');
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
        ? text.replace(' ', 'T') + '+07:00' : text;
    const time = Date.parse(iso);
    if (!Number.isFinite(time) || time <= now || time > now + 20 * 60 * 1000) {
        throw new Error('AutoGoPay mengembalikan waktu kedaluwarsa tidak valid. Cek dashboard.');
    }
    return new Date(time);
}
async function createTransaction(orderId, amount, onCreated) {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000000) {
        throw new Error('Nominal QRIS harus bulat antara Rp 1 dan Rp 10.000.000.');
    }
    // No retry: a timed-out generate request might already have created an invoice.
    const data = await request('/qris/generate', { amount });
    if (data.transaction_id && data.order_id && onCreated) {
        const identity = { txnId: String(data.transaction_id), realOrderId: String(data.order_id), qrString: data.qr_string };
        try { await onCreated(identity); }
        catch (_) {
            const error = new Error(`Invoice provider sudah dibuat tetapi penyimpanan gagal. transaction_id=${identity.txnId}; order_id=${identity.realOrderId}`);
            error.providerIdentity = identity;
            throw error;
        }
    }
    if (!data.transaction_id || !data.order_id || !data.qr_string || Number(data.amount) !== amount) {
        throw new Error('Respons invoice AutoGoPay tidak lengkap atau nominal tidak cocok. Cek dashboard.');
    }
    return { txnId: String(data.transaction_id), realOrderId: String(data.order_id),
        qrString: data.qr_string, amount, totalBayar: amount, fee: 0,
        expiresAt: expiryDate(data.expiry_time) };
}
async function fetchPaymentStatus(txnId) {
    if (!txnId) throw new Error('ID transaksi AutoGoPay tidak tersedia.');
    const data = await request('/qris/status', { transaction_id: txnId }, 6000);
    // Some status responses omit the ID; an explicitly different ID is never accepted.
    if (data.transaction_id && String(data.transaction_id) !== String(txnId)) {
        throw new Error('ID transaksi AutoGoPay tidak cocok.');
    }
    return { status: normalizeStatus(data), amount: data.amount, transactionId: txnId, providerOrderId: data.order_id };
}
async function checkPaymentStatus(txnId) {
    if (statusFlights.has(txnId)) return statusFlights.get(txnId);
    const flight = fetchPaymentStatus(txnId).finally(() => statusFlights.delete(txnId));
    statusFlights.set(txnId, flight);
    return flight;
}
async function cancelTransaction(txnId) {
    return request('/qris/cancel', { transaction_id: txnId });
}
function verifySignature(rawBody, signature) {
    if (!process.env.AUTOGOPAY_API_KEY || !Buffer.isBuffer(rawBody) ||
        typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
    const expected = crypto.createHmac('sha256', apiKey()).update(rawBody).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
module.exports = { createTransaction, checkPaymentStatus, cancelTransaction, verifySignature,
    normalizeStatus, expiryDate };
