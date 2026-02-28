const router = require('express').Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

// Get all reading progress for current user (for "Continue Reading" section)
router.get('/', auth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT rp.*, b.title, b.author, b.image_url, b.cover
             FROM reading_progress rp
             JOIN books b ON b.id = rp.book_id
             WHERE rp.user_id = ?
             ORDER BY rp.last_read_at DESC
             LIMIT 10`,
            [req.user.id]
        );
        res.json(rows);
    } catch (e) {
        console.error('Get reading progress failed:', e);
        res.status(500).json({ message: 'Failed to fetch reading progress' });
    }
});

// Get reading progress for a specific book
router.get('/:bookId', auth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT * FROM reading_progress 
             WHERE user_id = ? AND book_id = ?`,
            [req.user.id, req.params.bookId]
        );

        if (rows.length === 0) {
            return res.json({ current_page: 1, total_pages: 1, progress_percent: 0 });
        }

        res.json(rows[0]);
    } catch (e) {
        console.error('Get book progress failed:', e);
        res.status(500).json({ message: 'Failed to fetch book progress' });
    }
});

// Save/update reading progress
router.post('/', auth, async (req, res) => {
    const { book_id, current_page, total_pages } = req.body;

    if (!book_id || current_page === undefined || total_pages === undefined) {
        return res.status(400).json({ message: 'Missing required fields' });
    }

    const progress_percent = Math.min(100, Math.round((current_page / total_pages) * 100 * 100) / 100);

    try {
        await pool.query(
            `INSERT INTO reading_progress (user_id, book_id, current_page, total_pages, progress_percent, last_read_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON DUPLICATE KEY UPDATE 
                current_page = VALUES(current_page),
                total_pages = VALUES(total_pages),
                progress_percent = VALUES(progress_percent),
                last_read_at = CURRENT_TIMESTAMP`,
            [req.user.id, book_id, current_page, total_pages, progress_percent]
        );

        res.json({
            success: true,
            current_page,
            total_pages,
            progress_percent
        });
    } catch (e) {
        console.error('Save reading progress failed:', e);
        res.status(500).json({ message: 'Failed to save reading progress' });
    }
});

// Delete reading progress (reset book)
router.delete('/:bookId', auth, async (req, res) => {
    try {
        await pool.query(
            `DELETE FROM reading_progress WHERE user_id = ? AND book_id = ?`,
            [req.user.id, req.params.bookId]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('Delete reading progress failed:', e);
        res.status(500).json({ message: 'Failed to delete reading progress' });
    }
});

module.exports = router;
