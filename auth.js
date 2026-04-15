// Authentication System for SmartInvoice Kenya with JWT Tokens
class Auth {
    constructor() {
        // Try to restore session from localStorage
        const storedToken = localStorage.getItem('smartinvoice_token');
        const storedUser = localStorage.getItem('smartinvoice_currentUser');
        
        this.token = storedToken || null;
        this.currentUser = storedUser ? JSON.parse(storedUser) : null;
        this.refreshToken = localStorage.getItem('smartinvoice_refreshToken') || null;
        this.platformFee = 0.5;
        
        console.log('🔐 Auth initialized. User:', this.currentUser?.email || 'Not logged in');
        console.log('🔐 Token present:', !!this.token);
    }

    // Get authorization header for API calls
    getAuthHeader() {
        if (!this.token) {
            return {};
        }
        return {
            'Authorization': `Bearer ${this.token}`
        };
    }

    // Refresh the JWT token
    async refreshSession() {
        if (!this.refreshToken) {
            console.log('No refresh token available');
            return false;
        }
        
        try {
            const response = await fetch('/api/users/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken: this.refreshToken })
            });
            
            const result = await response.json();
            
            if (result.success) {
                this.token = result.token;
                this.refreshToken = result.refreshToken;
                this.currentUser = result.user;
                
                localStorage.setItem('smartinvoice_token', this.token);
                localStorage.setItem('smartinvoice_refreshToken', this.refreshToken);
                localStorage.setItem('smartinvoice_currentUser', JSON.stringify(this.currentUser));
                
                console.log('✅ Session refreshed successfully');
                return true;
            } else {
                this.logout();
                return false;
            }
        } catch (error) {
            console.error('Session refresh error:', error);
            this.logout();
            return false;
        }
    }

    // Register new business - JWT version
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
                // Store token and user data
                this.token = result.token;
                this.refreshToken = result.refreshToken;
                this.currentUser = result.user;
                
                localStorage.setItem('smartinvoice_token', this.token);
                localStorage.setItem('smartinvoice_refreshToken', this.refreshToken);
                localStorage.setItem('smartinvoice_currentUser', JSON.stringify(result.user));
                
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

    // Login user - JWT version
    async login(email, password) {
        console.log('🔐 Login attempt:', email);
        
        try {
            const response = await fetch('/api/users/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            
            const result = await response.json();
            
            if (result.success) {
                // Store token and user data
                this.token = result.token;
                this.refreshToken = result.refreshToken;
                this.currentUser = result.user;
                
                localStorage.setItem('smartinvoice_token', this.token);
                localStorage.setItem('smartinvoice_refreshToken', this.refreshToken);
                localStorage.setItem('smartinvoice_currentUser', JSON.stringify(result.user));
                
                console.log('✅ Login successful, token stored');
                
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

    // Logout user - JWT version
    async logout() {
        console.log('🔐 Logging out user:', this.currentUser?.email);
        
        try {
            if (this.refreshToken) {
                await fetch('/api/users/logout', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...this.getAuthHeader()
                    },
                    body: JSON.stringify({ refreshToken: this.refreshToken })
                });
            }
        } catch (error) {
            console.error('Logout API error:', error);
        }
        
        // Clear local storage
        this.token = null;
        this.refreshToken = null;
        this.currentUser = null;
        
        localStorage.removeItem('smartinvoice_token');
        localStorage.removeItem('smartinvoice_refreshToken');
        localStorage.removeItem('smartinvoice_currentUser');
        
        console.log('🔐 Logout complete');
        return { success: true, message: 'Logged out successfully' };
    }

    // Check if user is logged in
    isLoggedIn() {
        const isLoggedIn = this.token !== null && this.currentUser !== null;
        console.log('🔐 isLoggedIn check:', isLoggedIn);
        return isLoggedIn;
    }

    // Get current user
    getCurrentUser() {
        return this.currentUser;
    }

    // Get auth token for API calls
    getToken() {
        return this.token;
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

    // Get user subscription (sync version for UI)
    getSubscription() {
        if (!this.currentUser) return null;
        
        // For now, return free plan
        // In production, fetch from server
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

    // Save user's invoice (local cache)
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