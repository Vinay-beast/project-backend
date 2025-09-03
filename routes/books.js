const router = require('express').Router();
const pool = require('../config/database');

/**
 * Get all books (with pagination)
 */
router.get('/', async (req, res) => {
    try {
        let { page, limit } = req.query;
        page = parseInt(page) || 1;
        limit = parseInt(limit) || 10;
        const offset = (page - 1) * limit;

        const [books] = await pool.query(
            'SELECT * FROM books LIMIT ? OFFSET ?',
            [limit, offset]
        );

        // Get total count
        const [countRows] = await pool.query('SELECT COUNT(*) as total FROM books');
        const total = countRows[0].total;

        return res.json({
            page,
            limit,
            total,
            books
        });

    } catch (err) {
        console.error("Error fetching books:", err);
        return res.status(500).json({ message: "Server error while fetching books" });
    }
});

/**
 * Search books by title/author (with pagination)
 */
router.get('/search', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query || query.trim().length === 0) {
            return res.status(400).json({ message: "Search query is required" });
        }

        let { page, limit } = req.query;
        page = parseInt(page) || 1;
        limit = parseInt(limit) || 10;
        const offset = (page - 1) * limit;

        const [books] = await pool.query(
            `SELECT * FROM books 
             WHERE title LIKE ? OR author LIKE ?
             LIMIT ? OFFSET ?`,
            [`%${query}%`, `%${query}%`, limit, offset]
        );

        const [countRows] = await pool.query(
            `SELECT COUNT(*) as total 
             FROM books WHERE title LIKE ? OR author LIKE ?`,
            [`%${query}%`, `%${query}%`]
        );

        return res.json({
            page,
            limit,
            total: countRows[0].total,
            books
        });

    } catch (err) {
        console.error("Error searching books:", err);
        return res.status(500).json({ message: "Server error while searching books" });
    }
});

/**
 * Get single book by ID
 */
router.get('/:id', async (req, res) => {
    try {
        const bookId = req.params.id;
        if (!bookId) {
            return res.status(400).json({ message: "Book ID is required" });
        }

        const [books] = await pool.query('SELECT * FROM books WHERE id = ?', [bookId]);

        if (books.length === 0) {
            return res.status(404).json({ message: "Book not found" });
        }

        return res.json(books[0]);

    } catch (err) {
        console.error("Error fetching book:", err);
        return res.status(500).json({ message: "Server error while fetching book" });
    }
});

module.exports = router;
