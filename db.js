const { MongoClient } = require('mongodb');

// MongoDB Connection URL from environment variable
const uri = process.env.MONGODB_URI;
let client = null;
let db = null;

// Connect to MongoDB
async function connectDB() {
    try {
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
        console.error('❌ MongoDB Connection Error:', error);
        throw error;
    }
}

// Create indexes for faster queries
async function createIndexes() {
    try {
        const usersCollection = db.collection('users');
        await usersCollection.createIndex({ email: 1 }, { unique: true });
        await usersCollection.createIndex({ businessName: 1 });
        
        const invoicesCollection = db.collection('invoices');
        await invoicesCollection.createIndex({ userId: 1 });
        await invoicesCollection.createIndex({ createdAt: -1 });
        await invoicesCollection.createIndex({ id: 1 }, { unique: true });
        
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

// Simple hash function (temporary - use bcrypt in production)
function hashPassword(password) {
    let hash = 0;
    for (let i = 0; i < password.length; i++) {
        const char = password.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString();
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
    hashPassword,
    closeDB
};