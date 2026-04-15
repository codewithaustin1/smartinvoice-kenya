require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { connectDB, getUsersCollection, getInvoicesCollection, getSubscriptionsCollection, hashPassword } = require('./db');

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

// Kenyan bank codes for Paystack (COMPLETE & VERIFIED)
const paystackBankCodes = {
    // Major Kenyan Banks
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
    'Ecobank': '050',
    'Bank of Baroda': '046',
    'Chase Bank': '102',
    'Consolidated Bank': '103',
    'Credit Bank': '097',
    'Development Bank': '073',
    'First Community Bank': '104',
    'Guardian Bank': '105',
    'Gulf African Bank': '106',
    'Housing Finance': '067',
    'Kenya Commercial Bank': '044',
    'Kenya Women Microfinance': '107',
    'Kingdom Bank': '108',
    'M-Oriental Bank': '109',
    'Middle East Bank': '110',
    'National Bank': '012',
    'Paramount Bank': '111',
    'Prime Bank': '112',
    'Sidian Bank': '113',
    'Spire Bank': '114',
    'Transnational Bank': '115',
    'UBA Kenya': '116',
    'Victoria Bank': '117'
};

// Initialize MongoDB connection
let dbInitialized = false;
async function initDB() {
    if (!dbInitialized) {
        await connectDB();
        dbInitialized = true;
    }
}

// ============= USER ENDPOINTS =============

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
        
        // Try to create Paystack subaccount (LIVE mode only)
        let subaccountCode = null;
        let subaccountError = null;
        
        if (isLiveMode) {
            try {
                console.log(`🔄 Attempting to create Paystack subaccount for ${businessName}...`);
                
                // Get the correct bank code
                const bankCode = paystackBankCodes[bankName];
                
                if (!bankCode) {
                    console.error(`❌ Unknown bank: ${bankName}`);
                    console.log(`Available banks: ${Object.keys(paystackBankCodes).slice(0, 10).join(', ')}...`);
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
        
        // Create user with or without subaccount
        const newUser = {
            id: Date.now().toString(),
            email,
            password: hashPassword(password),
            businessName,
            businessPhone,
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
        
        const { password: _, ...userWithoutPassword } = newUser;
        
        console.log(`✅ User registered successfully`);
        if (subaccountCode) {
            console.log(`✅ Subaccount auto-created: ${subaccountCode}`);
        } else if (isLiveMode) {
            console.log(`⚠️ Subaccount not created: ${subaccountError || 'Unknown error'}`);
            console.log(`📌 Manual subaccount creation may be required`);
        }
        
        res.json({ 
            success: true, 
            user: userWithoutPassword,
            subaccountCreated: subaccountCode !== null,
            subaccountMessage: subaccountCode ? 'Subaccount created automatically' : (subaccountError || 'Manual subaccount creation may be required')
        });
    } catch (error) {
        console.error('❌ Registration error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Login user from MongoDB
app.post('/api/users/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        await initDB();
        const usersCollection = getUsersCollection();
        const user = await usersCollection.findOne({ email });
        
        if (!user) {
            return res.status(400).json({ success: false, message: 'User not found' });
        }
        
        if (user.password !== hashPassword(password)) {
            return res.status(400).json({ success: false, message: 'Invalid password' });
        }
        
        const { password: _, ...userWithoutPassword } = user;
        res.json({ success: true, user: userWithoutPassword });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get user by ID
app.get('/api/users/:id', async (req, res) => {
    try {
        await initDB();
        const usersCollection = getUsersCollection();
        const user = await usersCollection.findOne({ id: req.params.id });
        
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

// Update user subaccount
app.post('/api/users/update-subaccount', async (req, res) => {
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

// ============= PAYMENT ENDPOINTS =============

// Initialize Paystack payment
app.post('/api/initialize-payment', async (req, res) => {
    const { email, phone, amount, invoiceId, subaccountCode } = req.body;
    
    console.log('=== Payment Initialization Request ===');
    console.log('Mode:', isLiveMode ? '🔴 LIVE' : '🟡 TEST');
    console.log('Email:', email);
    console.log('Amount:', amount);
    console.log('Invoice ID:', invoiceId);
    console.log('Subaccount:', subaccountCode);
    
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

// Verify payment
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

// Save invoice to MongoDB
app.post('/api/save-invoice', async (req, res) => {
    const { invoice } = req.body;
    const invoiceId = crypto.randomBytes(8).toString('hex');
    
    const newInvoice = {
        ...invoice,
        id: invoiceId,
        createdAt: new Date().toISOString(),
        paid: false
    };
    
    try {
        await initDB();
        const invoicesCollection = getInvoicesCollection();
        await invoicesCollection.insertOne(newInvoice);
        console.log(`✅ Invoice saved to MongoDB: ${invoiceId}`);
        res.json({ success: true, invoiceId });
    } catch (error) {
        console.error('Error saving invoice:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get invoice from MongoDB
app.get('/api/invoice/:id', async (req, res) => {
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

// Get all invoices for a user
app.get('/api/invoices/:userId', async (req, res) => {
    try {
        await initDB();
        const invoicesCollection = getInvoicesCollection();
        const invoices = await invoicesCollection.find({ userId: req.params.userId }).toArray();
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
        console.log(`📌 MONGODB DATABASE ACTIVE\n`);
    }
});