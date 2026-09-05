const {
  Markup
} = require('telegraf');
const {
  Product
} = require('./db');
const mongoose = require('mongoose');
const {
  createTransfer,
  getProfile
} = require('./qris_tokopay');

const userStates = {};
const ADMIN_IDS = (process.env.OWNER_ID || '').split(',').map(id => id.trim());

const adminMiddleware = (ctx, next) => {
  if (ADMIN_IDS.includes(ctx.from.id.toString())) {
    return next();
  }
  ctx.reply('❌ Maaf, Anda tidak memiliki akses admin.');
};

// --- FUNGSI-FUNGSI DIBAWAH INI SUDAH DIREVISI MENGGUNAKAN MONGOOSE ---

async function addStock(productId, variantSlug, stockToAdd, ctx) {
  try {
    const newStockItems = stockToAdd.filter(line => line.trim() !== '');
    if (newStockItems.length === 0) return ctx.reply('❌ Tidak ada stok yang valid untuk ditambahkan.');

    // REVISI: Menggunakan Mongoose untuk menambahkan stok
    const result = await Product.updateOne(
      {
        id: productId, "variants.slug": variantSlug
      },
      {
        $push: {
          "variants.$.stock": {
            $each: newStockItems
          }
        }
      }
    );

    if (result.matchedCount === 0) {
      return ctx.reply('❌ Gagal: Produk atau varian tidak ditemukan.');
    }

    // Ambil data terbaru untuk pesan balasan
    const updatedProduct = await Product.findOne({
      id: productId
    }).lean();
    const updatedVariant = updatedProduct.variants.find(v => v.slug === variantSlug);

    ctx.reply(
      `✅ Berhasil menambahkan ${newStockItems.length} stok untuk *${updatedProduct.name}* - *${updatedVariant.name}*.\nTotal stok sekarang: ${updatedVariant.stock.length}`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback('⬅️ Kembali Ke Menu', 'admin_menu')
        ]).reply_markup
      }
    );

  } catch (error) {
    console.error('Error adding stock:', error);
    ctx.reply(`❌ Gagal menambahkan stok. \nPesan Error: ${error.message}`);
  }
}

async function deleteProduct(productId) {
  // REVISI: Menggunakan Mongoose untuk menghapus produk
  await Product.deleteOne({
    id: productId
  });
}

async function getAdminMenuMessageAndKeyboard() {
  const message = '⚙️ *Panel Admin*\n\n' +
  'Silakan pilih opsi manajemen:';

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Tambah Stok', 'admin_add_stock_select_product_1')],
    [Markup.button.callback('📤 Ambil Stok', 'ats_prod_1')],
    [Markup.button.callback('➕ Tambah Produk', 'admin_add_product')],
    [Markup.button.callback('✍️ Edit Produk', 'admin_edit_product_list_1')],
    [Markup.button.callback('💰 Harga Grosir', 'admin_bulk_select_product_1')],
    [Markup.button.callback('📜 Kelola SNK', 'admin_snk_select_product_1')],
    [Markup.button.callback('❌ Hapus Produk', 'admin_delete_product_list_1')],
    [Markup.button.callback('🚀 Broadcast', 'admin_broadcast')],
    [Markup.button.callback('💳 Buat Transfer', 'admin_tf')],
    [Markup.button.callback('🧾 Cek Saldo', 'admin_profile')],
    [Markup.button.callback('⬅️ Kembali ke Menu Utama', 'back_to_start')]
  ]);

  return {
    message,
    keyboard
  };
}

async function getProductManagementList(action, page = 1) {
  // REVISI: Mengambil data dari MongoDB
  const products = await Product.find({}).sort({
    name: 1
  }).lean();

  const productsPerPage = 10;
  const startIndex = (page - 1) * productsPerPage;
  const endIndex = startIndex + productsPerPage;
  const paginatedProducts = products.slice(startIndex, endIndex);

  let title = '';
  if (action === 'edit') title = 'Pengeditan';
  else if (action === 'delete') title = 'Penghapusan';
  else if (action === 'snk') title = 'Manajemen SNK';
  else if (action === 'bulk') title = 'Harga Grosir';

  let message = `📚 *Daftar Produk untuk ${title}:*\n\n`;
  const keyboardButtons = [];

  paginatedProducts.forEach((p, index) => {
    const productNumber = startIndex + index + 1;
    message += `*${productNumber}. ${p.name}*\n`;
    keyboardButtons.push(
      Markup.button.callback(`${productNumber}`, `admin_${action}_product_${p.id}_page_${page}`)
    );
  });

  const navigationButtons = [];
  if (page > 1) {
    navigationButtons.push(Markup.button.callback('⬅️ Sebelumnya', `admin_${action}_product_list_${page - 1}`));
  }
  if (endIndex < products.length) {
    navigationButtons.push(Markup.button.callback('➡️ Berikutnya', `admin_${action}_product_list_${page + 1}`));
  }

  const keyboard = [
    keyboardButtons,
    navigationButtons,
    [Markup.button.callback('⬅️ Kembali', 'admin_menu')]
  ];

  return {
    message,
    keyboard: Markup.inlineKeyboard(keyboard)
  };
}

async function getEditProductDetails(productId, page) {
  try {
    // REVISI: Mengambil satu produk dari MongoDB
    const product = await Product.findOne({
      id: productId
    }).lean();
    if (!product) throw new Error('Produk tidak ditemukan');

    let message = `✍️ *Edit Produk: ${product.name}*\n\n` +
    `*Deskripsi:* ${product.description}\n\n` +
    `*Varian & Harga:*\n`;

    // Baris-baris ini akan menampung tombol-tombol yang akan kita buat
    const keyboardRows = [
      [Markup.button.callback('📝 Edit Nama & Deskripsi', `admin_edit_name_desc_${productId}_page_${page}`)],
      [Markup.button.callback('➕ Tambah Varian Baru', `admin_add_variant_${productId}_page_${page}`)],
    ];

    // --- PERUBAHAN DIMULAI DI SINI ---

    // Kita akan langsung membuat dan menambahkan tombol ke keyboardRows di dalam loop ini
    product.variants.forEach((v, index) => {
      const stockCount = Array.isArray(v.stock) ? v.stock.length: 0;
      const snkStatus = (v.snk && v.snk !== '-') ? '✅ Aktif': '❌ Tidak Aktif';
      message += `├ ${v.name}: Rp ${v.price.toLocaleString('id-ID')} | Stok: ${stockCount} | SNK: ${snkStatus}\n`;

      const buttonRow = [
        // Menggunakan pola 'action:productId:slug:page'
        Markup.button.callback(`📝 Edit Varian ${index + 1}`, `admin_edit_variant:${productId}:${v.slug}:${page}`),
        Markup.button.callback(`🗑️ Hapus`, `admin_delete_variant_confirm:${productId}:${v.slug}:${page}`)
      ];
      keyboardRows.push(buttonRow);
    });

    message += '\n';
    keyboardRows.push([Markup.button.callback('⬅️ Kembali', `admin_edit_product_list_${page}`)]);

    return {
      message,
      keyboard: Markup.inlineKeyboard(keyboardRows)
    };
  } catch (error) {
    console.error('Error in getEditProductDetails:', error);
    return {
      message: '❌ Produk tidak ditemukan.',
      keyboard: Markup.inlineKeyboard([Markup.button.callback('⬅️ Kembali', `admin_edit_product_list_${page}`)])
    };
  }
}

