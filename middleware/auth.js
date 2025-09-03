// backend/middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../config/database');

module.exports = async (req, res, next) => {
    try {
        // Accept: x-auth-token OR Authorization: Bearer <token>
        let token = req.header('x-auth-token');
        const authHeader = req.header('authorization') || req.header('Authorization');
        if (!token && authHeader && /^Bearer\s+/i.test(authHeader)) {
            token = authHeader.split(' ')[1];
        }

        if (!token) {
            return res.status(401).json({ message: 'No token, authorization denied' });
        }

        // Verify token
        const secret = process.env.JWT_SECRET || 'dev_secret';
        const decoded = jwt.verify(token, secret);

        // Support multiple payload shapes: { userId }, { id }, or { user: { id } }
        const userId = decoded.userId || decoded.id || decoded.user?.id;
        if (!userId) {
            return res.status(401).json({ message: 'Invalid token payload' });
        }

        // Ensure user still exists
        const [rows] = await pool.query(
            'SELECT id, name, email FROM users WHERE id = ? LIMIT 1',
            [userId]
        );
        if (!rows || rows.length === 0) {
            return res.status(401).json({ message: 'User no longer exists' });
        }

        // Attach a consistent shape on req.user
        req.user = { id: rows[0].id, name: rows[0].name, email: rows[0].email };
        next();
    } catch (err) {
        console.error('Auth middleware error:', err.message);
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Token expired, please log in again' });
        }
        return res.status(401).json({ message: 'Invalid token' });
    }
};
