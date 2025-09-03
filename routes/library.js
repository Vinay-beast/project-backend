const router = require('express').Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Auto-claim any gifts matching my email (convenience)
        await conn.query(
            `UPDATE gifts
          SET recipient_user_id = ?, claimed_at = NOW()
        WHERE recipient_email = ? AND recipient_user_id IS NULL`,
            [req.user.id, req.user.email]
        );

        // Owned via BUY
        const [ownedBuy] = await conn.query(
            `SELECT DISTINCT oi.book_id
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
        WHERE o.user_id = ? AND o.mode = 'buy'`,
            [req.user.id]
        );

        // Owned via GIFTS (claimed or by email)
        const [ownedGifts] = await conn.query(
            `SELECT DISTINCT g.book_id
         FROM gifts g
        WHERE g.recipient_user_id = ?
           OR g.recipient_email = ?`,
            [req.user.id, req.user.email]
        );

        // Rented
        const [rented] = await conn.query(
            `SELECT DISTINCT oi.book_id, o.rental_end
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
        WHERE o.user_id = ? AND o.mode = 'rent'`,
            [req.user.id]
        );

        // Hydrate book details
        const ownedIds = [...new Set([...ownedBuy.map(x => x.book_id), ...ownedGifts.map(x => x.book_id)])];
        let owned = [];
        if (ownedIds.length) {
            const [rows] = await conn.query(
                `SELECT id, title, author, image_url FROM books WHERE id IN (${ownedIds.map(() => '?').join(',')})`,
                ownedIds
            );
            owned = rows.map(b => ({ book: b, purchased_at: null }));
        }

        let rentedOut = [];
        if (rented.length) {
            const ids = rented.map(x => x.book_id);
            const [rows] = await conn.query(
                `SELECT id, title, author, image_url FROM books WHERE id IN (${ids.map(() => '?').join(',')})`,
                ids
            );
            const byId = new Map(rows.map(r => [r.id, r]));
            rentedOut = rented.map(r => ({ book: byId.get(r.book_id), rental_end: r.rental_end }));
        }

        await conn.commit();
        res.json({ owned, rented: rentedOut });

    } catch (e) {
        await conn.rollback();
        console.error('Library fetch failed:', e);
        res.status(500).json({ message: 'Server error while building library' });
    } finally {
        conn.release();
    }
});

module.exports = router;
