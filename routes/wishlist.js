const router = require('express').Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

/**
 * Get user's wishlist
 */
router.get('/', auth, async (req, res) => {
    try {
        const [wishlist] = await pool.query(
            `SELECT w.id, w.book_id, w.created_at, 
                    b.title, b.author, b.price, b.stock, b.description, b.image_url, b.cover
             FROM wishlist w
             JOIN books b ON w.book_id = b.id
             WHERE w.user_id = ?
             ORDER BY w.created_at DESC`,
            [req.user.id]
        );

        return res.json(wishlist);
    } catch (err) {
        console.error("Error fetching wishlist:", err);
        return res.status(500).json({ message: "Server error while fetching wishlist" });
    }
});

/**
 * Add book to wishlist
 */
router.post('/:bookId', auth, async (req, res) => {
    try {
        const bookId = req.params.bookId;

        // Check if book exists
        const [books] = await pool.query('SELECT id FROM books WHERE id = ?', [bookId]);
        if (books.length === 0) {
            return res.status(404).json({ message: "Book not found" });
        }

        // Check if already in wishlist
        const [existing] = await pool.query(
            'SELECT id FROM wishlist WHERE user_id = ? AND book_id = ?',
            [req.user.id, bookId]
        );

        if (existing.length > 0) {
            return res.status(400).json({ message: "Book already in wishlist" });
        }

        // Add to wishlist
        const [result] = await pool.query(
            'INSERT INTO wishlist (user_id, book_id) VALUES (?, ?)',
            [req.user.id, bookId]
        );

        return res.status(201).json({
            message: "Book added to wishlist",
            id: result.insertId,
            book_id: bookId
        });
    } catch (err) {
        console.error("Error adding to wishlist:", err);
        return res.status(500).json({ message: "Server error while adding to wishlist" });
    }
});

/**
 * Remove book from wishlist
 */
router.delete('/:bookId', auth, async (req, res) => {
    try {
        const bookId = req.params.bookId;

        const [result] = await pool.query(
            'DELETE FROM wishlist WHERE user_id = ? AND book_id = ?',
            [req.user.id, bookId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Book not in wishlist" });
        }

        return res.json({ message: "Book removed from wishlist" });
    } catch (err) {
        console.error("Error removing from wishlist:", err);
        return res.status(500).json({ message: "Server error while removing from wishlist" });
    }
});

/**
 * Check if a book is in wishlist
 */
router.get('/check/:bookId', auth, async (req, res) => {
    try {
        const bookId = req.params.bookId;

        const [existing] = await pool.query(
            'SELECT id FROM wishlist WHERE user_id = ? AND book_id = ?',
            [req.user.id, bookId]
        );

        return res.json({ inWishlist: existing.length > 0 });
    } catch (err) {
        console.error("Error checking wishlist:", err);
        return res.status(500).json({ message: "Server error while checking wishlist" });
    }
});

/**
 * Get wishlist count
 */
router.get('/count', auth, async (req, res) => {
    try {
        const [result] = await pool.query(
            'SELECT COUNT(*) as count FROM wishlist WHERE user_id = ?',
            [req.user.id]
        );

        return res.json({ count: result[0].count });
    } catch (err) {
        console.error("Error counting wishlist:", err);
        return res.status(500).json({ message: "Server error while counting wishlist" });
    }
});

module.exports = router;
