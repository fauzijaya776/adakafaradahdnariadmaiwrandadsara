// =================================================================
// cleanup.js — Perawatan & penghematan storage MongoDB
//
// Kuota Atlas M0 (free tier) = 512MB, dihitung dari dataSize + indexSize.
// Jadi menghapus dokumen benar-benar menurunkan pemakaian kuota.
// Catatan: perintah `compact` TIDAK diizinkan di M0, sehingga file fisik
// tidak menyusut — ruang kosongnya dipakai ulang untuk data baru.
//
// CARA PAKAI:
//   node cleanup.js                  -> LAPORAN SAJA (dry run, tidak menghapus)
//   node cleanup.js --apply          -> jalankan pembersihan
//   node cleanup.js --apply --reindex-> + bangun ulang index (reclaim indexSize)
//
// Opsi retensi (bisa juga diatur lewat .env):
//   JUNK_ORDER_TTL_HOURS       default 24
//   PAID_ITEMS_RETENTION_DAYS  default 30
// =================================================================

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB, Order, User, Product } = require('./db');

const APPLY = process.argv.includes('--apply');
const REINDEX = process.argv.includes('--reindex');

const JUNK_ORDER_TTL_HOURS = parseInt(process.env.JUNK_ORDER_TTL_HOURS || '24', 10);
const PAID_ITEMS_RETENTION_DAYS = parseInt(process.env.PAID_ITEMS_RETENTION_DAYS || '30', 10);

const MB = 1024 * 1024;
const fmt = (bytes) => `${(bytes / MB).toFixed(2)} MB`;
const line = () => console.log('─'.repeat(64));

async function getDbStats() {
    try {
        return await mongoose.connection.db.command({ dbStats: 1, scale: 1 });
    } catch (error) {
        console.warn('  (dbStats tidak tersedia:', error.message, ')');
        return null;
    }
}

async function printUsage(title) {
    line();
    console.log(title);
    line();

    const stats = await getDbStats();
    if (stats) {
        const data = stats.dataSize || 0;
        const index = stats.indexSize || 0;
        const logical = data + index;
        const pct = ((logical / (512 * MB)) * 100).toFixed(1);
        console.log(`  Data (BSON)   : ${fmt(data)}`);
        console.log(`  Index         : ${fmt(index)}`);
        console.log(`  TOTAL LOGIS   : ${fmt(logical)}  (${pct}% dari kuota 512MB M0)`);
        console.log(`  Storage fisik : ${fmt(stats.storageSize || 0)}  (tidak menyusut di M0)`);
    }

    console.log('');
    const collections = await mongoose.connection.db.listCollections().toArray();
    for (const col of collections) {
        try {
            const result = await mongoose.connection.db
                .collection(col.name)
                .aggregate([{ $collStats: { storageStats: {} } }])
                .toArray();
            const ss = result[0] && result[0].storageStats;
            if (!ss) continue;
            console.log(
                `  ${col.name.padEnd(14)} ${String(ss.count).padStart(8)} dok` +
                `  data ${fmt(ss.size).padStart(10)}` +
                `  index ${fmt(ss.totalIndexSize).padStart(10)}`
            );
        } catch (error) {
            console.log(`  ${col.name.padEnd(14)} (statistik tidak tersedia)`);
        }
    }
    console.log('');
}

