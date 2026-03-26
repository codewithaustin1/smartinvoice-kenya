let currentInvoiceId = null;

// Calculate totals whenever items change
function calculateTotals() {
    const items = document.querySelectorAll('.invoice-item');
    let subtotal = 0;
    
    items.forEach(item => {
        const qty = parseFloat(item.querySelector('.item-qty').value) || 0;
        const price = parseFloat(item.querySelector('.item-price').value) || 0;
        subtotal += qty * price;
    });
    
    // Show estimated fee (user will see actual fee during payment)
    const estimatedCardFee = (subtotal * 0.029) + 20; // 2.9% + KES 20
    const estimatedMpesaFee = subtotal * 0.015; // 1.5% for M-PESA
    
    // For display, show card fee as maximum possible
    const displayFee = estimatedCardFee;
    const total = subtotal + displayFee;
    
    document.getElementById('subtotal').textContent = `KES ${subtotal.toLocaleString()}`;
    document.getElementById('fee').textContent = `KES ${displayFee.toLocaleString()} (actual fee varies by payment method)`;
    document.getElementById('total').textContent = `KES ${total.toLocaleString()}`;
    
    return { subtotal, fee: displayFee, total };
}

// Add new item row
document.getElementById('addItemBtn').addEventListener('click', () => {
    const container = document.getElementById('itemsContainer');
    const newItem = document.createElement('div');
    newItem.className = 'invoice-item';
    newItem.innerHTML = `
        <input type="text" placeholder="Item description" class="item-desc" required>
        <input type="number" placeholder="Quantity" class="item-qty" required>
        <input type="number" placeholder="Price (KES)" class="item-price" required>
        <button type="button" class="remove-item" onclick="removeItem(this)">×</button>
    `;
    container.appendChild(newItem);
    
    // Add event listeners to new inputs
    const inputs = newItem.querySelectorAll('input');
    inputs.forEach(input => {
        input.addEventListener('input', calculateTotals);
    });
});

// Remove item
window.removeItem = function(button) {
    const container = document.getElementById('itemsContainer');
    if (container.children.length > 1) {
        button.closest('.invoice-item').remove();
        calculateTotals();
    } else {
        alert('You need at least one item');
    }
};

// Add event listeners to existing inputs
document.querySelectorAll('.invoice-item input').forEach(input => {
    input.addEventListener('input', calculateTotals);
});

// Initial calculation
calculateTotals();

