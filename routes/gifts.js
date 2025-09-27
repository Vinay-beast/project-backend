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
