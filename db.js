const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected...');
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
};

// Skema untuk Variant dalam Produk
const VariantSchema = new mongoose.Schema({
    name: String,
    slug: { type: String },
    price: Number,
    stock: [String],
    reserved_stock: [String],
    snk: { type: String, default: '-' },
    bulk_pricing: {
        min_quantity: Number,
        price_per_item: Number,
    }
});

// Skema untuk Produk
const ProductSchema = new mongoose.Schema({
    id: { type: String, unique: true, required: true },
    name: String,
    description: String,
    variants: [VariantSchema]
});

// Skema untuk Pengguna
const UserSchema = new mongoose.Schema({
    id: { type: String, unique: true, required: true },
    username: String,
    balance: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 }
});

// Skema untuk Pesanan
const OrderSchema = new mongoose.Schema({
    orderId: { type: String, unique: true, required: true },
    internalRefId: String,
    depositId: String,
    amount: Number,
    status: { type: String, enum: ['PENDING', 'PAID', 'CANCELLED', 'EXPIRED', 'FAILED'], default: 'PENDING' },
    createdAt: { type: Date, default: Date.now },
    paidAt: Date,
    cancelledAt: Date,
    productId: String,
    variantSlug: String,
    productName: String,
    variantName: String,
    quantity: Number,
    reservedItems: [String],
    customerInfo: {
        telegramUserId: String,
        first_name: String,
    },
    paymentGateway: String,
    paymentDetails: Object
});

const SettingsSchema = new mongoose.Schema({
    // Dibuat unik agar hanya ada satu dokumen pengaturan
    identifier: { type: String, default: 'global-settings', unique: true }, 
    linkqu_enabled: { type: Boolean, default: true },
    dana_enabled: { type: Boolean, default: true },
    tokopay_enabled: { type: Boolean, default: true },
});

const Settings = mongoose.model('Settings', SettingsSchema);
const Product = mongoose.model('Product', ProductSchema);
const User = mongoose.model('User', UserSchema);
const Order = mongoose.model('Order', OrderSchema);

module.exports = {
    connectDB,
    Product,
    User,
    Order,
    Settings
};