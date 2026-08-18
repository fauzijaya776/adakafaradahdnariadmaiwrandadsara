require("dotenv").config();
const axios = require("axios");
const {
  Order
} = require("./db");
const qs = require('qs');
const QRCode = require('qrcode');
const crypto = require('crypto');

async function createTransaction(internalOrderId, amount) {
  const api_key = process.env.API_KEY_DOMPETX;
  if (!api_key) throw new Error("API_KEY_DOMPETX is required");

  const nominalAmount = parseInt(amount);
  if (isNaN(nominalAmount) || nominalAmount <= 0) {
    throw new Error("Amount harus berupa angka positif");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    method: "QRIS",
    amount: nominalAmount,
    currency: "IDR",
    reference: internalOrderId
  });

  const signature = crypto
    .createHmac("sha256", api_key)
    .update(timestamp + "." + body)
    .digest("hex");

  try {
    const response = await axios({
      method: "post",
      maxBodyLength: Infinity,
      url: "https://api.dompetx.com/v1/payments",
      headers: {
        "X-DOMPAY-API-Key": api_key,
        "X-DOMPAY-Signature": signature,
        "X-DOMPAY-Timestamp": timestamp,
        "Idempotency-Key": "req_" + Date.now(),
        "Content-Type": "application/json"
      },
      data: body
    });

    const result = response.data;

    return {
      displayOrderId: internalOrderId,
      realOrderId: result.id,
      qrString: result.qrData?.qrString,
      qrImage: result.qrData?.qrImage,
      amount: result.getBalance,
      totalBayar: result.totalAmount,
      fee: result.fee + (result.additionalFee || 0),
      expiredAt: result.expiresAt,
    };

  } catch (error) {
    if (error.response) {
      console.error("[DOMPETX CREATE ERROR]", {
        status: error.response.status,
        data: error.response.data
      });
      throw new Error(error.response.data?.message || "DompetX API Error");
    }
    console.error("[DOMPETX CREATE ERROR]", error.message);
    throw error;
  }
}

async function checkPaymentStatus(transactionId) {
  const api_key = process.env.API_KEY_DOMPETX;
  if (!api_key) throw new Error("API_KEY_DOMPETX is required");

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac("sha256", api_key)
    .update(timestamp + ".{}")
    .digest("hex");

  console.log("[DOMPETX CHECK] transactionId:", transactionId);

  try {
    const response = await axios.get(
      `https://api.dompetx.com/v1/payments/check-status/${transactionId}`,
      {
        headers: {
          "X-DOMPAY-API-Key": api_key,
          "X-DOMPAY-Signature": signature,
          "X-DOMPAY-Timestamp": timestamp
        }
      }
    );

    console.log("[DOMPETX CHECK] Response:", JSON.stringify(response.data, null, 2));
    return response.data;

  } catch (error) {
    if (error.response) {
      console.error("[DOMPETX CHECK ERROR]", {
        status: error.response.status,
        data: error.response.data
      });
    } else {
      console.error("[DOMPETX CHECK ERROR]", error.message);
    }
    return null;
  }
}

