// Authentication System for SmartInvoice Kenya with Paystack Subaccounts
class Auth {
    constructor() {
        this.users = JSON.parse(localStorage.getItem('smartinvoice_users') || '[]');
        this.currentUser = JSON.parse(localStorage.getItem('smartinvoice_currentUser') || 'null');
        this.subscriptions = JSON.parse(localStorage.getItem('smartinvoice_subscriptions') || '{}');
        this.platformFee = 0.5; // 0.5% platform fee (hardcoded for client-side)
    }

    // Create Paystack Subaccount for business
    async createPaystackSubaccount(businessName, email, phone, bankName, accountNumber, accountName) {
        try {
            // Map Kenyan bank names to Paystack bank codes
            const bankCodes = {
                'KCB': 'KCB',
                'Equity': 'EQUITY',
                'Cooperative': 'COOP',
                'Absa': 'ABSA',
                'Stanbic': 'STANBIC',
                'Standard Chartered': 'SCB',
                'NCBA': 'NCBA',
                'Diamond Trust': 'DTB',
                'I&M': 'IMB',
                'Family Bank': 'FAMILY'
            };
            
            const bankCode = bankCodes[bankName] || bankName;
            
            const response = await fetch('/api/create-subaccount', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    business_name: businessName,
                    settlement_bank: bankCode,
                    account_number: accountNumber,
                    account_name: accountName,
                    percentage_charge: this.platformFee,
                    email: email,
                    phone: phone
                })
            });
            
            const data = await response.json();
            
            if (data.success && data.subaccount_code) {
                return data.subaccount_code;
            } else {
                console.error('Subaccount creation failed:', data.error);
                // Return null instead of a placeholder - this prevents sending invalid subaccount to Paystack
                return null;
            }
        } catch (error) {
            console.error('Error creating subaccount:', error);
            return null;
        }
    }

    // Register new business with bank details
    async register(email, password, businessName, businessPhone, bankName, accountNumber, accountName) {
        // Check if user exists
        if (this.users.find(u => u.email === email)) {
            return {
                success: false,
                message: 'Email already registered. Please login instead.'
            };
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@([^\s@]+\.)+[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return {
                success: false,
                message: 'Please enter a valid email address.'
            };
        }

        // Validate password strength
        if (password.length < 6) {
            return {
                success: false,
                message: 'Password must be at least 6 characters long.'
            };
        }

        // Validate phone number (Kenyan format)
        const phoneRegex = /^254[0-9]{9}$/;
        if (!phoneRegex.test(businessPhone)) {
            return {
                success: false,
                message: 'Please enter a valid Kenyan phone number (e.g., 254712345678)'
            };
        }

        // Validate bank details
        if (!bankName || !accountNumber || !accountName) {
            return {
                success: false,
                message: 'Please provide all bank details for payment settlements'
            };
        }

        // Create Paystack subaccount for the business
        let subaccountCode = null;
        try {
            subaccountCode = await this.createPaystackSubaccount(
                businessName, email, businessPhone, bankName, accountNumber, accountName
            );
        } catch (error) {
            console.error('Subaccount creation error:', error);
        }

        // In test mode, we can proceed without a subaccount
        // The payment will go to your platform account instead
        // In production, you'd want to ensure subaccount creation succeeds

        // Create new user
        const newUser = {
            id: Date.now().toString(),
            email: email,
            password: this.hashPassword(password),
            businessName: businessName,
            businessPhone: businessPhone,
            bankDetails: {
                bankName: bankName,
                accountNumber: accountNumber,
                accountName: accountName,
                subaccountCode: subaccountCode // This can be null in test mode
            },
            createdAt: new Date().toISOString(),
            invoices: [],
            settings: {
                currency: 'KES',
                taxRate: 0,
                logo: null
            }
        };

        this.users.push(newUser);
        this.saveUsers();
        
        // Auto-login after registration
        this.currentUser = newUser;
        localStorage.setItem('smartinvoice_currentUser', JSON.stringify(newUser));
        
        // Create free subscription
        this.subscriptions[email] = {
            plan: 'free',
            startDate: new Date().toISOString(),
            expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            invoiceCount: 0,
            invoiceLimit: 5
        };
        this.saveSubscriptions();

        return {
            success: true,
            message: 'Account created successfully! You have 30 days free trial with 5 invoices.',
            user: {
                id: newUser.id,
                email: newUser.email,
                businessName: newUser.businessName,
                subaccountCode: subaccountCode
            }
        };
    }

    // Login user
    login(email, password) {
        const user = this.users.find(u => u.email === email);
        
        if (!user) {
            return {
                success: false,
                message: 'Email not found. Please register first.'
            };
        }

        if (user.password !== this.hashPassword(password)) {
            return {
                success: false,
                message: 'Incorrect password. Please try again.'
            };
        }

        this.currentUser = user;
        localStorage.setItem('smartinvoice_currentUser', JSON.stringify(user));
        
        return {
            success: true,
            message: 'Login successful!',
            user: {
                id: user.id,
                email: user.email,
                businessName: user.businessName
            }
        };
    }

    // Logout user
    logout() {
        this.currentUser = null;
        localStorage.removeItem('smartinvoice_currentUser');
        return { success: true, message: 'Logged out successfully' };
    }

    // Check if user is logged in
    isLoggedIn() {
        return this.currentUser !== null;
    }

    // Get current user
    getCurrentUser() {
        return this.currentUser;
    }

    // Get user's Paystack subaccount code (returns null if not available)
    getSubaccountCode() {
        if (!this.currentUser) return null;
        const code = this.currentUser.bankDetails?.subaccountCode;
        // Only return if it's a valid-looking subaccount code (starts with ACCT_ or similar)
        if (code && code !== 'SUB_ACCOUNT_PLACEHOLDER' && code !== 'null' && code !== 'undefined') {
            return code;
        }
        return null;
    }

    // Get user subscription status
    getSubscription() {
        if (!this.currentUser) return null;
        
        const sub = this.subscriptions[this.currentUser.email];
        if (!sub) return { plan: 'free', invoiceLimit: 5, active: true };
        
        const isActive = new Date(sub.expiry) > new Date();
        
        return {
            plan: sub.plan,
            invoiceLimit: sub.invoiceLimit,
            active: isActive,
            expiry: sub.expiry,
            invoiceCount: sub.invoiceCount || 0
        };
    }

    // Check if user can create more invoices
    canCreateInvoice() {
        const sub = this.getSubscription();
        if (!sub) return { allowed: false, message: 'Please login first' };
        
        if (!sub.active) {
            return { allowed: false, message: 'Your subscription has expired. Please upgrade to continue.' };
        }
        
        if (sub.invoiceCount >= sub.invoiceLimit) {
            return { 
                allowed: false, 
                message: `You've reached your ${sub.invoiceLimit} invoice limit. Upgrade to Pro for unlimited invoices.`,
                limit: sub.invoiceLimit,
                count: sub.invoiceCount
            };
        }
        
        return { allowed: true };
    }

    // Increment invoice count for current user
    incrementInvoiceCount() {
        if (!this.currentUser) return;
        
        const sub = this.subscriptions[this.currentUser.email];
        if (sub) {
            sub.invoiceCount = (sub.invoiceCount || 0) + 1;
            this.saveSubscriptions();
        }
    }

    // Save user's invoice
    saveInvoiceToUser(invoiceId, invoiceData) {
        if (!this.currentUser) return;
        
        const user = this.users.find(u => u.email === this.currentUser.email);
        if (user) {
            user.invoices.push({
                id: invoiceId,
                ...invoiceData,
                createdAt: new Date().toISOString()
            });
            this.saveUsers();
            this.currentUser = user;
            localStorage.setItem('smartinvoice_currentUser', JSON.stringify(user));
        }
    }

    // Get user's invoices
    getUserInvoices() {
        if (!this.currentUser) return [];
        const user = this.users.find(u => u.email === this.currentUser.email);
        return user ? user.invoices : [];
    }

    // Helper: Simple hash (in production, use bcrypt)
    hashPassword(password) {
        let hash = 0;
        for (let i = 0; i < password.length; i++) {
            const char = password.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString();
    }

    // Save users to localStorage
    saveUsers() {
        localStorage.setItem('smartinvoice_users', JSON.stringify(this.users));
    }

    // Save subscriptions to localStorage
    saveSubscriptions() {
        localStorage.setItem('smartinvoice_subscriptions', JSON.stringify(this.subscriptions));
    }

    // Update subscription (for when user upgrades)
    updateSubscription(email, plan) {
        const plans = {
            free: { limit: 5, price: 0 },
            pro: { limit: Infinity, price: 1500 },
            business: { limit: Infinity, price: 4500 }
        };
        
        this.subscriptions[email] = {
            plan: plan,
            startDate: new Date().toISOString(),
            expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            invoiceCount: this.subscriptions[email]?.invoiceCount || 0,
            invoiceLimit: plans[plan].limit
        };
        
        this.saveSubscriptions();
        return { success: true, plan: plan };
    }
}

// Initialize auth globally
const auth = new Auth();