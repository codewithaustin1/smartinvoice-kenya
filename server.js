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

// Create Paystack Subaccount for a business
app.post('/api/create-subaccount', async (req, res) => {
    const { business_name, settlement_bank, account_number, account_name, percentage_charge, email, phone } = req.body;
    
    try {
        // For test mode, skip subaccount creation
        if (!process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY.includes('test')) {
            console.log('Test mode: Skipping subaccount creation');
            res.json({ 
                success: true, 
                subaccount_code: null,
                message: 'Test mode: Subaccount creation skipped'
            });
            return;
        }
        
        const response = await fetch('https://api.paystack.co/subaccount', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                business_name: business_name,
                settlement_bank: settlement_bank,
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
            res.json({ 
                success: true, 
                subaccount_code: data.data.subaccount_code,
                message: 'Subaccount created successfully'
            });
        } else {
            console.error('Paystack subaccount error:', data);
            res.json({ 
                success: false, 
                subaccount_code: null,
                error: data.message
            });
        }
    } catch (error) {
        console.error('Server error:', error);
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
        
        // Get the base URL from environment or use localhost for development
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        
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
        
        // Only add subaccount if we have a valid one
        const isValidSubaccount = subaccountCode && 
                                   subaccountCode !== 'null' && 
                                   subaccountCode !== 'undefined' && 
                                   subaccountCode !== '' &&
                                   subaccountCode !== 'SUB_ACCOUNT_PLACEHOLDER' &&
                                   !subaccountCode.includes('PLACEHOLDER');
        
        if (isValidSubaccount) {
            requestBody.subaccount = subaccountCode;
            console.log('✅ Adding subaccount:', subaccountCode);
        } else {
            console.log('⚠️ No valid subaccount - payment goes to platform account');
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
            console.log('✅ Payment link created');
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
            if (invoiceId && invoices.has(invoiceId)) {
                const invoice = invoices.get(invoiceId);
                invoice.paid = true;
                invoice.paidAt = new Date().toISOString();
                invoice.reference = reference;
                invoice.paymentMethod = data.data.channel;
                invoices.set(invoiceId, invoice);
                console.log(`✅ Invoice ${invoiceId} marked as paid`);
                
                // Update user's invoice in localStorage (client will refresh)
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
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`💰 Currency: Kenyan Shillings (KES)`);
    console.log(`💳 Paystack Key: ${process.env.PAYSTACK_SECRET_KEY ? '✓ Configured' : '✗ Missing'}`);
    console.log(`💸 Platform fee: ${PLATFORM_FEE}%`);
    console.log(`========================================`);
    console.log(`\n📝 Test Card: 4242 4242 4242 4242`);
    console.log(`📝 Any future expiry date`);
    console.log(`📝 Any CVC (e.g., 123)`);
    console.log(`📝 Test OTP: 123456`);
    console.log(`\n⚠️ Note: In test mode, payments go to your platform account`);
    console.log(`⚠️ Subaccount feature requires live keys and verification\n`);
});