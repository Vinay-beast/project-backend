const router = require('express').Router();
const multer = require('multer');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/admin');
const pool = require('../config/database');
const azureStorageService = require('../config/azureStorage');

// Multer for book content upload (PDF, EPUB, etc.) and cover images
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/pdf',
            'application/epub+zip',
            'text/plain',
            'text/html',
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/gif'
        ];
        const ok = allowedTypes.includes(file.mimetype);
        cb(ok ? null : new Error('Only PDF, EPUB, TXT, HTML, and image files are allowed'), ok);
    },
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB for book files
});

// Upload book content (Admin only)
router.post('/:bookId/content', auth, adminAuth, upload.single('content'), async (req, res) => {
    try {
        const { bookId } = req.params;
        const { page_count } = req.body;

        if (!req.file) {
            return res.status(400).json({ message: 'Book content file is required' });
        }

        // Check if book exists
        const [books] = await pool.query('SELECT * FROM books WHERE id = ?', [bookId]);
        if (books.length === 0) {
            return res.status(404).json({ message: 'Book not found' });
        }

        // Determine content type from MIME type
        let contentType = 'pdf';
        if (req.file.mimetype === 'application/epub+zip') contentType = 'epub';
        else if (req.file.mimetype === 'text/plain') contentType = 'txt';
        else if (req.file.mimetype === 'text/html') contentType = 'html';

        // Upload to Azure Blob Storage (private container)
        const filename = `book_${bookId}_content.${contentType}`;
        const contentUrl = await azureStorageService.uploadBookContent(
            req.file.buffer,
            filename,
            req.file.mimetype
        );

        // Update book with content URL
        await pool.query(
            'UPDATE books SET content_url = ?, content_type = ?, page_count = ? WHERE id = ?',
            [contentUrl, contentType, parseInt(page_count) || 0, bookId]
        );

        res.json({
            message: 'Book content uploaded successfully',
            contentUrl,
            contentType,
            pageCount: parseInt(page_count) || 0
        });

    } catch (error) {
        console.error('Error uploading book content:', error);
        res.status(500).json({ message: 'Failed to upload book content' });
    }
});

// Upload book cover (Admin only)
router.post('/:bookId/cover', auth, adminAuth, upload.single('cover'), async (req, res) => {
    try {
        const { bookId } = req.params;

        if (!req.file) {
            return res.status(400).json({ message: 'Cover image file is required' });
        }

        // Check if book exists
        const [books] = await pool.query('SELECT * FROM books WHERE id = ?', [bookId]);
        if (books.length === 0) {
            return res.status(404).json({ message: 'Book not found' });
        }

        // Upload to Azure Blob Storage (public container for covers)
        const filename = `book_${bookId}_cover.${req.file.originalname.split('.').pop()}`;
        const coverUrl = await azureStorageService.uploadBookCover(
            req.file.buffer,
            filename,
            req.file.mimetype
        );

        // Update book with cover URL
        await pool.query(
            'UPDATE books SET image_url = ?, cover = ? WHERE id = ?',
            [coverUrl, coverUrl, bookId]
        );

        res.json({
            message: 'Book cover uploaded successfully',
            coverUrl,
            url: coverUrl // For compatibility
        });

    } catch (error) {
        console.error('Error uploading book cover:', error);
        res.status(500).json({ message: 'Failed to upload book cover' });
    }
});

// Upload book sample/preview (Admin only)
router.post('/:bookId/sample', auth, adminAuth, upload.single('sample'), async (req, res) => {
    try {
        const { bookId } = req.params;

        if (!req.file) {
            return res.status(400).json({ message: 'Sample file is required' });
        }

        // Check if book exists
        const [books] = await pool.query('SELECT * FROM books WHERE id = ?', [bookId]);
        if (books.length === 0) {
            return res.status(404).json({ message: 'Book not found' });
        }

        // Determine content type from MIME type
        let contentType = 'pdf';
        if (req.file.mimetype === 'application/epub+zip') contentType = 'epub';
        else if (req.file.mimetype === 'text/plain') contentType = 'txt';
        else if (req.file.mimetype === 'text/html') contentType = 'html';

        // Upload to Azure Blob Storage (public container for samples)
        const filename = `book_${bookId}_sample.${contentType}`;
        const sampleUrl = await azureStorageService.uploadBookSample(
            req.file.buffer,
            filename,
            req.file.mimetype
        );

        // Update book with sample URL
        await pool.query(
            'UPDATE books SET sample_url = ? WHERE id = ?',
            [sampleUrl, bookId]
        );

        res.json({
            message: 'Book sample uploaded successfully',
            sampleUrl
        });

    } catch (error) {
        console.error('Error uploading book sample:', error);
        res.status(500).json({ message: 'Failed to upload book sample' });
    }
});

