const router = require('express').Router();
const multer = require('multer');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/admin');
const pool = require('../config/database');
const azureStorageService = require('../config/azureStorage');

// Multer for book content upload (PDF, EPUB, etc.)
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/pdf',
            'application/epub+zip',
            'text/plain',
            'text/html'
        ];
        const ok = allowedTypes.includes(file.mimetype);
        cb(ok ? null : new Error('Only PDF, EPUB, TXT, and HTML files are allowed'), ok);
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

        // Check if user has access to this book (purchased or rented)
        const [orders] = await pool.query(`
            SELECT o.*, b.title, b.content_url, b.content_type, b.page_count
            FROM orders o
            JOIN books b ON o.book_id = b.id
            WHERE o.book_id = ? AND o.user_id = ? AND o.payment_status = 'completed'
            ORDER BY o.created_at DESC
            LIMIT 1
        `, [bookId, userId]);

        if (orders.length === 0) {
            return res.status(403).json({ message: 'You do not have access to this book' });
        }

        const order = orders[0];

        // Check if it's a rental and if it's still valid
        if (order.order_type === 'rental') {
            const now = new Date();
            const expiryDate = new Date(order.rental_expires_at);

            if (now > expiryDate) {
                return res.status(403).json({ message: 'Your rental period has expired' });
            }

            // For rentals, generate a temporary SAS URL (1 hour expiry)
            const temporaryUrl = await azureStorageService.generateSasUrl(order.content_url, 1);

            return res.json({
                readingUrl: temporaryUrl,
                contentType: order.content_type,
                title: order.title,
                pageCount: order.page_count,
                accessType: 'rental',
                expiresAt: order.rental_expires_at
            });
        } else {
            // For purchased books, provide direct access
            return res.json({
                readingUrl: order.content_url,
                contentType: order.content_type,
                title: order.title,
                pageCount: order.page_count,
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