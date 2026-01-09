const router = require('express').Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

/**
 * Get all reviews for a book (public)
 */
router.get('/book/:bookId', async (req, res) => {
    try {
        const bookId = req.params.bookId;

        const [reviews] = await pool.query(
            `SELECT r.id, r.user_id, r.book_id, r.rating, r.review_text, r.created_at, r.updated_at,
                    u.name as user_name, u.profile_pic as user_avatar
             FROM reviews r
             JOIN users u ON r.user_id = u.id
             WHERE r.book_id = ?
             ORDER BY r.created_at DESC`,
            [bookId]
        );

        // Get average rating
        const [avgResult] = await pool.query(
            `SELECT AVG(rating) as avg_rating, COUNT(*) as total_reviews
             FROM reviews WHERE book_id = ?`,
            [bookId]
        );

        return res.json({
            reviews,
            avgRating: avgResult[0].avg_rating ? parseFloat(avgResult[0].avg_rating).toFixed(1) : null,
            totalReviews: avgResult[0].total_reviews || 0
        });
    } catch (err) {
        console.error("Error fetching reviews:", err);
        return res.status(500).json({ message: "Server error while fetching reviews" });
    }
});

/**
 * Get average ratings for multiple books (for catalog display)
 */
router.post('/ratings/bulk', async (req, res) => {
    try {
        const { bookIds } = req.body;

        if (!bookIds || !Array.isArray(bookIds) || bookIds.length === 0) {
            return res.json({});
        }

        const placeholders = bookIds.map(() => '?').join(',');
        const [results] = await pool.query(
            `SELECT book_id, AVG(rating) as avg_rating, COUNT(*) as total_reviews
             FROM reviews 
             WHERE book_id IN (${placeholders})
             GROUP BY book_id`,
            bookIds
        );

        const ratings = {};
        results.forEach(r => {
            ratings[r.book_id] = {
                avgRating: parseFloat(r.avg_rating).toFixed(1),
                totalReviews: r.total_reviews
            };
        });

        return res.json(ratings);
    } catch (err) {
        console.error("Error fetching bulk ratings:", err);
        return res.status(500).json({ message: "Server error while fetching ratings" });
    }
});

/**
 * Get user's review for a specific book
 */
router.get('/my/:bookId', auth, async (req, res) => {
    try {
        const bookId = req.params.bookId;

        const [reviews] = await pool.query(
            `SELECT id, rating, review_text, created_at, updated_at
             FROM reviews WHERE user_id = ? AND book_id = ?`,
            [req.user.id, bookId]
        );

        if (reviews.length === 0) {
            return res.json({ hasReview: false });
        }

        return res.json({ hasReview: true, review: reviews[0] });
    } catch (err) {
        console.error("Error fetching user review:", err);
        return res.status(500).json({ message: "Server error while fetching review" });
    }
});

/**
 * Create or update a review
 */
router.post('/:bookId', auth, async (req, res) => {
    try {
        const bookId = req.params.bookId;
        const { rating, reviewText } = req.body;

        // Validate rating
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ message: "Rating must be between 1 and 5" });
        }

        // Check if book exists
        const [books] = await pool.query('SELECT id FROM books WHERE id = ?', [bookId]);
        if (books.length === 0) {
            return res.status(404).json({ message: "Book not found" });
        }

        // Check if user already has a review
        const [existing] = await pool.query(
            'SELECT id FROM reviews WHERE user_id = ? AND book_id = ?',
            [req.user.id, bookId]
        );

        if (existing.length > 0) {
            // Update existing review
            await pool.query(
                `UPDATE reviews SET rating = ?, review_text = ? WHERE id = ?`,
                [rating, reviewText || null, existing[0].id]
            );
            return res.json({ message: "Review updated successfully", id: existing[0].id });
        } else {
            // Create new review
            const [result] = await pool.query(
                `INSERT INTO reviews (user_id, book_id, rating, review_text) VALUES (?, ?, ?, ?)`,
                [req.user.id, bookId, rating, reviewText || null]
            );
            return res.status(201).json({ message: "Review created successfully", id: result.insertId });
        }
    } catch (err) {
        console.error("Error creating/updating review:", err);
        return res.status(500).json({ message: "Server error while saving review" });
    }
});

/**
 * Delete user's review
 */
router.delete('/:bookId', auth, async (req, res) => {
    try {
        const bookId = req.params.bookId;

        const [result] = await pool.query(
            'DELETE FROM reviews WHERE user_id = ? AND book_id = ?',
            [req.user.id, bookId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Review not found" });
        }

        return res.json({ message: "Review deleted successfully" });
    } catch (err) {
        console.error("Error deleting review:", err);
        return res.status(500).json({ message: "Server error while deleting review" });
    }
});

module.exports = router;
