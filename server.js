require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE_PERCENTAGE) || 0.5;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Store invoices in memory (use database in production)
const invoices = new Map();

// Determine if we're in LIVE mode or TEST mode
// LIVE keys start with 'sk_live_', TEST keys start with 'sk_test_'
const isLiveMode = process.env.PAYSTACK_SECRET_KEY && 
                    process.env.PAYSTACK_SECRET_KEY.startsWith('sk_live_');
const isTestMode = !isLiveMode;

console.log(`💳 Paystack Mode: ${isLiveMode ? '🔴 LIVE' : '🟡 TEST'}`);

// Kenyan bank codes for Paystack (CORRECTED)
const paystackBankCodes = {
    // Kenyan Banks - Use Paystack's expected codes
    'KCB': '044',
    'Equity': '068',
    'Cooperative': '011',
    'Absa': '035',
    'Stanbic': '031',
    'Standard Chartered': '021',
    'NCBA': '030',
    'Diamond Trust': '063',
    'I&M': '070',
    'Family Bank': '063',  // Family Bank uses same as DTB
    // Add more banks as needed
    'KCB Bank': '044',
    'Equity Bank': '068',
    'Cooperative Bank': '011',
    'Absa Bank': '035',
    'Stanbic Bank': '031',
    'Standard Chartered Bank': '021',
    'NCBA Bank': '030',
    'Diamond Trust Bank': '063',
    'I&M Bank': '070',
    'Family Bank': '063'
};

// Create Paystack Subaccount for a business
app.post('/api/create-subaccount', async (req, res) => {
    const { business_name, settlement_bank, account_number, account_name, percentage_charge, email, phone } = req.body;
    
    try {
        // In test mode, skip subaccount creation
        if (isTestMode) {
            console.log('Test mode: Skipping subaccount creation');
            res.json({ 
                success: true, 
                subaccount_code: null,
                message: 'Test mode: Subaccount creation skipped'
            });
            return;
        }
        
        // LIVE MODE: Create actual Paystack subaccount
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
        
        // Get the base URL from environment
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
        
        // CRITICAL: Only add subaccount if we have a valid one and we're in LIVE mode
        // Paystack subaccount codes start with 'ACCT_'
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
            console.log('💰 Payment will go directly to business bank account');
            console.log('💸 Your 0.5% fee will be automatically deducted');
        } else if (isLiveMode) {
            console.log('⚠️ LIVE MODE: No valid subaccount - payment will go to platform account');
            console.log('⚠️ Businesses must have subaccounts to receive direct payments');
        } else {
            console.log('⚠️ TEST MODE: Payment goes to platform account');
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
            if (isValidSubaccount) {
                console.log('🏦 Settlement will go to business bank account in 24-48 hours');
                console.log('💸 Platform fee (0.5%) will be automatically deducted');
            }
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
    console.log('Mode:', isLiveMode ? 'LIVE' : 'TEST');
    
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
            if (invoiceId && invoices.has(invoiceId)) {
                const invoice = invoices.get(invoiceId);
                invoice.paid = true;
                invoice.paidAt = new Date().toISOString();
                invoice.reference = reference;
                invoice.paymentMethod = data.data.channel;
                invoice.subaccount = data.data.subaccount;
                invoices.set(invoiceId, invoice);
                console.log(`✅ Invoice ${invoiceId} marked as paid`);
                
                // In LIVE mode, you might want to send email notifications
                if (isLiveMode) {
                    console.log(`💰 LIVE PAYMENT: KES ${invoice.total} received`);
                    if (data.data.subaccount) {
                        console.log(`🏦 Payment went to subaccount: ${data.data.subaccount}`);
                        console.log(`💸 Platform fee (0.5%) automatically deducted`);
                    } else {
                        console.log(`⚠️ Payment went to platform account - manual settlement needed`);
                    }
                }
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

// Save invoice
app.post('/api/save-invoice', (req, res) => {
    const { invoice } = req.body;
    const invoiceId = crypto.randomBytes(8).toString('hex');
    const newInvoice = {
        ...invoice,
        id: invoiceId,
        createdAt: new Date().toISOString(),
        paid: false
    };
    invoices.set(invoiceId, newInvoice);
    console.log(`✅ Invoice saved: ${invoiceId}`);
    res.json({ success: true, invoiceId });
});

// Get invoice
app.get('/api/invoice/:id', (req, res) => {
    const invoice = invoices.get(req.params.id);
    if (invoice) {
        res.json(invoice);
    } else {
        res.status(404).json({ error: 'Invoice not found' });
    }
});

// Get all invoices
app.get('/api/invoices', (req, res) => {
    const allInvoices = Array.from(invoices.values());
    res.json(allInvoices);
});

// Payment callback page
app.get('/payment-callback.html', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Payment Complete - SmartInvoice Kenya</title>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
                <p>You will receive a confirmation email shortly.</p>
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
                    }).then(() => {
                        console.log('Payment verified');
                    }).catch(err => {
                        console.error('Verification failed:', err);
                    });
                }
            </script>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 SmartInvoice Kenya Server Running`);
    console.log(`📍 ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
    console.log(`💰 Currency: Kenyan Shillings (KES)`);
    console.log(`💳 Mode: ${isLiveMode ? '🔴 LIVE' : '🟡 TEST'}`);
    console.log(`💸 Platform fee: ${PLATFORM_FEE}%`);
    console.log(`========================================`);
    
    if (isTestMode) {
        console.log(`\n📝 TEST MODE INSTRUCTIONS:`);
        console.log(`📝 Test Card: 4242 4242 4242 4242`);
        console.log(`📝 Any future expiry date`);
        console.log(`📝 Any CVC (e.g., 123)`);
        console.log(`📝 Test OTP: 123456\n`);
    } else {
        console.log(`\n🔴 LIVE MODE ACTIVE - Real payments will be processed`);
        console.log(`💰 Money goes to: ${process.env.PAYSTACK_SECRET_KEY ? 'Your Paystack account' : 'Not configured'}`);
        console.log(`⚠️ Test with small amounts first (e.g., KES 100)`);
        console.log(`🏦 Settlement to your bank: 2-3 business days\n`);
        console.log(`📌 SUBACCOUNT FEATURE ACTIVE:`);
        console.log(`   - Businesses with valid subaccounts: Direct settlement`);
        console.log(`   - Platform fee (0.5%): Automatically deducted`);
        console.log(`   - Settlement time: 24-48 hours to business bank\n`);
    }
});