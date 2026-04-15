/**
 * JWT Token Utilities
 * Handles generation, verification, and refresh of JSON Web Tokens
 */

const jwt = require('jsonwebtoken');

// Get JWT configuration from environment variables
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';
const JWT_REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '30d';

/**
 * Generate access token for authenticated user
 * @param {Object} user - User object with id, email, and role
 * @returns {string} JWT access token
 */
function generateToken(user) {
    if (!JWT_SECRET) {
        throw new Error('JWT_SECRET is not defined in environment variables');
    }
    
    const payload = {
        id: user.id,
        email: user.email,
        businessName: user.businessName,
        role: user.role || 'business',
        subaccountCode: user.bankDetails?.subaccountCode || null
    };
    
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

/**
 * Generate refresh token for extended sessions
 * @param {Object} user - User object with id and email
 * @returns {string} Refresh token
 */
function generateRefreshToken(user) {
    if (!JWT_SECRET) {
        throw new Error('JWT_SECRET is not defined in environment variables');
    }
    
    const payload = {
        id: user.id,
        email: user.email,
        type: 'refresh'
    };
    
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRY });
}

/**
 * Verify and decode JWT token
 * @param {string} token - JWT token to verify
 * @returns {Object|null} Decoded token payload or null if invalid
 */
function verifyToken(token) {
    if (!token) {
        return null;
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return decoded;
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            console.log('Token expired');
        } else if (error.name === 'JsonWebTokenError') {
            console.log('Invalid token');
        } else {
            console.error('Token verification error:', error.message);
        }
        return null;
    }
}

/**
 * Decode token without verification (for debugging only)
 * @param {string} token - JWT token
 * @returns {Object|null} Decoded payload
 */
function decodeToken(token) {
    try {
        return jwt.decode(token);
    } catch (error) {
        console.error('Token decode error:', error.message);
        return null;
    }
}

/**
 * Check if token is expired
 * @param {string} token - JWT token
 * @returns {boolean} True if expired
 */
function isTokenExpired(token) {
    const decoded = decodeToken(token);
    if (!decoded || !decoded.exp) {
        return true;
    }
    return Date.now() >= decoded.exp * 1000;
}

/**
 * Get remaining time on token in milliseconds
 * @param {string} token - JWT token
 * @returns {number} Milliseconds remaining, 0 if expired
 */
function getTokenRemainingTime(token) {
    const decoded = decodeToken(token);
    if (!decoded || !decoded.exp) {
        return 0;
    }
    const remaining = decoded.exp * 1000 - Date.now();
    return remaining > 0 ? remaining : 0;
}

module.exports = {
    generateToken,
    generateRefreshToken,
    verifyToken,
    decodeToken,
    isTokenExpired,
    getTokenRemainingTime,
    JWT_SECRET,
    JWT_EXPIRY,
    JWT_REFRESH_EXPIRY
};