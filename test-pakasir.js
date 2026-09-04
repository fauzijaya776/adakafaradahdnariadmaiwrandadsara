// test-pakasir.js
// Skrip tes mandiri untuk memverifikasi integrasi Pakasir TANPA menjalankan bot.
// Cara pakai:
//   1. Pastikan PAKASIR_PROJECT dan PAKASIR_API_KEY sudah diisi di .env
//   2. Jalankan:  node test-pakasir.js
//   3. Buka file qris-test.png yang dihasilkan, scan & bayar nominal kecil.
//   4. Skrip akan polling status sampai "completed" (maks 3 menit).
//
// Nominal tes bisa diubah lewat argumen:  node test-pakasir.js 2500
// Mode Sandbox: tambah kata "sim" untuk auto-simulasi bayar:
//   node test-pakasir.js 1500 sim
require("dotenv").config();
const QRCode = require("qrcode");
const pakasir = require("./qris_pakasir");

const AMOUNT = parseInt(process.argv[2] || "1500", 10);
const DO_SIM = (process.argv[3] || "").toLowerCase() === "sim";

(async () => {
  console.log("=== TES INTEGRASI PAKASIR (QRIS) ===");
  console.log("PROJECT :", process.env.PAKASIR_PROJECT || "(KOSONG - isi dulu di .env!)");
  console.log("API_KEY :", process.env.PAKASIR_API_KEY ? "(terisi)" : "(KOSONG!)");
  console.log("Nominal :", AMOUNT, "\n");

  const orderId = "TEST-" + Date.now();

  let raw;
  try {
    raw = await pakasir.createTransaction(orderId, AMOUNT);
  } catch (e) {
    console.error("\n❌ GAGAL membuat transaksi:", e.message);
    console.error("Periksa: slug PAKASIR_PROJECT benar? api_key benar? nominal >= minimum Pakasir?");
    process.exit(1);
  }

  console.log("✅ Transaksi dibuat. Respons terparse:");
  console.log(JSON.stringify(raw, null, 2));
  console.log("\n- order_id     :", orderId);
  console.log("- Base (diterima):", raw.amount);
  console.log("- Fee          :", raw.fee);
  console.log("- Total bayar  :", raw.totalBayar);

  if (!raw.qrString) {
    console.error("\n❌ QRIS string kosong. Lihat respons di atas untuk nama field yang benar.");
    process.exit(1);
  }

  await QRCode.toFile("qris-test.png", raw.qrString, { width: 512, margin: 2 });
  console.log("\n🖼️  QRIS disimpan ke: qris-test.png  -> buka & scan untuk membayar.");

  if (DO_SIM) {
    console.log("\n🧪 Mode simulasi (Sandbox): mengirim paymentsimulation...");
    const simRes = await pakasir.simulatePayment(orderId, raw.amount);
    console.log("   Respons simulasi:", JSON.stringify(simRes));
  }

  console.log("\n⏳ Polling status tiap 5 detik (maks 3 menit)...");
  const start = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - start > 180000) {
      clearInterval(timer);
      console.log("\n⌛ Timeout 3 menit. Belum terbayar / tidak terdeteksi.");
      process.exit(0);
    }
    const res = await pakasir.checkPaymentStatus(orderId, raw.amount);
    const status = String(
      res?.transaction?.status || res?.status || res?.data?.status || "?"
    ).toUpperCase();
    process.stdout.write(`  status: ${status}\n`);
    if (["PAID", "SUCCESS", "COMPLETED"].includes(status)) {
      clearInterval(timer);
      console.log("\n🎉 BERHASIL! Pembayaran terkonfirmasi. Integrasi bekerja end-to-end.");
      process.exit(0);
    }
  }, 5000);
})();
