// qris_dana.js
require("dotenv").config();
const axios = require("axios");
const QRCode = require("qrcode");

const API_URL = "http://localhost:3000";
const QRIS_ENDPOINT = "https://qris-statis-to-dinamis.vercel.app/generate-qris";
const BASE_QRIS_CODE = process.env.DANA_BASE_QRIS_CODE;

async function createDanaPayment(orderId, amount) {
  const url = `${API_URL}/api/create-payment`;
  const data = { orderId, amount: parseInt(amount, 10) };
  try {
    const response = await axios.post(url, data);
    return { success: true, ...response.data };
  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error("Error creating DANA payment:", errorMessage);
    throw new Error(`Gagal mendaftarkan pembayaran DANA: ${errorMessage}`);
  }
}

async function checkDanaPaymentStatus(orderId) {
  const url = `${API_URL}/api/check-status/${orderId}`;
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    // Mengembalikan status pending jika ada error koneksi agar polling berlanjut
    if (error.code === 'ECONNRESET' || error.response === undefined) {
        //console.error("Error checking DANA payment status (Connection):", error.message);
        return { status: "pending" };
    }
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error("Error checking DANA payment status (Server):", errorMessage);
    return { status: "pending" }; 
  }
}

async function cancelDanaPayment(orderId) {
  const url = `${API_URL}/api/cancel-order`;
  const data = { orderId };
  try {
    const response = await axios.post(url, data);
    console.log(`DANA payment cancellation successful for ${orderId}`);
    return { success: true, ...response.data };
  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error(`Error cancelling DANA payment for ${orderId}:`, errorMessage);
    // Tidak melempar error agar proses pembatalan di sisi bot tetap berjalan
  }
}

async function generateDanaQris(finalNominal) {
  // --- PERUBAHAN DI SINI ---
  // Payload disederhanakan, kita hanya mengirim nominal akhir yang sudah dihitung.
  const payload = {
    fee: "1",                 // Set fee ke 0
    feeType: "p",             // Tipe fee (persen), tidak berpengaruh karena fee 0
    includeFee: true,         // Tetap true, API akan menghitung: finalNominal + 0%
    nominal: String(finalNominal), // Gunakan nominal akhir yang sudah dihitung
    qrisCode: BASE_QRIS_CODE,
  };
  // --- AKHIR PERUBAHAN ---

  const headers = { "content-type": "application/json", accept: "*/*" };

  try {
    const res = await axios.post(QRIS_ENDPOINT, payload, { headers, timeout: 15000 });
    if (!res.data || !res.data.output) {
      throw new Error("Response tidak valid dari generator QRIS.");
    }
    const qrString = res.data.output;
    const qrImageBuffer = await QRCode.toBuffer(qrString, {
      type: "png",
      errorCorrectionLevel: "M",
      width: 512,
      margin: 2,
    });
    return qrImageBuffer;
  } catch (error) {
    console.error("Error generating DANA QRIS:", error.message);
    throw new Error("Gagal membuat gambar QRIS DANA.");
  }
}

module.exports = {
  createDanaPayment,
  checkDanaPaymentStatus,
  generateDanaQris,
  cancelDanaPayment,
};