async function getAddStockProductList(page = 1) {
  // REVISI: Mengambil data dari MongoDB
  const products = await Product.find({}).sort({
    name: 1
  }).lean();

  const productsPerPage = 5; // Menyamakan jumlah per halaman seperti menu lain
  const startIndex = (page - 1) * productsPerPage;
  const endIndex = startIndex + productsPerPage;
  const paginatedProducts = products.slice(startIndex, endIndex);

  // --- BLOK KODE YANG DIUBAH DIMULAI DI SINI ---
  let message = '👇 *Tambah Stok*\n\nPilih produk yang akan ditambahkan stoknya:\n\n';
  const keyboardButtons = []; // Untuk menampung tombol angka [1], [2], [3], ...

  paginatedProducts.forEach((p, index) => {
    const productNumber = startIndex + index + 1;
    message += `*${productNumber}. ${p.name}*\n`; // Membuat daftar bernomor di teks pesan

    // Membuat tombol dengan angka yang sesuai
    keyboardButtons.push(
      Markup.button.callback(String(productNumber), `admin_add_stock_select_variant_${p.id}_1`)
    );
  });
  // --- AKHIR BLOK KODE YANG DIUBAH ---

  const navigationButtons = [];
  if (page > 1) {
    navigationButtons.push(Markup.button.callback('⬅️', `admin_add_stock_select_product_${page - 1}`));
  }
  if (endIndex < products.length) {
    navigationButtons.push(Markup.button.callback('➡️', `admin_add_stock_select_product_${page + 1}`));
  }

  const keyboard = [
    keyboardButtons,
    // Menampilkan semua tombol angka dalam satu baris
    navigationButtons,
    [Markup.button.callback('⬅️ Batal', 'admin_menu')]
  ];

  return {
    message,
    keyboard: Markup.inlineKeyboard(keyboard)
  };
}

async function getAddStockVariantList(productId, page = 1) {
  // REVISI: Mengambil satu produk dari MongoDB
  const product = await Product.findOne({
    id: productId
  }).lean();

  const variantsPerPage = 5;
  const startIndex = (page - 1) * variantsPerPage;
  const endIndex = startIndex + variantsPerPage;
  const paginatedVariants = product.variants.slice(startIndex, endIndex);

  const message = `👇 *Tambah Stok: ${product.name}*\n\nPilih varian yang akan ditambahkan stoknya:`;
  const keyboardButtons = paginatedVariants.map(v => {
    const stockCount = Array.isArray(v.stock) ? v.stock.length: 0;
    return [Markup.button.callback(`${v.name} (Stok: ${stockCount})`, `admin_add_stock_final:${product.id}:${v.slug}`)];
  });

  const navigationButtons = [];
  if (page > 1) {
    navigationButtons.push(Markup.button.callback('⬅️', `admin_add_stock_select_variant_${productId}_${page - 1}`));
  }
  if (endIndex < product.variants.length) {
    navigationButtons.push(Markup.button.callback('➡️', `admin_add_stock_select_variant_${productId}_${page + 1}`));
  }

  const keyboard = [
    ...keyboardButtons,
    navigationButtons,
    [Markup.button.callback('⬅️ Kembali ke Produk', 'admin_add_stock_select_product_1')]
  ];

  return {
    message,
    keyboard: Markup.inlineKeyboard(keyboard)
  };
}


// =================================================================
// AMBIL STOK MANUAL (khusus admin Telegram)
// =================================================================
// Menggantikan kebutuhan login ke MongoDB Atlas hanya untuk mengambil akun.
// Semua handler di bawah dijaga adminMiddleware, jadi hanya ID Telegram yang
// terdaftar di OWNER_ID yang bisa memakainya.