// -----------------------------------------------------------------
// Diagnostik: cek hal-hal yang bisa bikin user baru gagal tersimpan
// -----------------------------------------------------------------
async function diagnose() {
    line();
    console.log('DIAGNOSTIK COLLECTION users');
    line();

    const total = await User.countDocuments();
    const broken = await User.countDocuments({ $or: [{ id: null }, { id: { $exists: false } }] });
    console.log(`  Total user            : ${total}`);
    console.log(`  User tanpa field 'id' : ${broken}${broken > 0 ? '   <-- INI PENYEBAB E11000 saat user baru /start' : '   (aman)'}`);

    try {
        const indexes = await mongoose.connection.db.collection('users').indexes();
        console.log('  Index users:');
        indexes.forEach((idx) => {
            const flags = [idx.unique ? 'unique' : null, idx.sparse ? 'sparse' : null]
                .filter(Boolean).join(', ');
            console.log(`    - ${idx.name}: ${JSON.stringify(idx.key)}${flags ? ' (' + flags + ')' : ''}`);
        });
    } catch (error) {
        console.log('  (gagal membaca index:', error.message, ')');
    }

    if (broken > 0) {
        console.log('');
        console.log(`  ${APPLY ? 'MENGHAPUS' : 'AKAN MENGHAPUS'} ${broken} dokumen user rusak tersebut.`);
        console.log('  (Dokumen ini tidak punya id Telegram, jadi tidak bisa dipakai bot');
        console.log('   dan justru memblokir pendaftaran user baru lewat unique index.)');
        if (APPLY) {
            const result = await User.deleteMany({ $or: [{ id: null }, { id: { $exists: false } }] });
            console.log(`  -> ${result.deletedCount} dokumen dihapus.`);
        }
    }
    console.log('');
}

// -----------------------------------------------------------------
// Pastikan TTL index ada dan nilainya benar
// -----------------------------------------------------------------
async function ensureTtlIndex() {
    line();
    console.log('TTL INDEX (penghapusan otomatis order sampah)');
    line();

    const collection = mongoose.connection.db.collection('orders');
    let indexes = [];
    try {
        indexes = await collection.indexes();
    } catch (error) {
        console.log('  (gagal membaca index:', error.message, ')');
        return;
    }

    const ttl = indexes.find((idx) => idx.key && idx.key.expiresAt === 1);
    if (ttl) {
        console.log(`  ✅ Sudah ada: ${ttl.name} (expireAfterSeconds: ${ttl.expireAfterSeconds})`);
        if (ttl.expireAfterSeconds !== 0) {
            console.log('  ⚠️  Seharusnya 0 (kedaluwarsa mengikuti nilai field expiresAt).');
            if (APPLY) {
                await mongoose.connection.db.command({
                    collMod: 'orders',
                    index: { name: ttl.name, expireAfterSeconds: 0 }
                });
                console.log('  -> diperbaiki.');
            }
        }
    } else {
        console.log(`  ${APPLY ? 'MEMBUAT' : 'BELUM ADA (akan dibuat)'} index TTL { expiresAt: 1 }, expireAfterSeconds: 0`);
        if (APPLY) {
            await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expiresAt' });
            console.log('  -> dibuat. MongoDB memeriksa dokumen kedaluwarsa tiap 60 detik.');
        }
    }
    console.log('');
}

// -----------------------------------------------------------------
// Pembersihan utama
// -----------------------------------------------------------------
async function recoverStrandedStock() {
    line();
    console.log('PEMULIHAN STOK NYANGKUT');
    line();
    console.log('  Order yang masih PENDING > 1 jam berarti prosesnya gagal di');
    console.log('  tengah jalan (invoice hanya hidup 3 menit). Stoknya tertinggal');
    console.log('  di reserved_stock dan tidak bisa dijual lagi.');
    console.log('');

    const strandedCutoff = new Date(Date.now() - 60 * 60 * 1000);
    const stranded = await Order.find({
        status: 'PENDING',
        createdAt: { $lt: strandedCutoff },
        reservedItems: { $exists: true, $ne: [] }
    }).lean();

    const itemCount = stranded.reduce((sum, o) => sum + (o.reservedItems || []).length, 0);
    console.log(`  Ditemukan: ${stranded.length} order (${itemCount} item stok tertahan)`);

    if (stranded.length === 0) {
        console.log('');
        return;
    }
    if (!APPLY) {
        console.log('  -> (dry run, stok belum dikembalikan)');
        console.log('');
        return;
    }

    let recovered = 0;
    for (const order of stranded) {
        try {
            await Product.updateOne(
                { id: order.productId, 'variants.slug': order.variantSlug },
                {
                    $push: { 'variants.$.stock': { $each: order.reservedItems } },
                    $pull: { 'variants.$.reserved_stock': { $in: order.reservedItems } }
                }
            );
            await Order.updateOne({ _id: order._id, status: 'PENDING' }, { $set: { status: 'EXPIRED' } });
            recovered += 1;
        } catch (error) {
            console.log(`  - ${order.orderId}: GAGAL (${error.message})`);
        }
    }
    console.log(`  -> stok dari ${recovered} order DIKEMBALIKAN ke penjualan.`);
    console.log('');
}

