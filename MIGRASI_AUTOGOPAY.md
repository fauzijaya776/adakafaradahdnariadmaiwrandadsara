# Audit dan migrasi AutoGoPay — hasil revisi

Repositori: fauzijaya776/adakafaradahdnariadmaiwrandadsara
Basis upstream: main, commit ada4a0a200162d81c0c2d0f18549c544dcc96597.
Kode migrasi ini memerlukan konfigurasi environment hosting dan uji transaksi nyata sebelum digunakan dalam produksi.

## Masalah yang ditemukan dan diperbaiki

1. Pembersihan otomatis dapat melepas stok PENDING tanpa mengecek pembayaran.
   AutoGoPay sekarang dikecualikan dari pemulihan berbasis umur, penghapusan order,
   dan pemberian TTL oleh all.js maupun cleanup.js. Bukti transaksi belum jelas tetap disimpan.
2. Status PAID, pengurangan reservasi stok, dan total belanja tadinya ditulis terpisah.
   Ketiganya sekarang satu transaksi MongoDB: semua berhasil atau semua batal.
3. Pembatalan dan pembayaran bisa bersamaan. Pengembalian stok sekarang juga satu
   transaksi database; pembayaran yang sudah PAID tidak boleh dibatalkan.
4. Order lunas yang gagal terkirim tadinya dapat kehilangan akun karena retensi.
   Pembersihan akun lama hanya berlaku setelah delivered=true. Bukti reservasi yang
   perlu pemeriksaan tetap tersimpan.
5. Timeout pengiriman Telegram bisa diikuti kirim ulang dengan hasil tidak pasti.
   AutoGoPay sekarang memakai antrean pengiriman tersimpan dan satu dokumen akun.
   Timeout/putus koneksi atau restart di tengah pengiriman masuk REVIEW, bukan resend otomatis.
   Telegram 429 yang eksplisit ditolak boleh dicoba kembali sesudah retry_after, maksimal 3 percobaan.
6. Signature palsu, nominal atau ID transaksi/order yang berbeda tidak boleh melunasi order.
   Webhook memakai raw-body HMAC, pencocokan ID/nominal, dan verifikasi ulang status API.
7. Panel masih punya fallback login gen/gen. Fallback dihapus: panel hanya menerima
   login jika ADMIN_USERNAME diisi dan ADMIN_PASSWORD minimal 12 karakter.
8. Tombol create pembayaran lama tidak boleh melewati pembatas merchant baru.
   Tombol Pakasir lama diarahkan ke AutoGoPay; tombol create DANA/QRIN lama meminta pembeli membuka menu baru.
   Verifikasi/callback invoice lama tetap tersedia.

## Perlindungan merchant

Pembatas berikut merupakan kebijakan konservatif bot, bukan angka resmi GoPay:

| Aturan | Perilaku |
| --- | --- |
| Invoice aktif | Maksimal satu invoice AutoGoPay per merchant integrasi ini |
| Jeda generate | Minimal 60 detik |
| Kuota per jam | Maksimal 20 percobaan generate |
| Kuota per hari | Maksimal 100 percobaan generate |
| Tombol ditekan ulang | Menampilkan QRIS tersimpan yang sama; bukan generate ulang |
| Invoice dibatalkan | Tetap menunggu expiry invoice lama sebelum boleh generate baru |
| Generate timeout | Tidak diulang otomatis; stok dan gate ditahan untuk rekonsiliasi |
| Error create / respons meragukan | Circuit pembuatan QRIS dihentikan sampai pemeriksaan admin |
| Provider 401/403/429 | Backoff; tidak mengirim request beruntun |
| Cek status bersamaan | Digabungkan per transaction_id di proses bot |
| Restart / banyak proses | Gate, kuota dan invoice aktif tersimpan di database; unique index per pembeli dan transaction_id |

Pembuatan invoice dan klaim gate ada dalam transaksi yang sama dengan reservasi stok.
Tidak ada generate otomatis dalam loop. Pembayaran baru memakai GoPay QRIS melalui
AutoGoPay, dengan expiry_time dari provider. Nama waktu tanpa zona dibaca sebagai WIB.

Pembatas ini hanya mengoordinasikan layanan yang memakai gate/database yang sama.
Jangan menjalankan generator lain dengan merchant yang sama tanpa koordinasi.
Kepatuhan transaksi, kelayakan akun, dan keputusan pemblokiran tetap ditentukan provider.
Kode tidak dapat menjamin akun tidak pernah diblokir dan tidak mencoba mengakali pembatas provider.

## Pemasangan setelah disetujui

