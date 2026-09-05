// qris_linkqu.js (FINAL - MongoDB Ready)
require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");
const moment = require("moment-timezone");
// REVISI: Impor Model 'Order' dari Mongoose, bukan file-based DB
const { Order , slimPaymentDetails } = require('./db');

function createSignature({
    path,
    method,
    amount,
    expired,
    partner_reff,
    customer_id,
    customer_name,
    customer_email = "",
    client_id,
    signature_key,
}) {
    const nonAlnum = /[^0-9a-zA-Z]/g;
    const second = `${amount}${expired}${partner_reff}${customer_id}${customer_name}${customer_email}${client_id}`;
    const secondClean = second.replace(nonAlnum, "").toLowerCase();
    const signToString = `${path}${method}${secondClean}`;

    return crypto
        .createHmac("sha256", signature_key)
        .update(signToString)
        .digest("hex");
}

async function createOrder(
    internalOrderId,
    amount,
    orderDetails,
    customerInfo,
    couponCode = null
) {
    const { telegramUserId, first_name } = customerInfo;
    const path = "/transaction/create/qris";
    const method = "POST";
    const expired = moment()
        .tz("Asia/Jakarta")
        .add(3, "minutes")
        .format("YYYYMMDDHHmmss");

    const signature = createSignature({
        path: path,
        method: method,
        amount: String(amount),
        expired: expired,
        partner_reff: String(internalOrderId),
        customer_id: String(telegramUserId),
        customer_name: String(first_name),
        customer_email: "",
        client_id: process.env.CLIENT_ID_LINKQU,
        signature_key: process.env.SIGNATURE_LINKQU,
    });

    const params = {
        amount: amount,
        partner_reff: internalOrderId,
        customer_id: telegramUserId,
        customer_name: first_name,
        customer_email: "",
        expired: expired,
        username: process.env.USERNAME_LINKQU,
        pin: process.env.PIN_LINKQU,
        signature: signature,
    };

    const headers = {
        "Content-Type": "application/json",
        "client-id": process.env.CLIENT_ID_LINKQU,
        "client-secret": process.env.CLIENT_SECRET_LINKQU,
    };

    try {
        const response = await axios({
            method: method,
            url: "https://api.linkqu.id/linkqu-partner/transaction/create/qris",
            headers: headers,
            data: params,
        });

        const dataResponse = response.data;
        if (dataResponse.status === "SUCCESS") {
            // PENTING: Penyimpanan pesanan sekarang dilakukan di dalam `bot.js`
            // di dalam sebuah transaksi database untuk menjamin keamanan stok.
            // Fungsi ini hanya mengembalikan detail pembayaran dari Linkqu.
            return {
                qrImage: dataResponse.imageqris,
                displayOrderId: internalOrderId,
                realOrderId: dataResponse.partner_reff,
                amount: dataResponse.amount,
                fee: dataResponse.fee
            };
        } else {
            const errorMessage = dataResponse.response_desc || "Linkqu returned an unsuccessful status.";
            throw new Error(`Linkqu API Error: ${errorMessage}`);
        }
    } catch (error) {
        let detailedError = "Gagal membuat pembayaran Linkqu.";
        if (error.response && error.response.data) {
            const apiErrorData = error.response.data;
            detailedError = `Linkqu API Error (${error.response.status}): ${
                apiErrorData.response_desc || apiErrorData.message || JSON.stringify(apiErrorData)
            }`;
        } else if (error.message.includes("Linkqu API Error")) {
            throw error;
        } else {
            detailedError = `Network error while contacting Linkqu: ${error.message}`;
        }
        throw new Error(detailedError);
    }
}

async function checkPaymentStatus(orderId) {
    const url = `https://api.linkqu.id/linkqu-partner/transaction/payment/checkstatus?username=${process.env.USERNAME_LINKQU}&partnerreff=${orderId}`;
    const headers = {
        "Content-Type": "application/json",
        "client-id": process.env.CLIENT_ID_LINKQU,
        "client-secret": process.env.CLIENT_SECRET_LINKQU,
    };

    try {
        const response = await axios.get(url, { headers });
        const data = response.data;
        
        // REVISI: Menggunakan Mongoose untuk mencari dan memperbarui pesanan
        const order = await Order.findOne({ orderId: orderId });

        if (!order) return { status: "NOT_FOUND" };
        if (order.status === "PAID") return { status: "PAID", order: order };

        if (data.rc === "00" && data.data.status_trx === "success") {
            if (order.status === "PENDING") {
                order.status = "PAID";
                order.paidAt = new Date();
                // HEMAT STORAGE: simpan ringkasan saja, bukan payload mentah.
                order.paymentDetails = slimPaymentDetails(data.data);
                // Order lunas tidak boleh ikut terhapus TTL.
                order.expiresAt = undefined;
                await order.save();
            }
            return { status: "PAID", order: order };
        } else if (data.data && (data.data.status_trx === "expired" || data.data.status_trx === "failed")) {
            return { status: "EXPIRED", order: order };
        } else {
            return { status: "PENDING", order: order };
        }
    } catch (error) {
        console.error("Check Linkqu status error:", error.message);
        return { status: "API_ERROR" };
    }
}

async function getOrderData(orderId) {
    // REVISI: Menggunakan Mongoose untuk mencari pesanan dengan efisien
    return await Order.findOne({ orderId: orderId }).lean();
}

async function cancelOrder(orderId) {
    // REVISI: Menggunakan Mongoose untuk membatalkan pesanan
    await Order.findOneAndUpdate(
        { orderId: orderId, status: 'PENDING' },
        { $set: { status: 'CANCELLED', cancelledAt: new Date() } }
    );
}

async function checkBalance() {
  const config = {
    method: 'get',
    url: `https://api.linkqu.id/linkqu-partner/akun/resume?username=${process.env.USERNAME_LINKQU}`,
    headers: {
      'client-id': process.env.CLIENT_ID_LINKQU,
      'client-secret': process.env.CLIENT_SECRET_LINKQU
    }
  };

  try {
    const response = await axios(config);
    // Pastikan response sukses dan data ada
    if (response.data && response.data.rc === '00') {
      // Asumsi saldo ada di response.data.data.balance
      // Jika struktur datanya berbeda, silakan sesuaikan path ini.
      const balance = response.data.data.balance || 0;
      return parseInt(balance);
    }
    console.warn('[Linkqu Balance] Gagal mengambil saldo, respons tidak sesuai:', response.data);
    return 0; // Kembalikan 0 jika gagal
  } catch (error) {
    console.error('Error saat mengambil saldo Linkqu:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    } else {
      console.error('Error:', error.message);
    }
    return 0; // Kembalikan 0 jika terjadi error
  }
}

module.exports = {
    init: async () => {
        console.log("[ Linkqu Payment System Initialized with Correct Signature ]");
    },
    createOrder,
    checkPaymentStatus,
    getOrderData,
    cancelOrder,
    checkBalance
};