async function createOrder(internalOrderId, amount, orderDetails, customerInfo) {
  const api_key = process.env.API_KEY_ATLANTIC;

  if (!api_key) {
    throw new Error("API_KEY_ATLANTIC is required");
  }

  const nominalAmount = parseInt(amount);
  if (isNaN(nominalAmount) || nominalAmount <= 0) {
    throw new Error("Amount harus berupa angka positif");
  }

  const data = qs.stringify({
    api_key: api_key,
    reff_id: internalOrderId,
    nominal: nominalAmount.toString(),
    type: "ewallet",
    metode: "qris"
  });

  const config = {
    method: 'post',
    maxBodyLength: Infinity,
    url: 'https://atlantich2h.com/deposit/create',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    data: data
  };

  console.log("Request to Atlantic:", {
    reff_id: internalOrderId,
    nominal: nominalAmount
  });

  try {
    const response = await axios(config);
    console.log("Atlantic Response:", JSON.stringify(response.data, null, 2));

    const result = response.data;

    if (!result.status || result.status !== true) {
      throw new Error(result.message || "AtlanticH2H API Error");
    }

    const paymentData = result.data;

    const totalBayar = parseInt(paymentData.nominal) + parseInt(paymentData.tambahan || 0) + parseInt(paymentData.fee || 0);
    const totalDiterima = parseInt(paymentData.get_balance);
    const fee = totalBayar - totalDiterima;

    console.log("Generating QR from qrString...");

    const qrDataURL = await QRCode.toDataURL(paymentData.qr_string, {
      type: 'image/png',
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    return {
      qrImage: qrDataURL,
      displayOrderId: internalOrderId,
      realOrderId: paymentData.id,
      amount: totalDiterima,
      totalBayar: totalBayar,
      totalDiterima: totalDiterima,
      fee: fee,
      expiredAt: paymentData.expired_at,
      qrString: paymentData.qr_string
    };

  } catch (error) {
    if (error.response) {
      console.error("Atlantic API Error:", {
        status: error.response.status,
        data: error.response.data
      });
      throw new Error(error.response.data?.message || "AtlanticH2H API Error");
    }
    console.error("Error:", error.message);
    throw error;
  }
}

async function createTransfer({
  refId,
  kodeBank,
  nomorAkun,
  namaPemilik,
  nominal,
  email,
  phone,
  note
}) {
  const api_key = process.env.API_KEY_ATLANTIC;
  if (!api_key) {
    throw new Error("API_KEY_ATLANTIC is required");
  }

  if (!refId || !kodeBank || !nomorAkun || !namaPemilik || !nominal) {
    throw new Error("refId, kodeBank, nomorAkun, namaPemilik, dan nominal wajib diisi");
  }

  const nominalInt = parseInt(nominal);
  if (isNaN(nominalInt) || nominalInt <= 0) {
    throw new Error("Nominal harus berupa angka positif");
  }

  const data = qs.stringify({
    api_key: api_key,
    ref_id: refId,
    kode_bank: kodeBank,
    nomor_akun: String(nomorAkun),
    nama_pemilik: String(namaPemilik),
    nominal: String(nominalInt),
    email: email || '',
    phone: phone || '',
    note: note || ''
  });

  const config = {
    method: 'post',
    maxBodyLength: Infinity,
    url: 'https://atlantich2h.com/transfer/create',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    data: data
  };

  console.log("[ATLANTIC TRANSFER] Request:", {
    ref_id: refId,
    kode_bank: kodeBank,
    nomor_akun: nomorAkun,
    nominal: nominalInt
  });

  try {
    const response = await axios(config);
    console.log("[ATLANTIC TRANSFER] Response:", JSON.stringify(response.data, null, 2));

    const res = response.data;

    if (res && (res.status === true || res.success === true || res.code === 200)) {
      return {
        success: true,
        data: res.data || res,
        message: res.message || "Transfer request created"
      };
    }

    return {
      success: false,
      data: res,
      message: res.message || "Transfer request failed"
    };

  } catch (error) {
    console.error("[ATLANTIC TRANSFER ERROR]", error.response?.data || error.message);
    const errPayload = error.response?.data || { message: error.message };
    return {
      success: false,
      data: errPayload,
      message: errPayload.message || "Atlantic transfer error"
    };
  }
}

async function getProfile() {
  const api_key = process.env.API_KEY_ATLANTIC;
  if (!api_key) {
    throw new Error("API_KEY_ATLANTIC is required");
  }

  const data = qs.stringify({
    api_key: api_key
  });

  try {
    const response = await axios.post(
      "https://atlantich2h.com/get_profile",
      data,
      {
        maxBodyLength: Infinity,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    console.log("[ATLANTIC PROFILE] Response:", JSON.stringify(response.data, null, 2));
    const res = response.data;

    if (res && (res.status === true || res.success === true)) {
      return {
        success: true,
        data: res.data || res,
        message: res.message || "Profile fetched"
      };
    }

    return {
      success: false,
      data: res,
      message: res.message || "Failed to get profile"
    };

  } catch (err) {
    console.error("[ATLANTIC PROFILE ERROR]", err.response?.data || err.message);
    const payload = err.response?.data || { message: err.message };
    return {
      success: false,
      data: payload,
      message: payload.message || "Atlantic profile error"
    };
  }
}

async function updateStokKeLaravel(sku, items) {}

// exports
module.exports = {
  init: async () => console.log("[ Tokopay Payment System Initialized (URL Method) ]"),
  createTransaction,
  createOrder,
  checkPaymentStatus,
  createTransfer,
  getProfile,
  updateStokKeLaravel,
};
