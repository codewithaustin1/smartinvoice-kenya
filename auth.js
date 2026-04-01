// Authentication System for SmartInvoice Kenya with MongoDB
class Auth {
    constructor() {
        this.currentUser = JSON.parse(localStorage.getItem('smartinvoice_currentUser') || 'null');
        this.platformFee = 0.5;
    }

    // Register new business - MongoDB version
    async register(email, password, businessName, businessPhone, bankName, accountNumber, accountName) {
        // Validate inputs
        const emailRegex = /^[^\s@]+@([^\s@]+\.)+[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return { success: false, message: 'Please enter a valid email address.' };
        }

        if (password.length < 6) {
            return { success: false, message: 'Password must be at least 6 characters long.' };
        }

        const phoneRegex = /^254[0-9]{9}$/;
        if (!phoneRegex.test(businessPhone)) {
            return { success: false, message: 'Please enter a valid Kenyan phone number (e.g., 254712345678)' };
        }

        if (!bankName || !accountNumber || !accountName) {
            return { success: false, message: 'Please provide all bank details for payment settlements' };
        }

        try {
            const response = await fetch('/api/users/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email, password, businessName, businessPhone, 
                    bankName, accountNumber, accountName
                })
            });
            
            const result = await response.json();
            
            if (result.success) {
                localStorage.setItem('smartinvoice_currentUser', JSON.stringify(result.user));
                this.currentUser = result.user;
                
                return {
                    success: true,
                    message: 'Account created successfully! You have 30 days free trial with 5 invoices.',
                    user: result.user
                };
            } else {
                return result;
            }
        } catch (error) {
            console.error('Registration error:', error);
            return { success: false, message: 'Registration failed. Please try again.' };
        }
    }

    // Login user - MongoDB version
    async login(email, password) {
        try {
            const response = await fetch('/api/users/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            
            const result = await response.json();
            
            if (result.success) {
                this.currentUser = result.user;
                localStorage.setItem('smartinvoice_currentUser', JSON.stringify(result.user));
                return {
                    success: true,
                    message: 'Login successful!',
                    user: result.user
                };
            } else {
                return result;
            }
        } catch (error) {
            console.error('Login error:', error);
            return { success: false, message: 'Login failed. Please try again.' };
        }
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

    // Get user's Paystack subaccount code
    getSubaccountCode() {
        if (!this.currentUser) return null;
        const code = this.currentUser.bankDetails?.subaccountCode;
        if (code && code !== 'null' && code !== 'undefined' && 
            code.startsWith('ACCT_') && code.length > 10) {
            return code;
        }
        return null;
    }

    // Get user subscription status - from server
    async fetchSubscription() {
        if (!this.currentUser) return null;
        
        try {
            const response = await fetch(`/api/users/${this.currentUser.id}/subscription`);
            const result = await response.json();
            if (result.success) {
                return result.subscription;
            }
        } catch (error) {
            console.error('Error fetching subscription:', error);
        }
        
        // Fallback to local
        return {
            plan: 'free',
            invoiceLimit: 5,
            active: true,
            expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            invoiceCount: this.currentUser.invoices?.length || 0
        };
    }

    // Get user subscription (sync version for UI)
    getSubscription() {
        if (!this.currentUser) return null;
        
        // For now, return free plan
        return {
            plan: 'free',
            invoiceLimit: 5,
            active: true,
            expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            invoiceCount: this.currentUser.invoices?.length || 0
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
        // Will be handled by MongoDB when invoice is saved
    }

    // Save user's invoice
    saveInvoiceToUser(invoiceId, invoiceData) {
        if (!this.currentUser) return;
        
        if (!this.currentUser.invoices) {
            this.currentUser.invoices = [];
        }
        this.currentUser.invoices.push({
            id: invoiceId,
            ...invoiceData,
            createdAt: new Date().toISOString()
        });
        
        localStorage.setItem('smartinvoice_currentUser', JSON.stringify(this.currentUser));
    }

    // Get user's invoices
    getUserInvoices() {
        if (!this.currentUser) return [];
        return this.currentUser.invoices || [];
    }
}

// Initialize auth globally
const auth = new Auth();