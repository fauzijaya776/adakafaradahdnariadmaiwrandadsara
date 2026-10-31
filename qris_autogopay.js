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
async function request(path, body, timeout = 20000, { statusEnvelope = false } = {}) {
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
    // /qris/status membalas success:false untuk SEMUA transaksi yang belum lunas, mis.
    // {"success":false,"message":"Transaction status: expire","data":{"transaction_status":"expire",...}}.
    // Hanya settlement yang success:true. Jadi untuk cek status, data.transaction_status yang dibaca;
    // kalau ini ditolak, status pending/expire tidak pernah terlihat dan order tertahan selamanya.
    if (statusEnvelope && envelope && envelope.data && typeof envelope.data.transaction_status === 'string') {
        return envelope.data;
    }
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
const QR_LIFETIME_MS = 15 * 60 * 1000;
const MAX_EXPIRY_MS = 20 * 60 * 1000;
function expiryDate(value, now = Date.now()) {
    // Dokumentasi menyebut WIB, tetapi API /qris/* nyatanya memakai UTC+8: transaksi yang sama
    // tercatat 16:01:37 di /transactions (WIB) dan 17:01:37 di /qris/status. Jadi stempel waktu
    // tanpa zona dicoba sebagai +08:00 lalu +07:00; yang jatuh dalam jendela wajar QRIS dipakai.
    // Kalau tidak ada yang cocok, JANGAN gagal: invoice sudah terbuat di provider, jadi gagal di sini
    // hanya membuat QRIS tidak tampil dan order tertahan. Pakai umur standar 15 menit; status
    // sebenarnya tetap diverifikasi ke API (polling + sweeper) sebelum stok dilepas.
    const text = String(value || '').trim();
    const local = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text);
    const candidates = local ? ['+08:00', '+07:00'].map(z => text.replace(' ', 'T') + z) : [text];
    for (const iso of candidates) {
        const time = Date.parse(iso);
        if (Number.isFinite(time) && time > now && time <= now + MAX_EXPIRY_MS) return new Date(time);
    }
    console.warn('[AUTOGOPAY] expiry_time tidak wajar, memakai 15 menit:', JSON.stringify(value));
    return new Date(now + QR_LIFETIME_MS);
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
    const data = await request('/qris/status', { transaction_id: txnId }, 6000, { statusEnvelope: true });
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
