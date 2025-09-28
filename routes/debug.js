// Debug endpoint to check book content status
const router = require('express').Router();
const pool = require('../config/database');

router.get('/book/:bookId', async (req, res) => {
    try {
        const { bookId } = req.params;
        
        // Get book info
        const [books] = await pool.query('SELECT * FROM books WHERE id = ?', [bookId]);
        
        if (books.length === 0) {
            return res.json({ error: 'Book not found', bookId });
        }
        
        const book = books[0];
        
        res.json({
            bookId,
            title: book.title,
            hasContentUrl: !!book.content_url,
            contentUrl: book.content_url || 'Not uploaded',
            contentType: book.content_type || 'Not set',
            pageCount: book.page_count || 'Not set'
        });
        
    } catch (error) {
        console.error('Debug book check error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;