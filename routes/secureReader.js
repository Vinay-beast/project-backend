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

        console.log(`Secure PDF access requested: bookId=${bookId}, userId=${userId}`);
        console.log(`Found ${orders.length} matching orders`);

        if (orders.length === 0) {
            return res.status(403).json({ message: 'You do not have access to this book' });
        }

        const order = orders[0];
        console.log(`Order details: content_url=${order.content_url ? 'exists' : 'missing'}, mode=${order.mode}`);

        // Check rental expiry
        if (order.mode === 'rent' && order.rental_end) {
            const now = new Date();
            const expiryDate = new Date(order.rental_end);
            if (now > expiryDate) {
                return res.status(403).json({ message: 'Your rental period has expired' });
            }
        }

        if (!order.content_url) {
            console.log(`No content URL found for book ${bookId}`);
            // For testing, return a simple PDF message instead of error
            const pdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 100 >>
stream
BT
/F1 24 Tf
100 700 Td
(Book content not uploaded yet) Tj
50 650 Td
(Please upload PDF via admin panel) Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000053 00000 n 
0000000110 00000 n 
0000000244 00000 n 
0000000394 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
464
%%EOF`;
            
            res.set({
                'Content-Type': 'application/pdf',
                'Content-Disposition': 'inline; filename="no-content.pdf"',
                'Cache-Control': 'no-store'
            });
            return res.send(Buffer.from(pdfContent));
        }

        console.log(`Fetching PDF from: ${order.content_url}`);
        // Fetch the PDF from Azure
        const response = await fetch(order.content_url);
        console.log(`Azure response status: ${response.status} ${response.statusText}`);
        
        if (!response.ok) {
            console.log(`Failed to fetch PDF from Azure: ${response.status} ${response.statusText}`);
            return res.status(404).json({ message: 'Book content not found on server' });
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

        // Stream the PDF with error handling
        console.log('Starting PDF stream...');
        response.body.pipe(res).on('error', (err) => {
            console.error('PDF stream error:', err);
            if (!res.headersSent) {
                res.status(500).json({ message: 'Error streaming book content' });
            }
        });

    } catch (error) {
        console.error('Error serving secure PDF:', error);
        if (!res.headersSent) {
            res.status(500).json({ message: 'Failed to load book content' });
        }
    }
});

module.exports = router;