async function cleanOrders() {
    line();
    console.log('PEMBERSIHAN COLLECTION orders');
    line();

    const junkCutoff = new Date(Date.now() - JUNK_ORDER_TTL_HOURS * 60 * 60 * 1000);
    const junkFilter = { status: { $ne: 'PAID' }, createdAt: { $lt: junkCutoff } };
    const junkCount = await Order.countDocuments(junkFilter);

    console.log(`1. Order TIDAK LUNAS lebih tua dari ${JUNK_ORDER_TTL_HOURS} jam`);
    console.log(`   (PENDING / EXPIRED / CANCELLED / FAILED)`);
    console.log(`   Ditemukan: ${junkCount} dokumen`);
    if (junkCount > 0) {
        const byStatus = await Order.aggregate([
            { $match: junkFilter },
            { $group: { _id: '$status', n: { $sum: 1 } } },
            { $sort: { n: -1 } }
        ]);
        byStatus.forEach((row) => console.log(`     - ${row._id}: ${row.n}`));
        if (APPLY) {
            const result = await Order.deleteMany(junkFilter);
            console.log(`   -> ${result.deletedCount} dokumen DIHAPUS.`);
        } else {
            console.log('   -> (dry run, tidak dihapus)');
        }
    }
    console.log('');

    const stripCutoff = new Date(Date.now() - PAID_ITEMS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const stripFilter = {
        status: 'PAID',
        createdAt: { $lt: stripCutoff },
        $or: [
            { reservedItems: { $exists: true, $ne: [] } },
            { paymentDetails: { $exists: true, $ne: null } }
        ]
    };
    const stripCount = await Order.countDocuments(stripFilter);

    console.log(`2. Order LUNAS lebih tua dari ${PAID_ITEMS_RETENTION_DAYS} hari`);
    console.log('   Dokumennya DIPERTAHANKAN (statistik & Riwayat Transaksi aman),');
    console.log('   hanya isi akun (reservedItems) + payload gateway yang dikosongkan.');
    console.log(`   Ditemukan: ${stripCount} dokumen`);
    if (stripCount > 0) {
        if (APPLY) {
            const result = await Order.updateMany(stripFilter, {
                $set: { reservedItems: [] },
                $unset: { paymentDetails: '' }
            });
            console.log(`   -> ${result.modifiedCount} dokumen DIRINGKAS.`);
        } else {
            console.log('   -> (dry run, tidak diubah)');
        }
    }
    console.log('');

    // Order lunas yang masih punya expiresAt (sisa data lama) -> jangan sampai
    // ikut terhapus TTL.
    const riskyCount = await Order.countDocuments({ status: 'PAID', expiresAt: { $exists: true, $ne: null } });
    console.log(`3. Order LUNAS yang masih punya field expiresAt: ${riskyCount}`);
    if (riskyCount > 0) {
        console.log('   Field ini harus dibuang agar order lunas tidak ikut dihapus TTL.');
        if (APPLY) {
            const result = await Order.updateMany(
                { status: 'PAID', expiresAt: { $exists: true } },
                { $unset: { expiresAt: '' } }
            );
            console.log(`   -> ${result.modifiedCount} dokumen diamankan.`);
        } else {
            console.log('   -> (dry run, tidak diubah)');
        }
    }
    console.log('');

    // Beri expiresAt pada order sampah LAMA yang belum punya, supaya TTL bisa
    // mengurusnya sendiri ke depannya.
    const needTtl = await Order.countDocuments({
        status: { $ne: 'PAID' },
        expiresAt: { $exists: false }
    });
    console.log(`4. Order tidak lunas tanpa expiresAt: ${needTtl}`);
    if (needTtl > 0 && APPLY) {
        const result = await Order.updateMany(
            { status: { $ne: 'PAID' }, expiresAt: { $exists: false } },
            { $set: { expiresAt: new Date(Date.now() + JUNK_ORDER_TTL_HOURS * 60 * 60 * 1000) } }
        );
        console.log(`   -> ${result.modifiedCount} dokumen dijadwalkan kedaluwarsa.`);
    } else if (needTtl > 0) {
        console.log('   -> (dry run, tidak diubah)');
    }
    console.log('');
}

// -----------------------------------------------------------------
// Reclaim ruang index (satu-satunya "compact" yang diizinkan di M0)
// -----------------------------------------------------------------
async function rebuildIndexes() {
    line();
    console.log('BANGUN ULANG INDEX (reclaim indexSize)');
    line();
    console.log('  compact tidak diizinkan di M0, tapi drop + create index');
    console.log('  membebaskan ruang index yang terfragmentasi.');
    console.log('');

    if (!APPLY) {
        console.log('  -> (dry run, tidak dijalankan)');
        console.log('');
        return;
    }

    // orders saja: paling sering dihapus massal, jadi paling terfragmentasi.
    // Index unik pada users/products TIDAK disentuh demi keamanan data.
    const collection = mongoose.connection.db.collection('orders');
    const indexes = await collection.indexes();
    for (const idx of indexes) {
        if (idx.name === '_id_') continue;
        if (idx.unique) {
            console.log(`  - ${idx.name}: dilewati (unique, terlalu berisiko didrop)`);
            continue;
        }
        try {
            await collection.dropIndex(idx.name);
            const options = { name: idx.name };
            if (typeof idx.expireAfterSeconds === 'number') {
                options.expireAfterSeconds = idx.expireAfterSeconds;
            }
            await collection.createIndex(idx.key, options);
            console.log(`  - ${idx.name}: dibangun ulang.`);
        } catch (error) {
            console.log(`  - ${idx.name}: GAGAL (${error.message})`);
        }
    }
    console.log('');
}

// -----------------------------------------------------------------
async function main() {
    console.log('');
    line();
    console.log(APPLY ? '  MODE: APPLY (perubahan DITULIS ke database)' : '  MODE: DRY RUN (laporan saja, tidak ada yang diubah)');
    console.log(`  Retensi order sampah : ${JUNK_ORDER_TTL_HOURS} jam`);
    console.log(`  Retensi isi akun     : ${PAID_ITEMS_RETENTION_DAYS} hari`);
    line();
    console.log('');

    await connectDB();

    await printUsage('PEMAKAIAN STORAGE — SEBELUM');
    await diagnose();
    await ensureTtlIndex();
    await recoverStrandedStock();
    await cleanOrders();
    if (REINDEX) await rebuildIndexes();

    if (APPLY) {
        await printUsage('PEMAKAIAN STORAGE — SESUDAH');
        console.log('Selesai. ✨');
        console.log('Catatan: "Storage fisik" tidak menyusut di M0 (compact tidak');
        console.log('diizinkan), tapi "TOTAL LOGIS" itulah yang dihitung Atlas');
        console.log('terhadap kuota 512MB.');
    } else {
        console.log('Dry run selesai. Tidak ada data yang diubah.');
        console.log('Jalankan lagi dengan --apply untuk mengeksekusi:');
        console.log('');
        console.log('    node cleanup.js --apply');
        console.log('');
    }

    await mongoose.connection.close();
}

main().catch(async (error) => {
    console.error('');
    console.error('❌ cleanup.js gagal:', error.message);
    try { await mongoose.connection.close(); } catch (e) {}
    process.exit(1);
});
