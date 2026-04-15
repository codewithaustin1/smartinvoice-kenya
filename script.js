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

// Handle form submission - Updated for JWT
document.getElementById('invoiceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // Check if user is logged in
    if (typeof auth !== 'undefined' && auth) {
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
        alert('Please login to create invoices');
        window.location.href = 'login.html';
        return;
    }
    
    // Collect invoice data (same as before)
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
    
    const generateBtn = document.getElementById('generateBtn');
    generateBtn.classList.add('loading');
    generateBtn.disabled = true;
    
    try {
        // Use authenticated fetch to save invoice
        const saveResponse = await authenticatedFetch('/api/save-invoice', {
            method: 'POST',
            body: JSON.stringify({ invoice: invoiceData })
        });
        
        const saveResult = await saveResponse.json();
        currentInvoiceId = saveResult.invoiceId;
        
        auth.saveInvoiceToUser(currentInvoiceId, invoiceData);
        auth.incrementInvoiceCount();
        
        const subaccountCode = auth.getSubaccountCode();
        
        // Use authenticated fetch for payment initialization
        const paymentResponse = await authenticatedFetch('/api/initialize-payment', {
            method: 'POST',
            body: JSON.stringify({
                email: invoiceData.clientEmail,
                phone: invoiceData.clientPhone,
                amount: total,
                invoiceId: currentInvoiceId,
                subaccountCode: subaccountCode
            })
        });
        
        const paymentResult = await paymentResponse.json();
        
        // Show preview (same as before)
        const previewContent = `...`; // Keep existing preview content
        
        document.getElementById('previewContent').innerHTML = previewContent;
        document.getElementById('invoicePreview').style.display = 'block';
        generateBtn.textContent = '✅ Invoice Generated!';
        
        document.getElementById('copyLinkBtn').onclick = () => {
            navigator.clipboard.writeText(paymentResult.authorization_url);
            alert('✅ Payment link copied to clipboard!');
        };
        
        document.getElementById('invoicePreview').scrollIntoView({ behavior: 'smooth' });
        
    } catch (error) {
        console.error('Error:', error);
        alert('Error generating invoice. Please try again.');
        generateBtn.classList.remove('loading');
        generateBtn.disabled = false;
    }
});

// Add authenticatedFetch helper at the bottom of script.js
async function authenticatedFetch(url, options = {}) {
    const token = auth.getToken();
    
    options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };
    
    let response = await fetch(url, options);
    
    if (response.status === 401) {
        const refreshed = await auth.refreshSession();
        if (refreshed) {
            options.headers['Authorization'] = `Bearer ${auth.getToken()}`;
            response = await fetch(url, options);
        } else {
            window.location.href = 'login.html';
            throw new Error('Session expired');
        }
    }
    
    return response;
}

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