1. Cocokkan perubahan upstream sejak commit basis; jangan menimpa perubahan orang lain.
2. Terapkan all.js, db.js, cleanup.js, qris_autogopay.js, autogopay_safety.js,
   autogopay_delivery.js dan test/*.test.js. Tidak ada dependensi baru.
3. Atur AUTOGOPAY_API_KEY lewat Environment hosting. Key asli tidak ada di paket/patch ini.
   Gunakan key baru sebelum produksi bila key lama sudah tersebar ke pihak lain.
4. Isi ADMIN_USERNAME, ADMIN_PASSWORD (minimal 12 karakter), OWNER_ID dan SESSION_SECRET.
   Kredensial lemah/kosong membuat panel login ditolak; bot pembayaran tetap punya pemeriksaan sendiri.
5. Pastikan merchant GoPay terhubung, langganan AutoGoPay aktif, dan penggunaan akun sesuai ketentuan provider.
6. Callback: https://DOMAIN-BOT/autogopay/callback. Gunakan domain bot. Polling tetap berfungsi jika webhook gagal.
7. Pertahankan env Pakasir sampai seluruh invoice lama selesai. Jangan menjalankan cleanup lama dari luar paket.
8. MongoDB harus mendukung transaksi (replica set, misalnya Atlas). Startup menunggu index
   unik terbentuk sebelum menerima pembuatan QRIS AutoGoPay. Index gagal => pembayaran baru ditolak.
9. Uji satu transaksi kecil, lalu pembatalan, expiry, webhook ganda, bot restart, dan bot diblokir pembeli.
   Periksa saldo merchant, akun yang diterima, jumlah stok dan order PAID sebelum membuka penjualan.

## Pemeriksaan admin dan keadaan tidak pasti

/agpstatus menampilkan gate merchant, invoice aktif, jumlah PENDING, dan status circuit.
/agplanjut membuka kembali circuit hanya jika tidak ada invoice PENDING dan gate kosong.
Kuota/jeda tidak direset oleh perintah ini. Perintah hanya untuk OWNER_ID.

Jika provider menerima generate tetapi koneksi/database gagal sebelum ID tersimpan,
API yang dilampirkan tidak menyediakan idempotency key atau pencarian lewat ID order bot.
Bot menahan stok dan pembuatan QRIS baru. Admin harus mencocokkan transaksi pada dashboard
provider; jangan melepas stok atau mengirim akun berdasarkan tebakan nominal saja.
ID provider yang sudah diterima disimpan sebelum render QR dan validasi expiry.
Jika penyimpanan gagal, ID provider dicantumkan pada pesan error admin tanpa membocorkan key.

Jika Telegram menerima pesan tetapi pencatatan database gagal, tidak ada cara membuat kedua
layanan itu atomik. Order masuk REVIEW setelah 5 menit. Periksa chat pembeli dahulu;
kirim ulang hanya akun yang sama jika terbukti belum diterima. Jangan mengambil stok baru.
/resend tetap tunduk pada antrean aman untuk AutoGoPay; ia tidak memaksa resend order REVIEW.
Admin dapat mengirim file akun yang sama secara manual lalu memakai /tandaikirim <ID>.

Pembayaran terlambat setelah stok dilepas mengambil stok baru di dalam transaksi. Jika stok habis,
order tetap PAID tetapi REVIEW dan admin diberi tahu untuk pemenuhan manual atau refund.
Tidak ada refund/transfer uang otomatis. Refund harus dicocokkan dengan transaksi yang benar.

## Batas cakupan

Migrasi ini melindungi alur baru AutoGoPay beserta interaksinya dengan pembersihan, login panel,
dan pembatalan lama. Integrasi Pakasir/QRIN/DANA/Linkqu lama tidak diaudit penuh atau ditulis ulang;
invoice lama sebaiknya diselesaikan dahulu dan dipantau selama peralihan.
Saldo dashboard dan Dana Alim masih berasal dari integrasi lama, bukan saldo AutoGoPay.
Field fee=0 berarti bot tidak menambah biaya ke pembeli; biaya/MDR merchant tetap mengikuti provider.

## Verifikasi

Jalankan:

    node --check all.js
    node --check db.js
    node --check cleanup.js
    node --check qris_autogopay.js
    node --check autogopay_safety.js
    node --check autogopay_delivery.js
    node --test test/*.test.js

38 pengujian simulasi lulus, meliputi rollback database, pembayaran/cancel bersamaan,
callback palsu/ganda, stok habis, restart, timeout Telegram, pembatas generate dan backoff.
Harness database mensimulasikan transaksi/rollback; bukan pengujian MongoDB nyata.
Tidak ada transaksi riil dibuat dan belum ada pengujian langsung akun provider, Telegram,
MongoDB/index produksi, atau deployment. Format respons status mengikuti dokumentasi terlampir
(success/data dan transaction_status atau status); verifikasi dengan akun nyata tetap diperlukan.
