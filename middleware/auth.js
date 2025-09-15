// backend/middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../config/database');

module.exports = async (req, res, next) => {
    try {
        // Accept x-auth-token OR Authorization: Bearer <token>
        let token = req.header('x-auth-token');
        const authHeader = req.header('authorization') || req.header('Authorization');
        if (!token && authHeader && /^Bearer\s+/i.test(authHeader)) {
            token = authHeader.split(' ')[1];
        }

        if (!token) {
            return res.status(401).json({ message: 'No token, authorization denied' });
        }

        const secret = process.env.JWT_SECRET || 'dev_secret';
        let decoded;
        try {
            decoded = jwt.verify(token, secret);
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ message: 'Token expired, please log in again' });
            }
            return res.status(401).json({ message: 'Invalid token' });
        }

        // Accept multiple payload shapes
        const userId = decoded.userId || decoded.id || decoded.user?.id;
        if (!userId) {
            return res.status(401).json({ message: 'Invalid token payload' });
        }

        // Make sure user still exists and fetch is_admin
        const [rows] = await pool.query(
            'SELECT id, name, email, is_admin FROM users WHERE id = ? LIMIT 1',
            [userId]
        );
        if (!rows || rows.length === 0) {
            return res.status(401).json({ message: 'User no longer exists' });
        }

        req.user = {
            id: rows[0].id,
            name: rows[0].name,
            email: rows[0].email,
            is_admin: !!rows[0].is_admin
        };

        next();
    } catch (err) {
        console.error('Auth middleware error:', err);
        return res.status(401).json({ message: 'Invalid token' });
    }
};
