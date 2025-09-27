const router = require('express').Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

// Claim all unclaimed gifts sent to my email
router.post('/claim', auth, async (req, res) => {
    try {
        const [r] = await pool.query(
            `UPDATE gifts
         SET recipient_user_id = ?, claimed_at = NOW()
       WHERE recipient_email = ? AND recipient_user_id IS NULL`,
            [req.user.id, req.user.email]
        );
        return res.json({ claimed: r.affectedRows || 0 });
    } catch (err) {
        console.error('Gift claim failed:', err);
        return res.status(500).json({ message: 'Gift claim failed' });
    }
});

// Claim a specific gift
router.post('/claim/:giftId', auth, async (req, res) => {
    try {
        const giftId = req.params.giftId;

        // First check if this gift belongs to the user
        const [checkRows] = await pool.query(
            `SELECT id FROM gifts WHERE id = ? AND (recipient_user_id = ? OR recipient_email = ?)`,
            [giftId, req.user.id, req.user.email]
        );

        if (checkRows.length === 0) {
            return res.status(404).json({ message: 'Gift not found or not authorized' });
        }

        const [r] = await pool.query(
            `UPDATE gifts SET recipient_user_id = ?, claimed_at = NOW() WHERE id = ? AND claimed_at IS NULL`,
            [req.user.id, giftId]
        );

        return res.json({ claimed: r.affectedRows || 0 });
    } catch (err) {
        console.error('Individual gift claim failed:', err);
        return res.status(500).json({ message: 'Individual gift claim failed' });
    }
});

// Mark a gift as read
router.post('/read/:giftId', auth, async (req, res) => {
    try {
        const giftId = req.params.giftId;

        const [r] = await pool.query(
            `UPDATE gifts SET read_at = NOW() 
             WHERE id = ? AND (recipient_user_id = ? OR recipient_email = ?) AND read_at IS NULL`,
            [giftId, req.user.id, req.user.email]
        );

        return res.json({ marked_read: r.affectedRows || 0 });
    } catch (err) {
        console.error('Mark gift as read failed:', err);
        return res.status(500).json({ message: 'Mark gift as read failed' });
    }
});

// Mark all gifts as read
router.post('/read-all', auth, async (req, res) => {
    try {
        const [r] = await pool.query(
            `UPDATE gifts SET read_at = NOW() 
             WHERE (recipient_user_id = ? OR recipient_email = ?) AND read_at IS NULL`,
            [req.user.id, req.user.email]
        );

        return res.json({ marked_read: r.affectedRows || 0 });
    } catch (err) {
        console.error('Mark all gifts as read failed:', err);
        return res.status(500).json({ message: 'Mark all gifts as read failed' });
    }
});

// List my gifts (by user_id OR by my email)
router.get('/mine', auth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT g.*, b.title, b.author, b.image_url, u.name as sender_name, u.email as sender_email
         FROM gifts g
         JOIN books b ON b.id = g.book_id
         JOIN orders o ON o.id = g.order_id
         JOIN users u ON u.id = o.user_id
        WHERE g.recipient_user_id = ?
           OR g.recipient_email = ?
        ORDER BY g.created_at DESC`,
            [req.user.id, req.user.email]
        );
        res.json(rows);
    } catch (err) {
        console.error('Fetch gifts failed:', err);
        res.status(500).json({ message: 'Fetch gifts failed' });
    }
});

module.exports = router;
