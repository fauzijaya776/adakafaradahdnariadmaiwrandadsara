// qris_pakasir.js
// Integrasi Payment Gateway Pakasir (https://pakasir.com/p/docs)
// Metode pembayaran: QRIS saja.
// Menggantikan gateway lama (DompetX). Kredensial diambil dari .env:
//   PAKASIR_PROJECT  -> slug project di dashboard Pakasir (mis. "do_10drop")
//   PAKASIR_API_KEY  -> API key di setting project Pakasir
require("dotenv").config();
const axios = require("axios");

const PAKASIR_BASE = "https://app.pakasir.com/api";

function getCreds() {
  const project = process.env.PAKASIR_PROJECT;
  const api_key = process.env.PAKASIR_API_KEY;
  if (!project) throw new Error("PAKASIR_PROJECT (slug project) belum diisi di .env");
  if (!api_key) throw new Error("PAKASIR_API_KEY belum diisi di .env");
  return { project, api_key };
}

/**
 * Membuat transaksi QRIS baru di Pakasir.
 * @param {string} internalOrderId  ID order internal kita, dipakai sebagai order_id Pakasir.
 * @param {number} amount           Nominal dasar (Rp) yang diterima merchant.
 * @returns {object} { displayOrderId, realOrderId, qrString, qrImage, amount, totalBayar, fee, expiredAt }
 */
async function createTransaction(internalOrderId, amount) {
  const { project, api_key } = getCreds();

  const nominalAmount = parseInt(amount);
  if (isNaN(nominalAmount) || nominalAmount <= 0) {
    throw new Error("Amount harus berupa angka positif");
  }

  const body = {
    project: project,
    order_id: String(internalOrderId),
    amount: nominalAmount,
    api_key: api_key,
  };

  try {
    const response = await axios({
      method: "post",
      maxBodyLength: Infinity,
      url: `${PAKASIR_BASE}/transactioncreate/qris`,
      headers: { "Content-Type": "application/json" },
      data: body,
    });

    const payment = response.data && response.data.payment;
    if (!payment) {
      throw new Error("Response Pakasir tidak berisi objek 'payment'.");
    }
    // Untuk QRIS, payload string QRIS umumnya di 'payment_number'.
    // Sertakan beberapa nama field alternatif untuk berjaga-jaga.
    const qrString =
      payment.payment_number ||
      payment.qr_string ||
      payment.qris ||
      payment.qrString ||
      payment.qr;
    if (!qrString) {
      throw new Error("Pakasir tidak mengembalikan QRIS (payment_number).");
    }

    return {
      displayOrderId: String(internalOrderId),
      // Pakasir tidak memakai transaction id terpisah -> order_id adalah referensinya.
      realOrderId: payment.order_id || String(internalOrderId),
      qrString: qrString,
      qrImage: null, // di-generate dari qrString oleh pemanggil (QRCode.toDataURL)
      amount: payment.amount != null ? payment.amount : nominalAmount, // nominal dasar
      totalBayar: payment.total_payment != null ? payment.total_payment : nominalAmount, // yang dibayar customer
      fee: payment.fee != null ? payment.fee : 0,
      expiredAt: payment.expired_at,
    };
  } catch (error) {
    if (error.response) {
      console.error("[PAKASIR CREATE ERROR]", {
        status: error.response.status,
        data: error.response.data,
      });
      const raw =
        typeof error.response.data === "object"
          ? JSON.stringify(error.response.data)
          : String(error.response.data);
      // Sertakan status + body mentah agar penyebab asli terlihat (bukan pesan generik).
      throw new Error(`Pakasir API Error (HTTP ${error.response.status}): ${raw}`);
    }
    console.error("[PAKASIR CREATE ERROR]", error.message);
    throw error;
  }
}

/**
 * Cek status transaksi QRIS di Pakasir.
 * @param {string} orderId  order_id transaksi (sama dengan internalOrderId).
 * @param {number} amount   nominal dasar transaksi (wajib oleh Pakasir).
 * @returns {object|null} response mentah Pakasir: { transaction: { status, ... } }, atau null saat error.
 */
async function checkPaymentStatus(orderId, amount) {
  const { project, api_key } = getCreds();

  try {
    const response = await axios.get(`${PAKASIR_BASE}/transactiondetail`, {
      params: {
        project: project,
        amount: parseInt(amount),
        order_id: String(orderId),
        api_key: api_key,
      },
    });
    return response.data; // { transaction: { amount, order_id, project, status, payment_method, completed_at } }
  } catch (error) {
    if (error.response) {
      console.error("[PAKASIR CHECK ERROR]", {
        status: error.response.status,
        data: error.response.data,
      });
    } else {
      console.error("[PAKASIR CHECK ERROR]", error.message);
    }
    return null;
  }
}

/**
 * Membatalkan transaksi QRIS di Pakasir (opsional; tidak semua akun mendukung).
 */
async function cancelTransaction(orderId, amount) {
  const { project, api_key } = getCreds();
  try {
    const response = await axios({
      method: "post",
      url: `${PAKASIR_BASE}/transactioncancel`,
      headers: { "Content-Type": "application/json" },
      data: {
        project: project,
        order_id: String(orderId),
        amount: parseInt(amount),
        api_key: api_key,
      },
    });
    return response.data;
  } catch (error) {
    // Pembatalan sisi Pakasir bersifat best-effort; status order tetap diurus di DB kita.
    console.error("[PAKASIR CANCEL ERROR]", error.response ? error.response.data : error.message);
    return null;
  }
}

module.exports = {
  init: async () => console.log("[ Pakasir QRIS Payment System Initialized ]"),
  createTransaction,
  checkPaymentStatus,
  cancelTransaction,
};
