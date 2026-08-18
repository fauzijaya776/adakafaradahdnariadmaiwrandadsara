// migrate.js (REVISED)
const fs = require('fs').promises;
const path = require('path');
const { connectDB, Product, User, Order } = require('./db');
const mongoose = require('mongoose');

async function migrate() {
    console.log('Connecting to MongoDB...');
    await connectDB();
    console.log('MongoDB connected.');

    // 1. Migrasi Pengguna (users.json)
    try {
        console.log('Migrating users...');
        const usersPath = path.join(__dirname, 'database', 'users.json');
        const usersData = JSON.parse(await fs.readFile(usersPath, 'utf8'));
        const usersToInsert = Object.values(usersData).map(u => ({
            id: u.id.toString(),
            username: u.username,
            balance: u.balance || 0,
            totalSpent: u.totalSpent || 0,
        }));
        await User.deleteMany({});
        await User.insertMany(usersToInsert, { ordered: false });
        console.log(`${usersToInsert.length} users migrated successfully.`);
    } catch (error) {
        if (error.code === 11000) {
            console.warn('Warning: Some duplicate users were skipped.');
        } else {
            console.error('An error occurred during user migration:', error);
        }
    }

    // 2. Migrasi Produk (aplikasi.json)
    try {
        console.log('Migrating products...');
        const productsPath = path.join(__dirname, 'database', 'aplikasi.json');
        const productsData = JSON.parse(await fs.readFile(productsPath, 'utf8'));
        await Product.deleteMany({});
        await Product.insertMany(productsData.products, { ordered: false });
        console.log(`${productsData.products.length} products migrated successfully.`);
    } catch (error) {
        if (error.code === 11000) {
            console.warn('Warning: Some duplicate products were skipped.');
        } else {
            console.error('An error occurred during product migration:', error);
        }
    }

    // 3. Migrasi Pesanan (orders.json)
    try {
        console.log('Migrating orders...');
        const ordersPath = path.join(__dirname, 'database', 'orders.json');
        const ordersData = JSON.parse(await fs.readFile(ordersPath, 'utf8'));
        await Order.deleteMany({});
        await Order.insertMany(ordersData, { ordered: false });
        console.log(`${ordersData.length} orders migrated successfully.`);
    } catch (error) {
        if (error.code === 11000) {
            console.warn('Warning: Some duplicate orders were skipped.');
        } else {
            console.error('An error occurred during order migration:', error);
        }
    }

    // Selalu tutup koneksi di akhir
    await mongoose.connection.close();
    console.log('\nMigration finished! ✨');
    console.log('MongoDB connection closed.');
}

migrate();