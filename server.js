require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { 
    connectDB, 
    getUsersCollection, 
    getInvoicesCollection, 
    getSubscriptionsCollection,
    getRefreshTokensCollection,
    hashPassword,
    verifyPassword,
    migratePasswordIfNeeded
} = require('./db');
const { generateToken, generateRefreshToken, verifyToken } = require('./utils/tokens');
const { verifyToken: authMiddleware, optionalAuth, requireRole } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE_PERCENTAGE) || 0.5;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Determine if we're in LIVE mode or TEST mode
const isLiveMode = process.env.PAYSTACK_SECRET_KEY && 
                    process.env.PAYSTACK_SECRET_KEY.startsWith('sk_live_');
const isTestMode = !isLiveMode;

console.log(`💳 Paystack Mode: ${isLiveMode ? '🔴 LIVE' : '🟡 TEST'}`);

// Kenyan bank codes for Paystack
const paystackBankCodes = {
    'KCB': '044',
    'Equity': '068',
    'Cooperative': '011',
    'Absa': '035',
    'Stanbic': '031',
    'Standard Chartered': '021',
    'NCBA': '030',
    'Diamond Trust': '063',
    'I&M': '070',
    'Family Bank': '063',
    'Guaranty Trust Bank': '058',
    'Bank of Africa': '043',
    'Citibank': '024',
    'Ecobank': '050'
};

// Initialize MongoDB connection
let dbInitialized = false;
async function initDB() {
    if (!dbInitialized) {
        await connectDB();
        dbInitialized = true;
    }
}

// ============= AUTHENTICATION ENDPOINTS =============