// Handle form submission
document.getElementById('invoiceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // Check if user is logged in
    if (typeof auth !== 'undefined' && auth) {
        // Check if user can create more invoices
        const canCreate = auth.canCreateInvoice();
        if (!canCreate.allowed) {
            alert(canCreate.message);
            if (canCreate.limit && canCreate.count >= canCreate.limit) {
                if (confirm('Upgrade to Pro for unlimited invoices?')) {
                    window.location.href = 'pricing.html';
                }
            }
            return;
        }
    } else {
        // If auth not loaded, redirect to login
        alert('Please login to create invoices');
        window.location.href = 'login.html';
        return;
    }
    
    // Collect invoice data
    const items = [];
    document.querySelectorAll('.invoice-item').forEach(item => {
        items.push({
            description: item.querySelector('.item-desc').value,
            quantity: parseFloat(item.querySelector('.item-qty').value),
            price: parseFloat(item.querySelector('.item-price').value)
        });
    });
    
    const { total } = calculateTotals();
    
    const currentUser = auth.getCurrentUser();
    
    const invoiceData = {
        businessName: document.getElementById('businessName').value,
        businessEmail: document.getElementById('businessEmail').value,
        clientName: document.getElementById('clientName').value,
        clientEmail: document.getElementById('clientEmail').value,
        clientPhone: document.getElementById('clientPhone').value,
        items: items,
        dueDate: document.getElementById('dueDate').value,
        notes: document.getElementById('notes').value,
        total: total,
        userId: currentUser.id,
        businessId: currentUser.email
    };
    
    // Show loading state
    const generateBtn = document.getElementById('generateBtn');
    generateBtn.classList.add('loading');
    generateBtn.disabled = true;
    
    try {
        // Save invoice
        const saveResponse = await fetch('/api/save-invoice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoice: invoiceData })
        });
        
        const saveResult = await saveResponse.json();
        currentInvoiceId = saveResult.invoiceId;
        
        // Save to user's account
        auth.saveInvoiceToUser(currentInvoiceId, invoiceData);
        auth.incrementInvoiceCount();
        
        // Get the business's Paystack subaccount code
        const subaccountCode = auth.getSubaccountCode();
        
        // Initialize Paystack payment with subaccount
        const paymentResponse = await fetch('/api/initialize-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: invoiceData.clientEmail,
                phone: invoiceData.clientPhone,
                amount: total,
                invoiceId: currentInvoiceId,
                subaccountCode: subaccountCode // CRITICAL: This routes payment to business's account
            })
        });
        
        const paymentResult = await paymentResponse.json();
        
        // Show preview and payment link
        const previewContent = `
            <div style="font-family: monospace;">
                <strong>🧾 Invoice #${currentInvoiceId.slice(0, 8).toUpperCase()}</strong><br><br>
                <strong>To:</strong> ${invoiceData.clientName}<br>
                <strong>📧 Email:</strong> ${invoiceData.clientEmail}<br>
                <strong>📱 Phone:</strong> ${invoiceData.clientPhone}<br>
                <strong>💰 Amount:</strong> <span style="color: #059669; font-size: 1.2em;">KES ${total.toLocaleString()}</span><br>
                <strong>📅 Due Date:</strong> ${invoiceData.dueDate}<br>
                <strong>📊 Status:</strong> <span style="color: #d97706;">⏳ Awaiting Payment</span><br><br>
                <div class="payment-link">
                    <strong>💳 Payment Link:</strong><br>
                    <span style="font-size: 0.85em; word-break: break-all;">${paymentResult.authorization_url}</span>
                </div>
                <strong>✅ Payment Methods:</strong> M-PESA, Airtel Money, or Card<br>
                <strong>🏦 Payment Goes To:</strong> Your bank account (settlement in 24-48 hours)<br><br>
                <a href="${paymentResult.authorization_url}" target="_blank" class="btn-primary" style="display: inline-block; text-decoration: none; text-align: center; width: 100%;">🔗 Pay Now with M-PESA/Card</a>
            </div>
        `;
        
        document.getElementById('previewContent').innerHTML = previewContent;
        document.getElementById('invoicePreview').style.display = 'block';
        generateBtn.textContent = '✅ Invoice Generated!';
        
        // Copy link functionality
        document.getElementById('copyLinkBtn').onclick = () => {
            navigator.clipboard.writeText(paymentResult.authorization_url);
            alert('✅ Payment link copied to clipboard!\n\nShare this link with your client via WhatsApp or email.\n\nPayments go directly to your bank account.');
        };
        
        // Scroll to preview
        document.getElementById('invoicePreview').scrollIntoView({ behavior: 'smooth' });
        
    } catch (error) {
        console.error('Error:', error);
        alert('Error generating invoice. Please try again.');
        generateBtn.classList.remove('loading');
        generateBtn.disabled = false;
    }
});

// Set default due date to 7 days from now
const dueDateInput = document.getElementById('dueDate');
const defaultDate = new Date();
defaultDate.setDate(defaultDate.getDate() + 7);
dueDateInput.value = defaultDate.toISOString().split('T')[0];

// Add phone number validation
const phoneInput = document.getElementById('clientPhone');
if (phoneInput) {
    phoneInput.addEventListener('input', function(e) {
        let value = e.target.value.replace(/\D/g, '');
        if (value.startsWith('0')) {
            value = '254' + value.substring(1);
        }
        if (!value.startsWith('254') && value.length > 0) {
            value = '254' + value;
        }
        if (value.length > 12) {
            value = value.substring(0, 12);
        }
        e.target.value = value;
    });
}