// Escape karakter Markdown supaya nama produk ber-underscore tidak merusak pesan.
function esc(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/([_*`\[\]])/g, '\\$1');
}

// Simpanan sementara untuk tombol undo. Sengaja di memori (bukan MongoDB)
// supaya tidak memakan kuota 512MB. Hilang kalau bot restart.
const lastTakenStock = new Map();
const UNDO_LIMIT = 20;

function rememberTaken(entry) {
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  lastTakenStock.set(token, entry);
  while (lastTakenStock.size > UNDO_LIMIT) {
    lastTakenStock.delete(lastTakenStock.keys().next().value);
  }
  return token;
}

// Pengambilan stok yang AMAN dari race condition.
// Tanpa transaksi, kalau ada customer checkout di detik yang sama, akun yang
// sama bisa terkirim ke dua pihak sekaligus. Pola transaksi ini sama persis
// dengan yang dipakai alur pembelian di all.js.
async function takeStockAtomic(productId, variantSlug, count) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const product = await Product.findOne({ id: productId }).session(session);
    if (!product) throw new Error('Produk tidak ditemukan.');

    const variant = product.variants.find(v => v.slug === variantSlug);
    if (!variant) throw new Error('Varian tidak ditemukan.');

    const available = Array.isArray(variant.stock) ? variant.stock.length : 0;
    if (available < count) {
      throw new Error(`Stok tidak mencukupi. Tersisa ${available}, diminta ${count}.`);
    }

    const taken = variant.stock.splice(0, count);
    await product.save({ session });
    await session.commitTransaction();

    return {
      taken,
      remaining: variant.stock.length,
      productName: product.name,
      variantName: variant.name
    };
  } catch (error) {
    try { await session.abortTransaction(); } catch (e) {}
    throw error;
  } finally {
    session.endSession();
  }
}

// Kembalikan akun ke posisi semula (paling depan antrean stok).
async function returnStockItems(productId, variantSlug, items) {
  const result = await Product.updateOne(
    { id: productId, 'variants.slug': variantSlug },
    { $push: { 'variants.$.stock': { $each: items, $position: 0 } } }
  );
  return result.modifiedCount > 0;
}

async function getTakeStockProductList(page = 1) {
  const products = await Product.find({}).sort({ name: 1 }).lean();
  const perPage = 5;
  const startIndex = (page - 1) * perPage;
  const paginated = products.slice(startIndex, startIndex + perPage);

  let message = '📤 *Ambil Stok*\n\nPilih produk yang stoknya mau diambil:\n\n';
  const numberButtons = [];

  if (paginated.length === 0) {
    message += '_Belum ada produk._';
  } else {
    paginated.forEach((p, index) => {
      const productNumber = startIndex + index + 1;
      const totalStock = (p.variants || []).reduce(
        (sum, v) => sum + (Array.isArray(v.stock) ? v.stock.length : 0), 0);
      message += `*${productNumber}. ${esc(p.name)}* — total ${totalStock}\n`;
      numberButtons.push(Markup.button.callback(String(productNumber), `ats_var_${p.id}_1`));
    });
  }

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️', `ats_prod_${page - 1}`));
  if (startIndex + perPage < products.length) navigationButtons.push(Markup.button.callback('➡️', `ats_prod_${page + 1}`));

  return {
    message,
    keyboard: Markup.inlineKeyboard([
      numberButtons,
      navigationButtons,
      [Markup.button.callback('⬅️ Batal', 'admin_menu')]
    ])
  };
}

async function getTakeStockVariantList(productId, page = 1) {
  const product = await Product.findOne({ id: productId }).lean();
  if (!product) {
    return {
      message: '❌ Produk tidak ditemukan.',
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'ats_prod_1')]])
    };
  }

  const perPage = 5;
  const startIndex = (page - 1) * perPage;
  const variants = product.variants || [];
  const paginated = variants.slice(startIndex, startIndex + perPage);

  const message = `📤 *Ambil Stok: ${esc(product.name)}*\n\nPilih varian:`;
  const variantButtons = paginated.map(v => {
    const stockCount = Array.isArray(v.stock) ? v.stock.length : 0;
    return [Markup.button.callback(`${v.name} (Stok: ${stockCount})`, `ats_qty:${product.id}:${v.slug}`)];
  });

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️', `ats_var_${productId}_${page - 1}`));
  if (startIndex + perPage < variants.length) navigationButtons.push(Markup.button.callback('➡️', `ats_var_${productId}_${page + 1}`));

  return {
    message,
    keyboard: Markup.inlineKeyboard([
      ...variantButtons,
      navigationButtons,
      [Markup.button.callback('⬅️ Kembali ke Produk', 'ats_prod_1')]
    ])
  };
}

async function getTakeStockQuantityScreen(productId, variantSlug) {
  const product = await Product.findOne({ id: productId }).lean();
  const variant = product && (product.variants || []).find(v => v.slug === variantSlug);

  if (!variant) {
    return {
      message: '❌ Varian tidak ditemukan.',
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'ats_prod_1')]])
    };
  }

  const available = Array.isArray(variant.stock) ? variant.stock.length : 0;
  const message = `📤 *Ambil Stok*\n\n` +
    `*Produk:* ${esc(product.name)}\n` +
    `*Varian:* ${esc(variant.name)}\n` +
    `*Stok tersedia:* ${available}\n\n` +
    (available === 0 ? '_Stok kosong, tidak ada yang bisa diambil._' : 'Mau ambil berapa akun?');

  const rows = [];
  if (available > 0) {
    const presets = [1, 5, 10, 25, 50].filter(n => n <= available);
    for (let i = 0; i < presets.length; i += 3) {
      rows.push(presets.slice(i, i + 3).map(n =>
        Markup.button.callback(String(n), `ats_ok:${productId}:${variantSlug}:${n}`)));
    }
    rows.push([
      Markup.button.callback(`📦 Semua (${available})`, `ats_ok:${productId}:${variantSlug}:${available}`),
      Markup.button.callback('✏️ Ketik jumlah', `ats_custom:${productId}:${variantSlug}`)
    ]);
  }
  rows.push([Markup.button.callback('⬅️ Kembali', `ats_var_${productId}_1`)]);

  return { message, keyboard: Markup.inlineKeyboard(rows) };
}

async function getTakeStockConfirmScreen(productId, variantSlug, count) {
  const product = await Product.findOne({ id: productId }).lean();
  const variant = product && (product.variants || []).find(v => v.slug === variantSlug);

  if (!variant) {
    return {
      message: '❌ Varian tidak ditemukan.',
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'ats_prod_1')]])
    };
  }

  const available = Array.isArray(variant.stock) ? variant.stock.length : 0;
  if (count > available) {
    return {
      message: `❌ Stok tidak cukup.\n\nDiminta: ${count}\nTersedia: ${available}`,
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', `ats_qty:${productId}:${variantSlug}`)]])
    };
  }

  const message = `⚠️ *Konfirmasi Ambil Stok*\n\n` +
    `*Produk:* ${esc(product.name)}\n` +
    `*Varian:* ${esc(variant.name)}\n` +
    `*Jumlah diambil:* ${count}\n` +
    `*Sisa setelah diambil:* ${available - count}\n\n` +
    `_Akun akan dihapus dari database dan dikirim ke sini._`;

  return {
    message,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('✅ Ya, ambil sekarang', `ats_go:${productId}:${variantSlug}:${count}`)],
      [Markup.button.callback('⬅️ Batal', `ats_qty:${productId}:${variantSlug}`)]
    ])
  };
}

// Eksekusi + kirim hasilnya ke admin.
async function performTakeStock(ctx, productId, variantSlug, count) {
  let outcome;
  try {
    outcome = await takeStockAtomic(productId, variantSlug, count);
  } catch (error) {
    console.error('Ambil stok gagal:', error.message);
    await ctx.reply(`❌ Gagal mengambil stok.\n\n${error.message}`);
    return;
  }

  const token = rememberTaken({
    productId, variantSlug,
    items: outcome.taken,
    productName: outcome.productName,
    variantName: outcome.variantName
  });

  const header = `✅ *Berhasil Ambil Stok*\n\n` +
    `*Produk:* ${esc(outcome.productName)}\n` +
    `*Varian:* ${esc(outcome.variantName)}\n` +
    `*Diambil:* ${outcome.taken.length}\n` +
    `*Sisa stok:* ${outcome.remaining}`;

  const undoKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('↩️ Kembalikan ke stok', `ats_undo:${token}`)],
    [Markup.button.callback('📤 Ambil lagi', `ats_qty:${productId}:${variantSlug}`)],
    [Markup.button.callback('⬅️ Menu Admin', 'admin_menu')]
  ]);

  // Di bawah 10 akun dikirim inline agar gampang disalin; 10 ke atas jadi file
  // .txt (sama seperti alur pembelian customer).
  if (outcome.taken.length < 10) {
    const list = outcome.taken.map((item, i) => `${i + 1}. ${item}`).join('\n');
    await ctx.reply(header + '\n\n```\n' + list + '\n```', {
      parse_mode: 'Markdown', reply_markup: undoKeyboard.reply_markup
    });
  } else {
    await ctx.reply(header, { parse_mode: 'Markdown', reply_markup: undoKeyboard.reply_markup });
    await ctx.replyWithDocument({
      source: Buffer.from(outcome.taken.join('\n'), 'utf-8'),
      filename: `ambil_${productId}_${variantSlug}_${outcome.taken.length}.txt`
    });
  }
}

// =================================================================
// EDIT VARIAN (nama / harga)
// =================================================================
async function getEditVariantMenu(productId, variantSlug, page) {
  const product = await Product.findOne({ id: productId }).lean();
  const variant = product && (product.variants || []).find(v => v.slug === variantSlug);

  if (!variant) {
    return {
      message: '❌ Varian tidak ditemukan.',
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', `admin_edit_product_${productId}_page_${page}`)]])
    };
  }

  const stockCount = Array.isArray(variant.stock) ? variant.stock.length : 0;
  const message = `📝 *Edit Varian*\n\n` +
    `*Produk:* ${esc(product.name)}\n` +
    `*Varian:* ${esc(variant.name)}\n` +
    `*Harga sekarang:* Rp ${Number(variant.price || 0).toLocaleString('id-ID')}\n` +
    `*Stok:* ${stockCount}\n\n` +
    `Mau ubah yang mana?`;

  return {
    message,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('💰 Ubah Harga', `ev_price:${productId}:${variantSlug}:${page}`)],
      [Markup.button.callback('✏️ Ubah Nama', `ev_name:${productId}:${variantSlug}:${page}`)],
      [Markup.button.callback('⬅️ Kembali', `admin_edit_product_${productId}_page_${page}`)]
    ])
  };
}

// Terima harga baru. Mengembalikan true kalau state boleh dibersihkan.
async function handleVariantPriceInput(ctx, userState) {
  const raw = (ctx.message.text || '').trim().replace(/[.,\s]/g, '');

  if (!/^\d+$/.test(raw) || parseInt(raw, 10) <= 0) {
    await ctx.reply('❌ Harga harus angka positif. Contoh: `20000`', { parse_mode: 'Markdown' });
    return false;
  }

  const newPrice = parseInt(raw, 10);
  const result = await Product.updateOne(
    { id: userState.productId, 'variants.slug': userState.variantSlug },
    { $set: { 'variants.$.price': newPrice } }
  );

  if (result.matchedCount === 0) {
    await ctx.reply('❌ Produk atau varian tidak ditemukan lagi.');
    return true;
  }

  await ctx.reply(
    `✅ *Harga berhasil diubah*\n\nHarga baru: Rp ${newPrice.toLocaleString('id-ID')}`,
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('📝 Edit varian ini lagi', `admin_edit_variant:${userState.productId}:${userState.variantSlug}:${userState.page || 1}`)],
        [Markup.button.callback('⬅️ Kembali ke Produk', `admin_edit_product_${userState.productId}_page_${userState.page || 1}`)]
      ]).reply_markup
    }
  );
  return true;
}

// Terima nama varian baru. Slug sengaja TIDAK diubah supaya stok, pesanan
// lama, dan tombol yang sudah beredar tetap menunjuk ke varian yang sama.
async function handleVariantNameInput(ctx, userState) {
  const newName = (ctx.message.text || '').trim();

  if (newName.length === 0 || newName.length > 60) {
    await ctx.reply('❌ Nama varian tidak boleh kosong dan maksimal 60 karakter.');
    return false;
  }

  const result = await Product.updateOne(
    { id: userState.productId, 'variants.slug': userState.variantSlug },
    { $set: { 'variants.$.name': newName } }
  );

  if (result.matchedCount === 0) {
    await ctx.reply('❌ Produk atau varian tidak ditemukan lagi.');
    return true;
  }

  await ctx.reply(
    `✅ *Nama varian berhasil diubah*\n\nNama baru: ${esc(newName)}`,
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('📝 Edit varian ini lagi', `admin_edit_variant:${userState.productId}:${userState.variantSlug}:${userState.page || 1}`)],
        [Markup.button.callback('⬅️ Kembali ke Produk', `admin_edit_product_${userState.productId}_page_${userState.page || 1}`)]
      ]).reply_markup
    }
  );
  return true;
}

// Dipanggil all.js saat admin mengetik jumlah custom.
async function handleTakeStockCount(ctx, userState) {
  const raw = (ctx.message.text || '').trim();
  const count = parseInt(raw, 10);

  if (!/^\d+$/.test(raw) || isNaN(count) || count <= 0) {
    await ctx.reply('❌ Masukkan angka positif saja, contoh: `15`', { parse_mode: 'Markdown' });
    return false; // state dipertahankan supaya admin bisa coba lagi
  }

  const { message, keyboard } = await getTakeStockConfirmScreen(
    userState.productId, userState.variantSlug, count);
  await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
  return true;
}

module.exports = (bot) => {
  bot.command('admin', adminMiddleware, async (ctx) => {
    const {
      message, keyboard
    } = await getAdminMenuMessageAndKeyboard();
    ctx.reply(message, {
      parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
    });
  });

  bot.action('admin_menu', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const {
      message, keyboard
    } = await getAdminMenuMessageAndKeyboard();
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
    });
  });

  bot.action('admin_broadcast', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    userStates[ctx.from.id] = {
      state: 'awaiting_broadcast_message'
    };
    await ctx.editMessageText(
      '🚀 *Broadcast Pesan*\n\nKirim pesan yang ingin Anda siarkan ke semua pengguna. Anda dapat menggunakan format Markdown.',
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          Markup.button.callback('⬅️ Batal', 'admin_menu')
        ]).reply_markup
      }
    );
  });

  bot.action('admin_profile', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const result = await getProfile();
      const data = result?.data || {};

      const msg =
      `🧾 *Profil ATL*\n\n` +
      `👤 Nama: *${data.data.name || '-'}*\n` +
      `💰 Saldo: *${data.data.balance || 0}*\n`;

      await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ Kembali', 'admin_menu')]
        ]).reply_markup
      });

    } catch (err) {
      console.error(err);
      ctx.reply('❌ Gagal memuat profil');
    }
  });
  
bot.action('admin_tf', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();

    userStates[ctx.from.id] = {
        state: 'awaiting_transfer_data',
        step: 'format'
    };

    const message = `💳 *Buat Transfer*\n\n` +
        `Kirim data transfer dengan format:\n\n` +
        `\`kode_bank|nomor_rekening|nama_pemilik|nominal\`\n\n` +
        `*Contoh 1 (dengan ref ID):*\n` +
        `\`bca|1234567890|John Doe|50000|MYREF001\`\n\n` +
        `*Contoh 2 (tanpa ref ID):*\n` +
        `\`bni|9876543210|Jane Smith|100000\`\n\n` +
        `*Bank Populer:*\n` +
        `• **Bank Umum:** bca, bni, mandiri, bri, cimb, danamon\n` +
        `• **Bank Syariah:** bsi, muamalat, bca_syar, bni_syar\n` +
        `• **Bank Digital:** jago, jenius, seabank, bcad\n` +
        `• **E-Wallet:** gopay, ovo, shopeepay, dana, linkaja\n\n` +
        `*Minimal transfer:* Rp 10.000\n` +
        `*Maksimal transfer:* Rp 100.000.000\n` +
        `*Ref ID:* Opsional (jika kosong akan dibuat otomatis)\n\n` +
        `Setelah ini, Anda bisa tambah data opsional (email, telepon, catatan).`;

    await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Batal', 'admin_menu')]
        ]).reply_markup
    });
});