// Register user in MongoDB with auto-subaccount creation
app.post('/api/users/register', async (req, res) => {
    const { email, password, businessName, businessPhone, bankName, accountNumber, accountName } = req.body;
    
    console.log('========================================');
    console.log('📝 REGISTRATION REQUEST');
    console.log(`Business: ${businessName}`);
    console.log(`Email: ${email}`);
    console.log(`Bank: ${bankName}, Account: ${accountNumber}`);
    
    try {
        await initDB();
        const usersCollection = getUsersCollection();
        
        // Check if user exists
        const existingUser = await usersCollection.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Email already registered' });
        }
        
        // Hash password with bcrypt
        const hashedPassword = await hashPassword(password);
        
        // Try to create Paystack subaccount (LIVE mode only)
        let subaccountCode = null;
        let subaccountError = null;
        
        if (isLiveMode) {
            try {
                console.log(`🔄 Attempting to create Paystack subaccount for ${businessName}...`);
                
                const bankCode = paystackBankCodes[bankName];
                
                if (!bankCode) {
                    subaccountError = `Bank "${bankName}" not recognized. Please contact support.`;
                } else {
                    console.log(`Bank code: ${bankCode} (mapped from ${bankName})`);
                    
                    const response = await fetch('https://api.paystack.co/subaccount', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            business_name: businessName,
                            settlement_bank: bankCode,
                            account_number: accountNumber,
                            account_name: accountName,
                            percentage_charge: PLATFORM_FEE,
                            primary_contact_email: email,
                            primary_contact_phone: businessPhone,
                            metadata: {
                                platform: 'SmartInvoice Kenya',
                                registered_at: new Date().toISOString()
                            }
                        })
                    });
                    
                    const data = await response.json();
                    
                    if (data.status) {
                        subaccountCode = data.data.subaccount_code;
                        console.log(`✅ Subaccount created: ${subaccountCode}`);
                    } else {
                        subaccountError = data.message;
                        console.error(`❌ Paystack error: ${data.message}`);
                    }
                }
            } catch (error) {
                subaccountError = error.message;
                console.error(`❌ Subaccount creation error: ${error.message}`);
            }
        } else {
            console.log('Test mode: Skipping subaccount creation');
        }
        
        // Create new user
        const newUser = {
            id: Date.now().toString(),
            email,
            password: hashedPassword,
            businessName,
            businessPhone,
            role: 'business',
            bankDetails: {
                bankName,
                accountNumber,
                accountName,
                subaccountCode: subaccountCode,
                subaccountError: subaccountError
            },
            createdAt: new Date().toISOString(),
            invoices: [],
            settings: { currency: 'KES', taxRate: 0, logo: null }
        };
        
        await usersCollection.insertOne(newUser);
        
        // Create subscription
        const subscriptionsCollection = getSubscriptionsCollection();
        await subscriptionsCollection.insertOne({
            email,
            plan: 'free',
            startDate: new Date().toISOString(),
            expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            invoiceCount: 0,
            invoiceLimit: 5
        });
        
        // Generate JWT token for auto-login
        const token = generateToken(newUser);
        const refreshToken = generateRefreshToken(newUser);
        
        // Store refresh token
        const refreshTokensCollection = getRefreshTokensCollection();
        await refreshTokensCollection.insertOne({
            userId: newUser.id,
            token: refreshToken,
            createdAt: new Date()
        });
        
        const { password: _, ...userWithoutPassword } = newUser;
        
        console.log(`✅ User registered successfully`);
        if (subaccountCode) {
            console.log(`✅ Subaccount auto-created: ${subaccountCode}`);
        }
        
        res.json({ 
            success: true, 
            user: userWithoutPassword,
            token,
            refreshToken,
            subaccountCreated: subaccountCode !== null,
            subaccountMessage: subaccountCode ? 'Subaccount created automatically' : (subaccountError || 'Manual subaccount creation may be required')
        });
    } catch (error) {
        console.error('❌ Registration error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Login user with JWT token
app.post('/api/users/login', async (req, res) => {
    const { email, password } = req.body;
    
    console.log('🔐 Login attempt:', email);
    
    try {
        await initDB();
        const usersCollection = getUsersCollection();
        const user = await usersCollection.findOne({ email });
        
        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }
        
        // Migrate old password hash if needed
        let isValid = await verifyPassword(password, user.password);
        
        if (!isValid) {
            // Try old hash format (for backward compatibility)
            const { migratePasswordIfNeeded } = require('./db');
            const migratedHash = await migratePasswordIfNeeded(user, password);
            isValid = await verifyPassword(password, migratedHash);
            
            if (!isValid) {
                return res.status(401).json({ success: false, message: 'Invalid email or password' });
            }
        }
        
        // Generate tokens
        const token = generateToken(user);
        const refreshToken = generateRefreshToken(user);
        
        // Store refresh token
        const refreshTokensCollection = getRefreshTokensCollection();
        await refreshTokensCollection.insertOne({
            userId: user.id,
            token: refreshToken,
            createdAt: new Date()
        });
        
        // Remove password from response
        const { password: _, ...userWithoutPassword } = user;
        
        console.log(`✅ Login successful: ${email}`);
        
        res.json({ 
            success: true, 
            user: userWithoutPassword,
            token,
            refreshToken
        });
    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Refresh token endpoint
app.post('/api/users/refresh', async (req, res) => {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
        return res.status(400).json({ success: false, message: 'Refresh token required' });
    }
    
    try {
        await initDB();
        const refreshTokensCollection = getRefreshTokensCollection();
        
        // Verify refresh token exists in database
        const storedToken = await refreshTokensCollection.findOne({ token: refreshToken });
        if (!storedToken) {
            return res.status(401).json({ success: false, message: 'Invalid refresh token' });
        }
        
        // Verify token signature
        const decoded = verifyToken(refreshToken);
        if (!decoded || decoded.type !== 'refresh') {
            return res.status(401).json({ success: false, message: 'Invalid refresh token' });
        }
        
        // Get user
        const usersCollection = getUsersCollection();
        const user = await usersCollection.findOne({ id: decoded.id });
        
        if (!user) {
            return res.status(401).json({ success: false, message: 'User not found' });
        }
        
        // Generate new tokens
        const newToken = generateToken(user);
        const newRefreshToken = generateRefreshToken(user);
        
        // Replace refresh token
        await refreshTokensCollection.deleteOne({ token: refreshToken });
        await refreshTokensCollection.insertOne({
            userId: user.id,
            token: newRefreshToken,
            createdAt: new Date()
        });
        
        const { password: _, ...userWithoutPassword } = user;
        
        res.json({
            success: true,
            user: userWithoutPassword,
            token: newToken,
            refreshToken: newRefreshToken
        });
    } catch (error) {
        console.error('❌ Refresh error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Logout endpoint
app.post('/api/users/logout', authMiddleware, async (req, res) => {
    const { refreshToken } = req.body;
    
    try {
        await initDB();
        
        // Remove refresh token if provided
        if (refreshToken) {
            const refreshTokensCollection = getRefreshTokensCollection();
            await refreshTokensCollection.deleteOne({ token: refreshToken });
        }
        
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('❌ Logout error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get current user (from token)
app.get('/api/users/me', authMiddleware, async (req, res) => {
    try {
        await initDB();
        const usersCollection = getUsersCollection();
        const user = await usersCollection.findOne({ id: req.user.id });
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        const { password: _, ...userWithoutPassword } = user;
        res.json({ success: true, user: userWithoutPassword });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update user subaccount (protected)
app.post('/api/users/update-subaccount', authMiddleware, requireRole('superadmin'), async (req, res) => {
    const { userId, subaccountCode } = req.body;
    
    try {
        await initDB();
        const usersCollection = getUsersCollection();
        
        const result = await usersCollection.updateOne(
            { id: userId },
            { $set: { 'bankDetails.subaccountCode': subaccountCode, 'bankDetails.subaccountError': null } }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        res.json({ success: true, message: 'Subaccount updated' });
    } catch (error) {
        console.error('Error updating subaccount:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============= PAYMENT ENDPOINTS (PROTECTED) =============

// Create Paystack Subaccount for a business
app.post('/api/create-subaccount', authMiddleware, async (req, res) => {
    const { business_name, settlement_bank, account_number, account_name, percentage_charge, email, phone } = req.body;
    
    try {
        if (isTestMode) {
            console.log('Test mode: Skipping subaccount creation');
            res.json({ 
                success: true, 
                subaccount_code: null,
                message: 'Test mode: Subaccount creation skipped'
            });
            return;
        }
        
        console.log(`🔴 LIVE MODE: Creating subaccount for ${business_name}`);
        console.log(`Bank: ${settlement_bank}, Account: ${account_number}`);
        
        const bankCode = paystackBankCodes[settlement_bank] || settlement_bank;
        
        const response = await fetch('https://api.paystack.co/subaccount', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                business_name: business_name,
                settlement_bank: bankCode,
                account_number: account_number,
                account_name: account_name,
                percentage_charge: percentage_charge,
                primary_contact_email: email,
                primary_contact_phone: phone,
                metadata: {
                    platform: 'SmartInvoice Kenya',
                    registered_at: new Date().toISOString()
                }
            })
        });
        
        const data = await response.json();
        
        if (data.status) {
            console.log(`✅ Subaccount created: ${data.data.subaccount_code}`);
            res.json({ 
                success: true, 
                subaccount_code: data.data.subaccount_code,
                message: 'Subaccount created successfully'
            });
        } else {
            console.error('❌ Paystack subaccount error:', data);
            res.json({ 
                success: false, 
                subaccount_code: null,
                error: data.message
            });
        }
    } catch (error) {
        console.error('❌ Server error:', error);
        res.json({ 
            success: false, 
            subaccount_code: null,
            error: error.message
        });
    }
});

// Initialize Paystack payment
app.post('/api/initialize-payment', authMiddleware, async (req, res) => {
    const { email, phone, amount, invoiceId, subaccountCode } = req.body;
    
    console.log('=== Payment Initialization Request ===');
    console.log('User:', req.user.email);
    console.log('Amount:', amount);
    console.log('Invoice ID:', invoiceId);
    
    try {
        if (!process.env.PAYSTACK_SECRET_KEY) {
            console.error('PAYSTACK_SECRET_KEY is not set');
            return res.status(500).json({ 
                error: 'Payment gateway not configured' 
            });
        }
        
        const amountInCents = Math.round(amount * 100);
        const baseUrl = process.env.RENDER_EXTERNAL_URL || 
                       process.env.APP_URL || 
                       `http://localhost:${PORT}`;
        
        const requestBody = {
            email: email,
            amount: amountInCents,
            currency: 'KES',
            callback_url: `${baseUrl}/payment-callback.html`,
            metadata: {
                invoiceId: invoiceId,
                phone: phone,
                platform_fee: (amount * PLATFORM_FEE / 100),
                userId: req.user.id,
                custom_fields: [
                    {
                        display_name: "Invoice ID",
                        variable_name: "invoice_id",
                        value: invoiceId
                    },
                    {
                        display_name: "Phone Number",
                        variable_name: "phone",
                        value: phone
                    }
                ]
            }
        };
        
        const isValidSubaccount = isLiveMode && 
                                   subaccountCode && 
                                   subaccountCode !== 'null' && 
                                   subaccountCode !== 'undefined' && 
                                   subaccountCode !== '' &&
                                   !subaccountCode.includes('PLACEHOLDER') &&
                                   !subaccountCode.includes('TEST') &&
                                   subaccountCode.startsWith('ACCT_');
        
        if (isValidSubaccount) {
            requestBody.subaccount = subaccountCode;
            console.log('✅ Adding subaccount for direct business settlement:', subaccountCode);
        } else if (isLiveMode) {
            console.log('⚠️ LIVE MODE: No valid subaccount - payment will go to platform account');
        }
        
        console.log('Sending request to Paystack...');
        
        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });
        
        const data = await response.json();
        
        if (data.status) {
            console.log('✅ Payment link created:', data.data.authorization_url);
            res.json({ 
                authorization_url: data.data.authorization_url, 
                reference: data.data.reference 
            });
        } else {
            console.error('❌ Paystack error:', data.message);
            res.status(400).json({ 
                error: data.message || 'Payment initialization failed' 
            });
        }
    } catch (error) {
        console.error('❌ Server error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Verify payment (webhook - no auth needed)
app.post('/api/verify-payment', async (req, res) => {
    const { reference } = req.body;
    
    console.log('Verifying payment for reference:', reference);
    
    try {
        const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            }
        });
        
        const data = await response.json();
        
        if (data.data && data.data.status === 'success') {
            const invoiceId = data.data.metadata?.invoiceId;
            if (invoiceId) {
                await initDB();
                const invoicesCollection = getInvoicesCollection();
                await invoicesCollection.updateOne(
                    { id: invoiceId },
                    { 
                        $set: { 
                            paid: true,
                            paidAt: new Date().toISOString(),
                            reference: reference,
                            paymentMethod: data.data.channel,
                            subaccount: data.data.subaccount
                        }
                    }
                );
                console.log(`✅ Invoice ${invoiceId} marked as paid in MongoDB`);
            }
            res.json({ success: true, data: data.data });
        } else {
            console.log('Payment not successful:', data.data?.status);
            res.json({ success: false, message: 'Payment not successful' });
        }
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Save invoice to MongoDB (protected)
app.post('/api/save-invoice', authMiddleware, async (req, res) => {
    const { invoice } = req.body;
    const invoiceId = crypto.randomBytes(8).toString('hex');
    
    const newInvoice = {
        ...invoice,
        id: invoiceId,
        userId: req.user.id,
        createdAt: new Date().toISOString(),
        paid: false
    };
    
    try {
        await initDB();
        const invoicesCollection = getInvoicesCollection();
        await invoicesCollection.insertOne(newInvoice);
        console.log(`✅ Invoice saved to MongoDB: ${invoiceId} for user ${req.user.email}`);
        res.json({ success: true, invoiceId });
    } catch (error) {
        console.error('Error saving invoice:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get invoice from MongoDB
app.get('/api/invoice/:id', optionalAuth, async (req, res) => {
    try {
        await initDB();
        const invoicesCollection = getInvoicesCollection();
        const invoice = await invoicesCollection.findOne({ id: req.params.id });
        if (invoice) {
            res.json(invoice);
        } else {
            res.status(404).json({ error: 'Invoice not found' });
        }
    } catch (error) {
        console.error('Error fetching invoice:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all invoices for current user (protected)
app.get('/api/invoices/me', authMiddleware, async (req, res) => {
    try {
        await initDB();
        const invoicesCollection = getInvoicesCollection();
        const invoices = await invoicesCollection.find({ userId: req.user.id }).toArray();
        res.json(invoices);
    } catch (error) {
        console.error('Error fetching invoices:', error);
        res.status(500).json({ error: error.message });
    }
});

// Payment callback page
app.get('/payment-callback.html', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Payment Complete - SmartInvoice Kenya</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    margin: 0;
                    padding: 20px;
                }
                .container {
                    background: white;
                    border-radius: 20px;
                    padding: 40px;
                    text-align: center;
                    max-width: 500px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                }
                .success {
                    color: #059669;
                    font-size: 48px;
                    margin-bottom: 20px;
                }
                .btn {
                    display: inline-block;
                    background: linear-gradient(135deg, #667eea, #764ba2);
                    color: white;
                    padding: 12px 24px;
                    border-radius: 8px;
                    text-decoration: none;
                    margin-top: 20px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="success">✓</div>
                <h1>Payment Received!</h1>
                <p>Your payment has been processed successfully.</p>
                <a href="/dashboard.html" class="btn">Return to Dashboard</a>
            </div>
            <script>
                const urlParams = new URLSearchParams(window.location.search);
                const reference = urlParams.get('reference');
                if (reference) {
                    fetch('/api/verify-payment', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reference })
                    });
                }
            </script>
        </body>
        </html>
    `);
});

// Start server
app.listen(PORT, async () => {
    console.log(`========================================`);
    console.log(`🚀 SmartInvoice Kenya Server Running`);
    console.log(`📍 ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
    console.log(`💰 Currency: Kenyan Shillings (KES)`);
    console.log(`💳 Mode: ${isLiveMode ? '🔴 LIVE' : '🟡 TEST'}`);
    console.log(`💸 Platform fee: ${PLATFORM_FEE}%`);
    console.log(`🔐 JWT Authentication: ${process.env.JWT_SECRET ? '✓ Enabled' : '✗ Missing'}`);
    console.log(`========================================`);
    
    // Initialize MongoDB connection
    try {
        await initDB();
        console.log(`✅ MongoDB Atlas Connected`);
    } catch (error) {
        console.error(`❌ MongoDB Connection Failed:`, error.message);
    }
    
    if (isTestMode) {
        console.log(`\n📝 TEST MODE INSTRUCTIONS:`);
        console.log(`📝 Test Card: 4242 4242 4242 4242`);
        console.log(`📝 Test OTP: 123456\n`);
    } else {
        console.log(`\n🔴 LIVE MODE ACTIVE - Real payments will be processed`);
        console.log(`📌 SUBACCOUNT FEATURE ACTIVE`);
        console.log(`📌 MONGODB DATABASE ACTIVE`);
        console.log(`📌 JWT AUTHENTICATION ACTIVE\n`);
    }
});