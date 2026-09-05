// test-qrin.js
// Tes mandiri integrasi QRIN (create QRIS) TANPA menjalankan bot.
// Cara pakai:
//   1. Isi QRIN_TOKEN di .env
//   2. node test-qrin.js            (nominal default 1500)
//      node test-qrin.js 2000       (nominal custom)
//   3. Buka qris-test.png -> scan & bayar.
//
// CATATAN PENTING: QRIN TIDAK punya endpoint cek status. Konfirmasi lunas
// hanya lewat WEBHOOK (POST ke URL callback merchant). Jadi skrip ini hanya
// menguji pembuatan QRIS + menampilkan QR. Untuk cek terbayar/tidak, lihat
// dashboard QRIN atau tunggu callback masuk ke bot (route /qrin/callback).
require("dotenv").config();
const QRCode = require("qrcode");
const qrin = require("./qris_qrin");

const AMOUNT = parseInt(process.argv[2] || "1500", 10);

(async () => {
  console.log("=== TES INTEGRASI QRIN (QRIS) ===");
  console.log("QRIN_TOKEN :", process.env.QRIN_TOKEN ? "(terisi)" : "(KOSONG - isi di .env!)");
  console.log("Nominal    :", AMOUNT, "\n");

  const orderId = "TEST-" + Date.now();

  let raw;
  try {
    raw = await qrin.createTransaction(orderId, AMOUNT, "Tes Produk");
  } catch (e) {
    console.error("\n❌ GAGAL membuat transaksi:", e.message);
    process.exit(1);
  }

  console.log("✅ Transaksi dibuat. Respons terparse:");
  console.log(JSON.stringify(raw, null, 2));
  console.log("\n- no_ref_merchant :", orderId);
  console.log("- Dibayar customer:", raw.totalBayar);
  console.log("- Fee merchant    :", raw.fee);
  console.log("- Diterima merchant:", raw.amountReceived);

  if (!raw.qrString) {
    console.error("\n❌ qris_data kosong. Lihat respons di atas.");
    process.exit(1);
  }
  if (raw.qrString.startsWith("0002")) {
    console.log("\n✅ Format QRIS valid (diawali 0002...).");
  }

  await QRCode.toFile("qris-test.png", raw.qrString, { width: 512, margin: 2 });
  console.log("🖼️  QRIS disimpan ke: qris-test.png -> scan untuk membayar.");
  console.log("\nℹ️  Untuk konfirmasi lunas otomatis di bot, pastikan URL callback QRIN");
  console.log("   diarahkan ke https://DOMAIN-ANDA/qrin/callback (Setting Merchant QRIN).");
  process.exit(0);
})();
