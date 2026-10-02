// alimcair.js
// Jadwal pencairan Dana Alim — memisahkan dana yang SUDAH BISA DICAIRKAN dari yang MASIH TERTUNDA.
//
// Aturan Pakasir: setiap transaksi masuk "saldo tertunda" dulu, lalu pindah ke saldo utama
// H+1 jam 12.00 WIB (dihitung per TANGGAL, bukan 24 jam). Hari Minggu libur, jadi pencairan
// yang jatuh di hari Minggu digeser ke Senin 12.00 WIB:
//   dibayar Senin s/d Jumat -> cair besoknya 12.00
//   dibayar Sabtu atau Minggu -> cair Senin 12.00
// Hanya perhitungan tampilan / reset — tidak mengubah apa pun di Pakasir.
'use strict';

const crypto = require('crypto');
const moment = require('moment-timezone');

const TZ = 'Asia/Jakarta';
const CAIR_HOUR = 12;
const HARI = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

// Waktu bayar sebuah catatan Dana Alim (catatan lama mungkin belum punya completedAt).
function paidAtOf(doc) {
    return (doc && (doc.completedAt || doc.createdAt)) || null;
}

// Kapan order yang dibayar pada `paidAt` bisa dicairkan.
function cairAt(paidAt) {
    const d = moment(paidAt).tz(TZ).startOf('day').add(1, 'day');
    if (d.day() === 0) d.add(1, 'day'); // Minggu libur -> Senin
    return d.hour(CAIR_HOUR).toDate();
}

// Batas waktu bayar: order yang dibayar SEBELUM batas ini sudah bisa dicairkan pada `now`.
// cairAt() tidak pernah mundur kalau tanggal bayar maju, jadi cukup cari hari bayar terakhir
// yang sudah cair. Hari ini tidak mungkin (cair paling cepat besok); paling jauh 3 hari ke
// belakang (Senin pagi -> order Jumat), dan 3 hari ke belakang selalu sudah cair.
function cairCutoff(now = new Date()) {
    const today = moment(now).tz(TZ).startOf('day');
    for (let back = 1; back < 3; back++) {
        const day = today.clone().subtract(back, 'days');
        if (cairAt(day.toDate()) <= now) return day.add(1, 'day').toDate();
    }
    return today.clone().subtract(2, 'days').toDate(); // = hari bayar 3 hari lalu sudah cair
}

// Kondisi MongoDB: catatan yang dibayar sebelum / sesudah `cutoff`. Dipakai di dalam $and
// supaya tidak menimpa $or lain di filter yang sama.
function paidBefore(cutoff) {
    return { $or: [{ completedAt: { $lt: cutoff } }, { completedAt: null, createdAt: { $lt: cutoff } }] };
}
function paidFrom(cutoff) {
    return { $or: [{ completedAt: { $gte: cutoff } }, { completedAt: null, createdAt: { $gte: cutoff } }] };
}
const cairMatch = (cutoff) => ({ settled: false, $and: [paidBefore(cutoff)] });
const tertundaMatch = (cutoff) => ({ settled: false, $and: [paidFrom(cutoff)] });

// Angka ms (dari tombol Telegram) atau teks ISO (dari form web) -> Date; selain itu null.
function toDate(v) {
    if (v == null || v === '') return null;
    const d = typeof v === 'number' || /^\d+$/.test(String(v)) ? new Date(Number(v)) : new Date(String(v));
    return isNaN(d.getTime()) ? null : d;
}

// Batas yang dipakai saat RESET: tidak boleh melewati batas saat ini (dana yang belum cair
// tidak ikut di-reset walaupun tombol/form-nya dimanipulasi). Tanpa nilai -> batas saat ini.
function clampCutoff(requested, now = new Date()) {
    const current = cairCutoff(now);
    const r = toDate(requested);
    return r && r < current ? r : current;
}

// Filter RESET (panel web & Telegram memakai fungsi yang SAMA): hanya yang belum dibayarkan,
// SUDAH BISA DICAIRKAN, dan sudah tercatat saat layar ditampilkan (createdAt <= upto), supaya
// order yang masih tertunda / baru masuk saat layar terbuka tidak ikut ter-reset tanpa terlihat.
// Tombol / form lama (sebelum fitur ini) tidak membawa batas cair -> pakai batas saat ini.
function resetFilter(upto, cutoff, now = new Date()) {
    const filter = cairMatch(clampCutoff(cutoff, now));
    const u = toDate(upto);
    if (u) filter.createdAt = { $lte: u };
    return filter;
}

// "Sen 05/10 12.00"
function cairLabel(date) {
    const m = moment(date).tz(TZ);
    return `${HARI[m.day()]} ${m.format('DD/MM')} ${m.format('HH.mm')}`;
}

// Rekap Dana Alim yang belum dibayarkan, dipisah sudah cair / tertunda (dipakai panel web & Telegram).
//   cair:     { total, count, latest (createdAt terbaru), tele, web }
//   tertunda: { total, count, schedule: [{ at, label, total, count }] }
async function summarize(AlimSale, sourceTotals, now = new Date()) {
    const cutoff = cairCutoff(now);
    const [c] = await AlimSale.aggregate([
        { $match: cairMatch(cutoff) },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 }, latest: { $max: '$createdAt' } } },
    ]);
    const bySrc = await sourceTotals(cairMatch(cutoff));
    // Yang tertunda paling banyak order 3 hari terakhir -> dikelompokkan per jadwal cair di sini.
    const pending = await AlimSale.find(tertundaMatch(cutoff), { amount: 1, completedAt: 1, createdAt: 1 }).lean();
    const groups = new Map();
    let pTotal = 0;
    for (const p of pending) {
        const at = cairAt(paidAtOf(p));
        const key = at.getTime();
        const g = groups.get(key) || { at, label: cairLabel(at), total: 0, count: 0 };
        g.total += Number(p.amount) || 0;
        g.count += 1;
        groups.set(key, g);
        pTotal += Number(p.amount) || 0;
    }
    const cairTotal = c ? c.total : 0, cairCount = c ? c.count : 0;
    return {
        cutoff,
        total: cairTotal + pTotal, count: cairCount + pending.length, // = semua yang belum dibayarkan
        cair: { total: cairTotal, count: cairCount, latest: c && c.latest ? new Date(c.latest) : null, tele: bySrc.tele, web: bySrc.web },
        tertunda: { total: pTotal, count: pending.length, schedule: [...groups.values()].sort((a, b) => a.at - b.at) },
    };
}

// Tandai catatan yang cocok `filter` sebagai SUDAH DIBAYARKAN. Total dihitung dari catatan yang
// benar-benar ditandai oleh panggilan INI (penanda settleBatch unik), jadi tetap benar walau
// tombol reset ditekan dua kali / dari panel web & Telegram bersamaan.
async function settle(AlimSale, filter) {
    const batch = crypto.randomUUID();
    const r = await AlimSale.updateMany({ ...filter, settled: false }, { $set: { settled: true, settledAt: new Date(), settleBatch: batch } });
    const [agg] = await AlimSale.aggregate([
        { $match: { settleBatch: batch } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    return { count: r.modifiedCount || 0, total: agg ? agg.total : 0 };
}

// Status cair satu catatan (untuk daftar order & lacak ID).
function statusOf(doc, now = new Date()) {
    const at = cairAt(paidAtOf(doc));
    return { at, label: cairLabel(at), ready: at <= now };
}

module.exports = { TZ, cairAt, cairCutoff, paidBefore, paidFrom, cairMatch, tertundaMatch, clampCutoff, resetFilter, cairLabel, summarize, settle, statusOf, paidAtOf };
