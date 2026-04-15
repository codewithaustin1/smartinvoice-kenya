/**
 * Authentication Middleware
 * Protects API routes by verifying JWT tokens
 */

const { verifyToken: verifyJWT } = require('../utils/tokens');

/**
 * Middleware to verify JWT token from Authorization header
 * Usage: app.post('/api/protected', verifyToken, handler)
 * 
 * Expected header: Authorization: Bearer <token>
 */
function verifyToken(req, res, next) {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
        return res.status(401).json({
            success: false,
            message: 'No authorization token provided',
            code: 'MISSING_TOKEN'
        });
    }
    
    // Check if it's a Bearer token
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(401).json({
            success: false,
            message: 'Invalid authorization format. Use: Bearer <token>',
            code: 'INVALID_FORMAT'
        });
    }
    
    const token = parts[1];
    
    // Verify the token
    const decoded = verifyJWT(token);
    
    if (!decoded) {
        return res.status(401).json({
            success: false,
            message: 'Invalid or expired token. Please login again.',
            code: 'INVALID_TOKEN'
        });
    }
    
    // Attach user info to request for use in route handlers
    req.user = {
        id: decoded.id,
        email: decoded.email,
        businessName: decoded.businessName,
        role: decoded.role || 'business',
        subaccountCode: decoded.subaccountCode
    };
    
    // Attach token for refresh purposes
    req.token = token;
    
    next();
}

/**
 * Optional authentication - doesn't fail if no token
 * Use for routes that work both with and without authentication
 */
function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (authHeader) {
        const parts = authHeader.split(' ');
        if (parts.length === 2 && parts[0] === 'Bearer') {
            const decoded = verifyJWT(parts[1]);
            if (decoded) {
                req.user = {
                    id: decoded.id,
                    email: decoded.email,
                    businessName: decoded.businessName,
                    role: decoded.role || 'business'
                };
                req.token = parts[1];
            }
        }
    }
    
    next();
}

/**
 * Role-based access control middleware
 * Usage: app.post('/api/admin', verifyToken, requireRole('admin'), handler)
 */
function requireRole(role) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }
        
        if (req.user.role !== role && req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                message: `Access denied. ${role} role required.`
            });
        }
        
        next();
    };
}

/**
 * Check if user owns the resource (for user-specific operations)
 * Usage: app.put('/api/invoice/:id', verifyToken, checkOwnership, handler)
 */
async function checkOwnership(req, res, next) {
    try {
        // This requires the database module
        const { getInvoicesCollection } = require('../db');
        const { id } = req.params;
        const userId = req.user.id;
        
        // Check if database is initialized
        if (!getInvoicesCollection) {
            // Skip ownership check if db not available
            return next();
        }
        
        const invoicesCollection = getInvoicesCollection();
        const invoice = await invoicesCollection.findOne({ id });
        
        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: 'Resource not found'
            });
        }
        
        if (invoice.userId !== userId && req.user.role !== 'superadmin') {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You do not own this resource.'
            });
        }
        
        req.resource = invoice;
        next();
    } catch (error) {
        console.error('Ownership check error:', error);
        // If database not ready, skip ownership check
        next();
    }
}

module.exports = {
    verifyToken,
    optionalAuth,
    requireRole,
    checkOwnership
};