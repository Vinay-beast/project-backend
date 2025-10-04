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

// Get secure book content URL for reading (Based on purchase/rental)
router.get('/:bookId/read', auth, async (req, res) => {
    try {
        const { bookId } = req.params;
        const userId = req.user.id;

        console.log(`Book reading access requested: bookId=${bookId}, userId=${userId}`);

        // Check if user has access to this book (purchased, rented, or received as gift)
        const [orders] = await pool.query(`
            SELECT o.*, oi.book_id, b.title, b.content_url, b.content_type, b.page_count, o.mode, o.rental_end
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN books b ON oi.book_id = b.id
            WHERE oi.book_id = ? AND o.user_id = ? AND o.payment_status = 'completed'
            ORDER BY o.created_at DESC
            LIMIT 1
        `, [bookId, userId]);

        // ✅ Also check if user received this book as a gift
        const [gifts] = await pool.query(`
            SELECT g.*, b.title, b.content_url, b.content_type, b.page_count, 'gift' as mode, NULL as rental_end
            FROM gifts g
            JOIN books b ON b.id = g.book_id
            WHERE g.book_id = ? AND g.recipient_user_id = ?
            ORDER BY g.created_at DESC
            LIMIT 1
        `, [bookId, userId]);

        console.log(`Orders found: ${orders.length}, Gifts found: ${gifts.length}`);

        // Combine results - prioritize orders, then gifts
        const access = orders.length > 0 ? orders[0] : (gifts.length > 0 ? gifts[0] : null);

        if (access && orders.length > 0) {
            console.log(`Order details:`, {
                orderId: access.id,
                bookTitle: access.title,
                hasContentUrl: !!access.content_url,
                contentType: access.content_type,
                mode: access.mode,
                rentalEnd: access.rental_end
            });
        } else if (access && gifts.length > 0) {
            console.log(`Gift access:`, {
                giftId: access.id,
                bookTitle: access.title,
                hasContentUrl: !!access.content_url,
                contentType: access.content_type
            });
        }

        if (!access) {
            return res.status(403).json({ message: 'You do not have access to this book' });
        }

        // Ensure book has content URL
        if (!access.content_url) {
            console.log(`Book ${bookId} has no content URL`);
            return res.status(404).json({ message: 'Book content not available. Content has not been uploaded yet.' });
        }

        // Check if it's a rental and if it's still valid
        if (access.mode === 'rent') {
            const now = new Date();
            const expiryDate = new Date(access.rental_end);

            if (now > expiryDate) {
                return res.status(403).json({ message: 'Your rental period has expired' });
            }

            // For rentals, provide direct Azure URL (simple and works reliably)
            return res.json({
                readingUrl: access.content_url,
                contentType: access.content_type,
                title: access.title,
                pageCount: access.page_count,
                accessType: 'rental',
                expiresAt: access.rental_end
            });
        } else {
            // For purchased books or gifts, provide direct Azure URL (simple and works reliably)
            return res.json({
                readingUrl: access.content_url,
                contentType: access.content_type,
                title: access.title,
                pageCount: access.page_count,
                accessType: 'purchase'
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