// Secure PDF reader endpoint that prevents downloads
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const pool = require('../config/database');
const fetch = require('node-fetch');

// Serve PDF with download prevention headers
router.get('/pdf/:bookId', async (req, res) => {
    try {
        const { bookId } = req.params;
        const token = req.query.token || req.headers.authorization?.split(' ')[1] || req.headers['x-auth-token'];
        
        if (!token) {
            return res.status(401).json({ message: 'Authentication required' });
        }

        // Verify token and get user
        const jwt = require('jsonwebtoken');
        const secret = process.env.JWT_SECRET || 'dev_secret';
        let decoded;
        try {
            decoded = jwt.verify(token, secret);
        } catch (err) {
            return res.status(401).json({ message: 'Invalid token' });
        }

        const userId = decoded.userId || decoded.id || decoded.user?.id;
        if (!userId) {
            return res.status(401).json({ message: 'Invalid token payload' });
        }

        // Verify user has access to this book
        const [orders] = await pool.query(`
            SELECT o.*, oi.book_id, b.title, b.content_url, b.content_type, b.page_count, o.mode, o.rental_end
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN books b ON oi.book_id = b.id
            WHERE oi.book_id = ? AND o.user_id = ? AND o.payment_status = 'completed'
            ORDER BY o.created_at DESC
            LIMIT 1
        `, [bookId, userId]);

        if (orders.length === 0) {
            return res.status(403).json({ message: 'You do not have access to this book' });
        }

        const order = orders[0];

        // Check rental expiry
        if (order.mode === 'rent' && order.rental_end) {
            const now = new Date();
            const expiryDate = new Date(order.rental_end);
            if (now > expiryDate) {
                return res.status(403).json({ message: 'Your rental period has expired' });
            }
        }

        if (!order.content_url) {
            return res.status(404).json({ message: 'Book content not available' });
        }

        // Fetch the PDF from Azure
        const response = await fetch(order.content_url);
        if (!response.ok) {
            return res.status(404).json({ message: 'Book content not found' });
        }

        // Set headers to prevent download and caching
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline; filename="protected-book.pdf"', // inline prevents download dialog
            'X-Frame-Options': 'SAMEORIGIN', // Allow embedding in same origin
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Download-Options': 'noopen', // IE download prevention
            'X-Content-Type-Options': 'nosniff'
        });

        // Stream the PDF
        response.body.pipe(res);

    } catch (error) {
        console.error('Error serving secure PDF:', error);
        res.status(500).json({ message: 'Failed to load book content' });
    }
});

module.exports = router;