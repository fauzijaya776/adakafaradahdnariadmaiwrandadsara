# Versi QRIN — tokoteledompet

Folder ini adalah salinan bot yang gateway QRIS-nya memakai **QRIN** (https://qrin.web.id),
menggantikan Pakasir. Metode: **QRIS only**.

## Perbedaan penting vs Pakasir
QRIN **tidak menyediakan endpoint cek status (polling)**. Konfirmasi pembayaran hanya
lewat **WEBHOOK/CALLBACK**: QRIN mengirim `POST` ke URL callback merchant setiap status
berubah, dengan header `X-Callback-Signature = HMAC-SHA256(raw body, QRIN_TOKEN)`.

Karena itu bot ini:
- Membuat QRIS via `POST https://qrin.web.id/api/create-transaksi` (modul `qris_qrin.js`).
- Menampilkan QR dari field `qris_data`.
- Menerima konfirmasi lewat route **`POST /qrin/callback`** di `all.js` (verifikasi tanda tangan,
  lalu memenuhi order: tandai PAID, kirim stok, dsb).
- Memasang timeout 5 menit; bila tak ada callback `success`, stok dikembalikan & order EXPIRED.

## Yang harus disiapkan
1. **Isi `.env`** — `QRIN_TOKEN` sudah diisi dengan token Anda. Sesuaikan `PORT` bila perlu.
2. **URL Callback** — di dashboard QRIN → Setting Merchant, set URL callback ke:
   ```
   https://DOMAIN-ANDA/qrin/callback
   ```
   URL ini harus **bisa diakses publik** (mengarah ke server tempat bot berjalan, port sesuai `PORT`).
   Bila bot jalan di PC lokal, gunakan domain/reverse proxy atau tunneling agar QRIN bisa menjangkaunya.
3. `npm install` lalu `node all.js` (atau `pm2 start all.js`).

## Tes cepat
```
node test-qrin.js 1500
```
Menghasilkan `qris-test.png`. Scan & bayar. Karena tak ada polling, cek hasil di dashboard QRIN,
atau (jika callback sudah diset & bot jalan) konfirmasi masuk otomatis via `/qrin/callback`.

## Catatan biaya
QRIS QRIN: biaya `0,7% + Rp500` per transaksi **ditanggung merchant** (`customer_cost = 0`).
Customer membayar `amount_value`; merchant menerima `amount_received` (= amount − fee).
`order.amount` menyimpan nominal produk (yang dibayar customer) untuk pencatatan `totalSpent`.