bot.action('confirm_transfer_yes', adminMiddleware, async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from.id.toString();
        const userState = userStates[userId];
        
        if (!userState || !userState.transferData) {
            return ctx.editMessageText('❌ Data transfer tidak ditemukan. Silakan ulangi.');
        }

        const data = userState.transferData;
        
        // Generate refId otomatis jika kosong
        if (!data.refId || data.refId.trim() === '') {
            data.refId = `TF${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
        }
        
        // Tampilkan status proses
        await ctx.editMessageText('🔄 *Memproses transfer...*', { 
            parse_mode: 'Markdown'
        });

        // Gunakan fungsi createTransfer yang sudah diimport
        const result = await createTransfer({
            refId: data.refId,
            kodeBank: data.kodeBank,
            nomorAkun: data.nomorAkun,
            namaPemilik: data.namaPemilik,
            nominal: data.nominal,
            email: data.email || '',
            phone: data.phone || '',
            note: data.note || ''
        });

        // Reset user state
        delete userStates[userId];

        // Tampilkan hasil
        if (result.success) {
            let successMessage = `✅ *Transfer Berhasil Dibuat*\n\n` +
                `📋 **Detail Transfer:**\n` +
                `• Ref ID: \`${data.refId}\`\n` +
                `• Bank: **${data.kodeBank.toUpperCase()}**\n` +
                `• Rekening: **${data.nomorAkun}**\n` +
                `• Penerima: **${data.namaPemilik}**\n` +
                `• Nominal: **Rp ${data.nominal.toLocaleString('id-ID')}**\n`;

            if (result.data?.id) {
                successMessage += `• ID Transfer: ${result.data.id}\n`;
            }
            if (result.data?.sn) {
                successMessage += `• SN: ${result.data.sn}\n`;
            }
            if (result.data?.status) {
                successMessage += `• Status: ${result.data.status}\n`;
            }

            await ctx.editMessageText(successMessage, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ Kembali ke Menu Admin', 'admin_menu')]
                ]).reply_markup
            });

        } else {
            await ctx.editMessageText(
                `❌ *Gagal Membuat Transfer*\n\n` +
                `**Pesan Error:** ${result.message || 'Unknown error'}\n\n` +
                `**Data yang dikirim:**\n` +
                `• Ref ID: ${data.refId}\n` +
                `• Bank: ${data.kodeBank}\n` +
                `• Rekening: ${data.nomorAkun}\n` +
                `• Penerima: ${data.namaPemilik}\n` +
                `• Nominal: Rp ${data.nominal.toLocaleString('id-ID')}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('⬅️ Kembali ke Menu Admin', 'admin_menu')]
                    ]).reply_markup
                }
            );
        }

    } catch (error) {
        console.error('Transfer error:', error);
        await ctx.editMessageText(
            `❌ *Error Sistem*\n\n` +
            `${error.message}`,
            {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ Kembali ke Menu Admin', 'admin_menu')]
                ]).reply_markup
            }
        );
    }
});

// Handler batal konfirmasi
bot.action('confirm_transfer_no', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    delete userStates[userId];
    
    const { message, keyboard } = await adminModule.getAdminMenuMessageAndKeyboard();
    await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
    });
});

  bot.action(/^admin_snk_select_product_(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1]);
    const {
      message, keyboard
    } = await getProductManagementList('snk', page);
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
    });
  });

  bot.action(/^admin_snk_product_(.+?)_page_(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = ctx.match[1];
    const page = parseInt(ctx.match[2]);
    const product = await Product.findOne({
      id: productId
    }).lean();

    const message = `📜 *Kelola SNK untuk Produk: ${product.name}*\n\nPilih varian untuk melihat/mengubah SNK:`;
    const variantButtons = product.variants.map(v => {
      const snkStatus = (v.snk && v.snk !== '-') ? '✅': '❌';
      // Perhatikan perubahan di bawah ini: menggunakan ':' sebagai pemisah
      return [Markup.button.callback(`${snkStatus} ${v.name}`, `admin_edit_snk:${productId}:${v.slug}:${page}`)];
    });

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        ...variantButtons,
        [Markup.button.callback('⬅️ Kembali ke Daftar Produk', `admin_snk_select_product_${page}`)]
      ]).reply_markup
    });
  });

  bot.action(/^admin_edit_snk:(.+?):(.+?):(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = ctx.match[1];
    const variantSlug = ctx.match[2];
    const page = parseInt(ctx.match[3]);

    const product = await Product.findOne({
      id: productId
    }).lean();

    // Pengecekan agar tidak crash
    if (!product) {
      return await ctx.editMessageText('❌ Produk tidak ditemukan.');
    }

    const variant = product.variants.find(v => v.slug === variantSlug);

    userStates[ctx.from.id] = {
      state: 'awaiting_snk',
      productId: productId,
      variantSlug: variantSlug,
      page: page
    };

    const currentSnk = (variant.snk && variant.snk !== '-') ? variant.snk: '_(Kosong)_';

    const message = `✍️ *Edit SNK untuk:*\n` +
    `*Produk:* ${product.name}\n` +
    `*Varian:* ${variant.name}\n\n` +
    `*SNK Saat Ini:*\n${currentSnk}\n\n` +
    `Kirimkan teks SNK yang baru. Untuk mengosongkan, kirimkan satu karakter \`-\`.`;

    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback('⬅️ Batal', `admin_snk_product_${productId}_page_${page}`)
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
    });
  });

  bot.action(/^admin_bulk_select_product_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const page = parseInt(ctx.match[1]);
      const {
        message,
        keyboard
      } = await getProductManagementList('bulk', page);
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  bot.action(/^admin_bulk_product_(.+?)_page_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const page = parseInt(ctx.match[2]);
      const product = await Product.findOne({
        id: productId
      }).lean();

      let message = `💰 *Kelola Harga Grosir: ${product.name}*\n\nPilih varian untuk mengatur harga grosir:\n\n`;
      const variantButtons = product.variants.map(v => {
        let bulkStatus = '❌';
        if (v.bulk_pricing && v.bulk_pricing.min_quantity > 0) {
          bulkStatus = `✅ min ${v.bulk_pricing.min_quantity} pcs @ ${v.bulk_pricing.price_per_item.toLocaleString('id-ID')}`;
        }
        // Perhatikan perubahan di bawah ini: menggunakan ':' sebagai pemisah
        return [Markup.button.callback(`${v.name} (${bulkStatus})`, `admin_edit_bulk:${productId}:${v.slug}:${page}`)];
      });

      await ctx.editMessageText(message,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            ...variantButtons,
            [Markup.button.callback('⬅️ Kembali ke Daftar Produk', `admin_bulk_select_product_${page}`)]
          ]).reply_markup
        });
    });

  bot.action(/^admin_edit_bulk:(.+?):(.+?):(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = ctx.match[1];
    const variantSlug = ctx.match[2];
    const page = parseInt(ctx.match[3]);

    const product = await Product.findOne({
      id: productId
    }).lean();

    // Pengecekan penting untuk mencegah crash
    if (!product) {
      return await ctx.editMessageText('❌ Produk tidak ditemukan.');
    }

    const variant = product.variants.find(v => v.slug === variantSlug);

    userStates[ctx.from.id] = {
      state: 'awaiting_bulk_rule',
      productId: productId,
      variantSlug: variantSlug,
      page: page
    };

    let currentRule = '_(Tidak diatur)_';
    if (variant.bulk_pricing && variant.bulk_pricing.min_quantity > 0) {
      currentRule = `Minimal *${variant.bulk_pricing.min_quantity}* pcs, harga menjadi *Rp ${variant.bulk_pricing.price_per_item.toLocaleString('id-ID')}* per pcs.`;
    }

    const message = `✍️ *Atur Harga Grosir untuk:*\n` +
    `*Produk:* ${product.name}\n` +
    `*Varian:* ${variant.name}\n\n` +
    `*Aturan Saat Ini:*\n${currentRule}\n\n` +
    `Kirimkan aturan baru dengan format:\n` +
    `\`jumlah_minimum|harga_per_pcs\`\n\n` +
    `*Contoh:*\n` +
    `\`3|1000\` (artinya, pembelian min. 3 pcs harganya jadi 1000 per pcs)\n\n` +
    `Untuk menghapus aturan, kirim \`-\`.`;

    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback('⬅️ Batal', `admin_bulk_product_${productId}_page_${page}`)
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
    });
  });

  // ---------------- AMBIL STOK (admin Telegram saja) ----------------
  const editScreen = async (ctx, screen) => {
    try {
      await ctx.editMessageText(screen.message, {
        parse_mode: 'Markdown', reply_markup: screen.keyboard.reply_markup
      });
    } catch (error) {
      const description = String((error && error.description) || (error && error.message) || '');
      if (description.includes('message is not modified')) return;
      // Pesan lama tidak bisa diedit -> kirim baru supaya tombolnya tidak mati.
      await ctx.reply(screen.message, {
        parse_mode: 'Markdown', reply_markup: screen.keyboard.reply_markup
      });
    }
  };

  bot.action(/^ats_prod_(\d+)$/, adminMiddleware, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await editScreen(ctx, await getTakeStockProductList(parseInt(ctx.match[1], 10)));
    } catch (error) {
      console.error('Error ats_prod:', error);
      await ctx.reply('❌ Gagal memuat daftar produk.');
    }
  });

  bot.action(/^ats_var_(.+?)_(\d+)$/, adminMiddleware, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await editScreen(ctx, await getTakeStockVariantList(ctx.match[1], parseInt(ctx.match[2], 10)));
    } catch (error) {
      console.error('Error ats_var:', error);
      await ctx.reply('❌ Gagal memuat daftar varian.');
    }
  });

  bot.action(/^ats_qty:(.+?):(.*)$/, adminMiddleware, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      delete userStates[ctx.from.id];
      await editScreen(ctx, await getTakeStockQuantityScreen(ctx.match[1], ctx.match[2]));
    } catch (error) {
      console.error('Error ats_qty:', error);
      await ctx.reply('❌ Gagal memuat pilihan jumlah.');
    }
  });

  bot.action(/^ats_custom:(.+?):(.*)$/, adminMiddleware, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const variantSlug = ctx.match[2];
      userStates[ctx.from.id] = { state: 'awaiting_take_stock_count', productId, variantSlug };
      await editScreen(ctx, {
        message: '✏️ *Ketik jumlah akun yang mau diambil*\n\nContoh: `15`\n\n_Kirim angkanya sebagai pesan biasa._',
        keyboard: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Batal', `ats_qty:${productId}:${variantSlug}`)]])
      });
    } catch (error) {
      console.error('Error ats_custom:', error);
      await ctx.reply('❌ Gagal memproses pilihan.');
    }
  });

  bot.action(/^ats_ok:(.+?):(.+?):(\d+)$/, adminMiddleware, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await editScreen(ctx, await getTakeStockConfirmScreen(
        ctx.match[1], ctx.match[2], parseInt(ctx.match[3], 10)));
    } catch (error) {
      console.error('Error ats_ok:', error);
      await ctx.reply('❌ Gagal memuat konfirmasi.');
    }
  });

  bot.action(/^ats_go:(.+?):(.+?):(\d+)$/, adminMiddleware, async (ctx) => {
    try {
      await ctx.answerCbQuery('⏳ Mengambil stok...');
      delete userStates[ctx.from.id];
      // Tombol konfirmasi dilepas dulu supaya tidak bisa dipencet dua kali.
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
      await performTakeStock(ctx, ctx.match[1], ctx.match[2], parseInt(ctx.match[3], 10));
    } catch (error) {
      console.error('Error ats_go:', error);
      await ctx.reply('❌ Terjadi kesalahan saat mengambil stok.');
    }
  });

  bot.action(/^ats_undo:(.+)$/, adminMiddleware, async (ctx) => {
    try {
      const token = ctx.match[1];
      const entry = lastTakenStock.get(token);

      if (!entry) {
        await ctx.answerCbQuery('Sudah dikembalikan, atau bot sempat restart.', { show_alert: true });
        return;
      }
      // Hapus token DULU supaya klik ganda tidak mengembalikan dua kali.
      lastTakenStock.delete(token);
      await ctx.answerCbQuery('⏳ Mengembalikan...');

      const restored = await returnStockItems(entry.productId, entry.variantSlug, entry.items);
      if (!restored) {
        lastTakenStock.set(token, entry);
        await ctx.reply('❌ Gagal mengembalikan stok. Produk atau varian mungkin sudah dihapus.');
        return;
      }

      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
      await ctx.reply(
        `↩️ *Stok Dikembalikan*\n\n` +
        `*Produk:* ${esc(entry.productName)}\n` +
        `*Varian:* ${esc(entry.variantName)}\n` +
        `*Jumlah:* ${entry.items.length} akun kembali ke stok.`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Menu Admin', 'admin_menu')]
          ]).reply_markup
        }
      );
    } catch (error) {
      console.error('Error ats_undo:', error);
      await ctx.reply('❌ Terjadi kesalahan saat mengembalikan stok.');
    }
  });

  bot.action(/^admin_add_stock_select_product_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const page = parseInt(ctx.match[1]);
      const {
        message,
        keyboard
      } = await getAddStockProductList(page);
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  bot.action(/^admin_add_stock_select_variant_(.+?)_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const page = parseInt(ctx.match[2]);
      const {
        message,
        keyboard
      } = await getAddStockVariantList(productId, page);
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  bot.action(/^admin_add_stock_final:(.+?):(.*)$/,
    adminMiddleware,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const variantSlug = ctx.match[2];

        const product = await Product.findOne({
          id: productId
        }).lean();

        // Pengecekan penting untuk mencegah crash
        if (!product) {
          return await ctx.editMessageText(`❌ Produk dengan ID "${productId}" tidak ditemukan.`);
        }

        const variant = product.variants.find(v => v.slug === variantSlug);

        // Pengecekan tambahan jika slug varian salah
        if (!variant) {
          return await ctx.editMessageText(`❌ Varian dengan slug "${variantSlug}" tidak ditemukan di produk ini.`);
        }

        userStates[ctx.from.id] = {
          state: 'awaiting_stock',
          productId: productId,
          variantSlug: variantSlug
        };

        const message = `✅ Anda akan menambahkan stok untuk:\n` +
        `*Produk:* ${product.name}\n` +
        `*Varian:* ${variant.name}\n\n` +
        `Silakan kirim daftar akun sekarang. Formatnya satu akun per baris, contoh:\n\n` +
        `\`email1@gmail.com|pass123\`\n` +
        `\`email2@gmail.com|pass456\`\n\n` +
        `Bot akan mengabaikan baris yang kosong.`;

        const keyboard = Markup.inlineKeyboard([
          Markup.button.callback('⬅️ Batal', `admin_add_stock_select_variant_${productId}_1`)
        ]);

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
        });
      } catch(error) {
        console.error("Error in admin_add_stock_final:", error);
        // Memberikan pesan error yang lebih spesifik kepada pengguna
        await ctx.editMessageText("❌ Terjadi kesalahan internal saat memproses pilihan varian Anda.");
      }
    });

  bot.action(/^admin_edit_product_list_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const page = parseInt(ctx.match[1]);
      const {
        message,
        keyboard
      } = await getProductManagementList('edit', page);
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  // HANDLER UNTUK KONFIRMASI PENGHAPUSAN VARIAN
  bot.action(/^admin_delete_variant_confirm:(.+?):(.+?):(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const variantSlug = ctx.match[2];
        const page = parseInt(ctx.match[3]);

        const product = await Product.findOne({
          id: productId
        }).lean();

        if (!product) {
          return ctx.editMessageText(`❌ Produk dengan ID "${productId}" tidak ditemukan lagi.`);
        }

        const variant = product.variants.find(v => v.slug === variantSlug);

        if (!variant) {
          return ctx.editMessageText('❌ Varian tidak ditemukan lagi.');
        }

        const message = `⚠️ *Konfirmasi Hapus Varian*\n\n` +
        `Anda yakin ingin menghapus varian *"${variant.name}"* dari produk *"${product.name}"*?\n\n` +
        `Tindakan ini tidak dapat dibatalkan.`;

        const keyboard = Markup.inlineKeyboard([
          [
            // Perbarui juga tombol konfirmasi di sini agar polanya konsisten
            Markup.button.callback('✅ Ya, Hapus', `admin_delete_variant_execute:${productId}:${variantSlug}:${page}`),
            Markup.button.callback('❌ Batal', `admin_edit_product_${productId}_page_${page}`)
          ]
        ]);

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
        });

      } catch (error) {
        console.error('Error confirming variant deletion:', error);
        await ctx.reply('❌ Terjadi kesalahan saat meminta konfirmasi.');
      }
    });

  // HANDLER UNTUK EKSEKUSI PENGHAPUSAN VARIAN
  bot.action(/^admin_delete_variant_execute:(.+?):(.+?):(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];
        const variantSlug = ctx.match[2];
        const page = parseInt(ctx.match[3]);

        const result = await Product.updateOne(
          {
            id: productId
          },
          {
            $pull: {
              variants: {
                slug: variantSlug
              }
            }
          }
        );

        if (result.modifiedCount > 0) {
          await ctx.editMessageText(
            '✅ Varian berhasil dihapus.',
            {
              reply_markup: Markup.inlineKeyboard([
                Markup.button.callback('⬅️ Kembali ke Edit Produk', `admin_edit_product_${productId}_page_${page}`)
              ]).reply_markup
            }
          );
        } else {
          await ctx.editMessageText('❌ Gagal menghapus varian atau varian sudah tidak ada.');
        }

      } catch (error) {
        console.error('Error executing variant deletion:', error);
        await ctx.reply('❌ Terjadi kesalahan saat menghapus varian dari database.');
      }
    });

  bot.action(/^admin_delete_product_list_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const page = parseInt(ctx.match[1]);
      const {
        message,
        keyboard
      } = await getProductManagementList('delete', page);
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  bot.action(/^admin_edit_product_(.+?)_page_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const page = parseInt(ctx.match[2]);
      const {
        message,
        keyboard
      } = await getEditProductDetails(productId, page);
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });

  bot.action('admin_add_product',
    adminMiddleware,
    (ctx) => {
      ctx.editMessageText(
        'Untuk menambah produk baru, silakan kirim format berikut:\n\n`tambahproduk <id> | <nama> | <deskripsi>`\n\nContoh:\n`tambahproduk new_product | Produk Baru | Deskripsi produk baru`',
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            Markup.button.callback('⬅️ Kembali Ke Menu', 'admin_menu')
          ]).reply_markup
        }
      );
    });

  // BUG FIX: tombol '📝 Edit Varian' mengirim pola titik dua
  // (admin_edit_variant:produk:slug:halaman), tapi handler lama masih menunggu
  // pola garis bawah (admin_edit_variant_produk_slug_page_1). Tidak ada yang
  // cocok, jadi tombolnya mati total dan satu-satunya cara mengubah harga
  // adalah membuat varian baru. Pola sekarang disamakan dengan tombolnya,
  // sama seperti tombol Hapus di sebelahnya.
  bot.action(/^admin_edit_variant:(.+?):(.+?):(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();
        delete userStates[ctx.from.id];
        const screen = await getEditVariantMenu(ctx.match[1], ctx.match[2], parseInt(ctx.match[3], 10));
        await ctx.editMessageText(screen.message, {
          parse_mode: 'Markdown', reply_markup: screen.keyboard.reply_markup
        });
      } catch (error) {
        console.error('Error admin_edit_variant:', error);
        await ctx.reply('❌ Gagal memuat menu edit varian.');
      }
    });

  bot.action(/^ev_price:(.+?):(.+?):(\d+)$/, adminMiddleware, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const variantSlug = ctx.match[2];
      const page = parseInt(ctx.match[3], 10);

      const product = await Product.findOne({ id: productId }).lean();
      const variant = product && (product.variants || []).find(v => v.slug === variantSlug);
      if (!variant) return await ctx.editMessageText('❌ Varian tidak ditemukan.');

      userStates[ctx.from.id] = { state: 'awaiting_variant_price', productId, variantSlug, page };

      await ctx.editMessageText(
        `💰 *Ubah Harga*\n\n` +
        `*Varian:* ${esc(variant.name)}\n` +
        `*Harga sekarang:* Rp ${Number(variant.price || 0).toLocaleString('id-ID')}\n\n` +
        `Kirim harga barunya sebagai angka saja.\nContoh: \`20000\``,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Batal', `admin_edit_variant:${productId}:${variantSlug}:${page}`)]
          ]).reply_markup
        }
      );
    } catch (error) {
      console.error('Error ev_price:', error);
      await ctx.reply('❌ Gagal membuka ubah harga.');
    }
  });

  bot.action(/^ev_name:(.+?):(.+?):(\d+)$/, adminMiddleware, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const variantSlug = ctx.match[2];
      const page = parseInt(ctx.match[3], 10);

      const product = await Product.findOne({ id: productId }).lean();
      const variant = product && (product.variants || []).find(v => v.slug === variantSlug);
      if (!variant) return await ctx.editMessageText('❌ Varian tidak ditemukan.');

      userStates[ctx.from.id] = { state: 'awaiting_variant_name', productId, variantSlug, page };

      await ctx.editMessageText(
        `✏️ *Ubah Nama Varian*\n\n` +
        `*Nama sekarang:* ${esc(variant.name)}\n\n` +
        `Kirim nama barunya.\nContoh: \`1 Bulan Sharing\`\n\n` +
        `_Slug tidak ikut berubah, jadi stok dan pesanan lama tetap aman._`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Batal', `admin_edit_variant:${productId}:${variantSlug}:${page}`)]
          ]).reply_markup
        }
      );
    } catch (error) {
      console.error('Error ev_name:', error);
      await ctx.reply('❌ Gagal membuka ubah nama.');
    }
  });

  bot.action(/^admin_delete_product_(.+?)_page_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const productId = ctx.match[1];

        await deleteProduct(productId);

        await ctx.editMessageText(
          '✅ Produk berhasil dihapus!',
          {
            reply_markup: Markup.inlineKeyboard([
              Markup.button.callback('⬅️ Kembali ke Menu Admin', 'admin_menu')
            ]).reply_markup
          }
        );
      } catch (error) {
        console.error('Error deleting product:', error);
        await ctx.reply('❌ Terjadi kesalahan saat menghapus produk. Mohon coba lagi nanti.');
      }
    });

  bot.action(/^admin_edit_name_desc_(.+?)_page_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const page = parseInt(ctx.match[2]);

      try {
        const product = await Product.findOne({
          id: productId
        }).lean();

        userStates[ctx.from.id] = {
          state: 'edit_product_name_desc',
          productId: productId,
          page: page
        };

        const message = `✍️ *Edit Nama & Deskripsi Produk:* ${product.name}\n\n` +
        `Silakan kirim nama dan deskripsi baru dalam format:\n\n` +
        `\`<Nama Baru> | <Deskripsi Baru>\`\n\n` +
        `Contoh:\n` +
        `\`CAPCUT Pro NEW | Versi terbaru.\``;

        const keyboard = Markup.inlineKeyboard([
          Markup.button.callback('⬅️ Batal', `admin_edit_product_${productId}_page_${page}`)
        ]);

        await ctx.editMessageText(message, {
          parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
        });
      } catch (error) {
        console.error('Error in admin_edit_name_desc:', error);
        await ctx.editMessageText('❌ Produk tidak ditemukan.');
      }
    });

  bot.action(/^admin_add_variant_(.+?)_page_(\d+)$/,
    adminMiddleware,
    async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const page = parseInt(ctx.match[2]);

      userStates[ctx.from.id] = {
        state: 'add_new_variant',
        productId: productId,
        page: page
      };

      const message = `➕ *Tambah Varian Baru*\n\n` +
      `Silakan kirim detailnya dalam format berikut:\n\n` +
      `\`<Nama Varian> | <Harga> | <Slug Varian>\`\n\n` +
      `*Contoh:*\n` +
      `\`1 Bulan | 15000 | 1_bulan\``;

      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('⬅️ Batal', `admin_edit_product_${productId}_page_${page}`)
      ]);

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown', reply_markup: keyboard.reply_markup
      });
    });
};

module.exports.getAdminMenuMessageAndKeyboard = getAdminMenuMessageAndKeyboard;
module.exports.addStock = addStock;
module.exports.userStates = userStates;
module.exports.adminMiddleware = adminMiddleware;
module.exports.handleTakeStockCount = handleTakeStockCount;
module.exports.handleVariantPriceInput = handleVariantPriceInput;
module.exports.handleVariantNameInput = handleVariantNameInput;
module.exports.takeStockAtomic = takeStockAtomic;