// Debug endpoint to check gifts for a user
router.get('/debug/gifts', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const userEmail = req.user.email;

        const [gifts] = await pool.query(`
            SELECT g.*, b.title, b.id as book_id
            FROM gifts g
            JOIN books b ON g.book_id = b.id
            WHERE g.recipient_user_id = ? OR g.recipient_email = ?
            ORDER BY g.created_at DESC
        `, [userId, userEmail]);

        res.json({
            userId,
            userEmail,
            totalGifts: gifts.length,
            gifts: gifts.map(g => ({
                giftId: g.id,
                bookId: g.book_id,
                bookTitle: g.title,
                recipientEmail: g.recipient_email,
                recipientUserId: g.recipient_user_id,
                readAt: g.read_at,
                createdAt: g.created_at
            }))
        });
    } catch (error) {
        console.error('Debug gifts error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get secure book content URL for reading (Based on purchase/rental)
router.get('/:bookId/read', auth, async (req, res) => {
    try {
        const { bookId } = req.params;
        const userId = req.user.id;

        console.log(`Book reading access requested: bookId=${bookId}, userId=${userId}, userEmail=${req.user.email}`);

        // Check if user has access to this book (purchased, rented, or received as gift)
        // First check for direct orders (purchase/rental)
        console.log(`Checking direct orders for user ${userId}, book ${bookId}`);
        const [orders] = await pool.query(`
            SELECT o.*, oi.book_id, b.title, b.content_url, b.content_type, b.page_count, o.mode, o.rental_end, 'order' as access_source
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN books b ON oi.book_id = b.id
            WHERE oi.book_id = ? AND o.user_id = ? AND o.payment_status = 'completed'
            ORDER BY o.created_at DESC
            LIMIT 1
        `, [bookId, userId]);

        console.log(`Direct orders found: ${orders.length}`);

        // If no direct order found, check for gifts
        let bookAccess = null;
        if (orders.length > 0) {
            bookAccess = orders[0];
            console.log(`Found direct order access for user ${userId}, book ${bookId}`);
        } else {
            console.log(`No direct order found, checking gifts for user ${userId}, book ${bookId}, email ${req.user.email}`);

            // Check for gifts - user can access if they're the recipient
            const [gifts] = await pool.query(`
                SELECT g.*, b.title, b.content_url, b.content_type, b.page_count, 'purchase' as mode, null as rental_end, 'gift' as access_source
                FROM gifts g
                JOIN books b ON g.book_id = b.id
                WHERE g.book_id = ? 
                AND (g.recipient_user_id = ? OR g.recipient_email = ?)
                ORDER BY g.created_at DESC
                LIMIT 1
            `, [bookId, userId, req.user.email]);

            console.log(`Gift query executed with params: bookId=${bookId}, userId=${userId}, email=${req.user.email}`);
            console.log(`Gift query result: ${gifts.length} gifts found`);

            if (gifts.length > 0) {
                const gift = gifts[0];
                bookAccess = gift;
                console.log(`Found gift access:`, {
                    giftId: gift.id,
                    bookId: gift.book_id,
                    recipientUserId: gift.recipient_user_id,
                    recipientEmail: gift.recipient_email,
                    readAt: gift.read_at,
                    title: gift.title
                });
            } else {
                console.log(`No gifts found for this book. Checking all gifts for user...`);
                // Debug: Check if gift exists but with different criteria
                const [allUserGifts] = await pool.query(`
                    SELECT g.*, b.title
                    FROM gifts g
                    JOIN books b ON g.book_id = b.id
                    WHERE g.recipient_user_id = ? OR g.recipient_email = ?
                `, [userId, req.user.email]);

                console.log(`Total gifts for user: ${allUserGifts.length}`);
                if (allUserGifts.length > 0) {
                    console.log(`User's gifts:`, allUserGifts.map(g => ({
                        giftId: g.id,
                        bookId: g.book_id,
                        title: g.title,
                        recipientEmail: g.recipient_email,
                        recipientUserId: g.recipient_user_id
                    })));
                }
            }
        } console.log(`Book access check: bookId=${bookId}, userId=${userId}`);
        if (bookAccess) {
            console.log(`Access granted:`, {
                bookTitle: bookAccess.title,
                hasContentUrl: !!bookAccess.content_url,
                contentType: bookAccess.content_type,
                mode: bookAccess.mode,
                rentalEnd: bookAccess.rental_end,
                accessSource: bookAccess.access_source
            });
        }

        if (!bookAccess) {
            console.log(`Access denied for user ${userId}, book ${bookId} - no valid order or claimed gift found`);
            return res.status(403).json({
                message: 'You do not have access to this book. If this book was gifted to you, please make sure you have claimed it first.'
            });
        }

        // Ensure book has content URL
        if (!bookAccess.content_url) {
            console.log(`Book ${bookId} has no content URL`);
            return res.status(404).json({ message: 'Book content not available. Content has not been uploaded yet.' });
        }

        // Check if it's a rental and if it's still valid
        if (bookAccess.mode === 'rent') {
            const now = new Date();
            const expiryDate = new Date(bookAccess.rental_end);

            if (now > expiryDate) {
                return res.status(403).json({ message: 'Your rental period has expired' });
            }

            // For rentals, provide direct Azure URL (simple and works reliably)
            return res.json({
                readingUrl: bookAccess.content_url,
                contentType: bookAccess.content_type,
                title: bookAccess.title,
                pageCount: bookAccess.page_count,
                accessType: 'rental',
                expiresAt: bookAccess.rental_end
            });
        } else {
            // For purchased books and gifts, provide direct Azure URL (simple and works reliably)
            return res.json({
                readingUrl: bookAccess.content_url,
                contentType: bookAccess.content_type,
                title: bookAccess.title,
                pageCount: bookAccess.page_count,
                accessType: bookAccess.access_source === 'gift' ? 'gift' : 'purchase'
            });
        }
    } catch (error) {
        console.error('Error getting book reading access:', error);
        res.status(500).json({ message: 'Failed to get book access' });
    }
});

// Get book sample (public access)
router.get('/:bookId/sample', async (req, res) => {
    try {
        const { bookId } = req.params;

        const [books] = await pool.query(
            'SELECT title, sample_url, content_type FROM books WHERE id = ? AND sample_url IS NOT NULL',
            [bookId]
        );

        if (books.length === 0) {
            return res.status(404).json({ message: 'Book sample not found' });
        }

        const book = books[0];

        res.json({
            sampleUrl: book.sample_url,
            contentType: book.content_type,
            title: book.title
        });

    } catch (error) {
        console.error('Error getting book sample:', error);
        res.status(500).json({ message: 'Failed to get book sample' });
    }
});

module.exports = router;