const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');

// MongoDB Connection URL from environment variable
const uri = process.env.MONGODB_URI;
let client = null;
let db = null;

// Salt rounds for bcrypt password hashing
const SALT_ROUNDS = 10;

// Connect to MongoDB
async function connectDB() {
    try {
        if (!uri) {
            throw new Error('MONGODB_URI is not defined in environment variables');
        }
        
        console.log('📡 Attempting to connect to MongoDB Atlas...');
        
        if (!db) {
            client = new MongoClient(uri);
            await client.connect();
            db = client.db('smartinvoice_kenya');
            console.log('✅ MongoDB Connected successfully');
            
            // Create indexes for better performance
            await createIndexes();
        }
        return db;
    } catch (error) {
        console.error('❌ MongoDB Connection Error:', error.message);
        console.error('Please check your MONGODB_URI in .env file');
        throw error;
    }
}

// Create indexes for faster queries
async function createIndexes() {
    try {
        const usersCollection = db.collection('users');
        await usersCollection.createIndex({ email: 1 }, { unique: true });
        await usersCollection.createIndex({ businessName: 1 });
        await usersCollection.createIndex({ id: 1 }, { unique: true });
        
        const invoicesCollection = db.collection('invoices');
        await invoicesCollection.createIndex({ userId: 1 });
        await invoicesCollection.createIndex({ createdAt: -1 });
        await invoicesCollection.createIndex({ id: 1 }, { unique: true });
        
        const subscriptionsCollection = db.collection('subscriptions');
        await subscriptionsCollection.createIndex({ email: 1 }, { unique: true });
        
        const refreshTokensCollection = db.collection('refresh_tokens');
        await refreshTokensCollection.createIndex({ userId: 1 });
        await refreshTokensCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 2592000 }); // 30 days TTL
        
        console.log('✅ Database indexes created');
    } catch (error) {
        console.error('Index creation error:', error);
    }
}

// Get collection references
function getUsersCollection() {
    if (!db) throw new Error('Database not connected');
    return db.collection('users');
}

function getInvoicesCollection() {
    if (!db) throw new Error('Database not connected');
    return db.collection('invoices');
}

function getSubscriptionsCollection() {
    if (!db) throw new Error('Database not connected');
    return db.collection('subscriptions');
}

function getRefreshTokensCollection() {
    if (!db) throw new Error('Database not connected');
    return db.collection('refresh_tokens');
}

// Hash password using bcrypt
async function hashPassword(password) {
    try {
        const salt = await bcrypt.genSalt(SALT_ROUNDS);
        const hash = await bcrypt.hash(password, salt);
        return hash;
    } catch (error) {
        console.error('Password hashing error:', error);
        throw error;
    }
}

// Verify password against hash
async function verifyPassword(password, hash) {
    try {
        return await bcrypt.compare(password, hash);
    } catch (error) {
        console.error('Password verification error:', error);
        return false;
    }
}

// Migrate old simple hash to bcrypt (for existing users)
async function migratePasswordIfNeeded(user, plainPassword) {
    // Check if password looks like old simple hash (numeric only)
    const isOldHash = /^\d+$/.test(user.password);
    
    if (isOldHash) {
        console.log(`🔄 Migrating password for user: ${user.email}`);
        const newHash = await hashPassword(plainPassword);
        const usersCollection = getUsersCollection();
        await usersCollection.updateOne(
            { id: user.id },
            { $set: { password: newHash, passwordMigrated: true } }
        );
        return newHash;
    }
    
    return user.password;
}

// Close connection
async function closeDB() {
    if (client) {
        await client.close();
        console.log('MongoDB connection closed');
    }
}

module.exports = {
    connectDB,
    getUsersCollection,
    getInvoicesCollection,
    getSubscriptionsCollection,
    getRefreshTokensCollection,
    hashPassword,
    verifyPassword,
    migratePasswordIfNeeded,
    closeDB
};