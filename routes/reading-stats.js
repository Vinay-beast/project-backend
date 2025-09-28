const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

// Track reading session start
router.post('/start-reading', auth, async (req, res) => {
    try {
        const { bookId } = req.body;

        // Check if book exists and user owns it
        const bookCheck = await pool.query(
            'SELECT b.*, o.id as order_id FROM books b JOIN orders o ON o.id = ? WHERE b.id = ? AND o.user_id = ?',
            [bookId, bookId, req.user.userId]
        );

        if (bookCheck.length === 0) {
            return res.status(404).json({ error: 'Book not found or not owned' });
        }

        // Start reading session
        await pool.query(
            'INSERT INTO reading_sessions (user_id, book_id, start_time) VALUES (?, ?, NOW())',
            [req.user.userId, bookId]
        );

        res.json({ message: 'Reading session started' });
    } catch (error) {
        console.error('Error starting reading session:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Track reading session end
router.post('/end-reading', auth, async (req, res) => {
    try {
        const { bookId, pagesRead = 1 } = req.body;

        // Find and update the latest active session
        await pool.query(`
            UPDATE reading_sessions 
            SET end_time = NOW(), pages_read = ? 
            WHERE user_id = ? AND book_id = ? AND end_time IS NULL 
            ORDER BY start_time DESC LIMIT 1
        `, [pagesRead, req.user.userId, bookId]);

        // Update user reading stats
        await pool.query(`
            INSERT INTO user_reading_stats (user_id, total_books_read, total_pages_read, total_reading_time) 
            VALUES (?, 1, ?, 0)
            ON DUPLICATE KEY UPDATE
            total_pages_read = total_pages_read + ?,
            last_reading_date = NOW()
        `, [req.user.userId, pagesRead, pagesRead]);

        res.json({ message: 'Reading session ended' });
    } catch (error) {
        console.error('Error ending reading session:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get user reading statistics
router.get('/stats', auth, async (req, res) => {
    try {
        // Get overall stats
        const stats = await pool.query(
            'SELECT * FROM user_reading_stats WHERE user_id = ?',
            [req.user.userId]
        );

        // Get recently read books
        const recentBooks = await pool.query(`
            SELECT b.title, b.author, b.cover_url, rs.start_time
            FROM reading_sessions rs
            JOIN books b ON rs.book_id = b.id
            WHERE rs.user_id = ?
            ORDER BY rs.start_time DESC
            LIMIT 5
        `, [req.user.userId]);

        // Get reading streak
        const streakResult = await pool.query(`
            SELECT COUNT(DISTINCT DATE(start_time)) as streak
            FROM reading_sessions
            WHERE user_id = ? AND start_time >= CURDATE() - INTERVAL 30 DAY
        `, [req.user.userId]);

        // Get total books owned
        const booksOwnedResult = await pool.query(`
            SELECT COUNT(DISTINCT book_id) as owned_books
            FROM orders
            WHERE user_id = ?
        `, [req.user.userId]);

        const userStats = stats[0] || {
            total_books_read: 0,
            total_pages_read: 0,
            total_reading_time: 0
        };

        res.json({
            stats: userStats,
            recentBooks,
            readingStreak: streakResult[0]?.streak || 0,
            booksOwned: booksOwnedResult[0]?.owned_books || 0
        });
    } catch (error) {
        console.error('Error fetching reading stats:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;