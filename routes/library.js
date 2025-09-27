const router = require('express').Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // NOTE: Removed auto-claiming to allow manual gift claiming
        // Users must manually claim gifts from the gifts section

        // Owned via BUY only (exclude gifts from owned section)
        const [ownedBuy] = await conn.query(
            `SELECT DISTINCT oi.book_id
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
        WHERE o.user_id = ? AND o.mode = 'buy'`,
            [req.user.id]
        );

        // NOTE: Gifts are handled separately in /api/gifts/mine route
        // They should NOT appear in the owned section to maintain separation

        // Rented
        const [rented] = await conn.query(
            `SELECT DISTINCT oi.book_id, o.rental_end
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
        WHERE o.user_id = ? AND o.mode = 'rent'`,
            [req.user.id]
        );

        // Hydrate book details for purchased books only
        const ownedIds = [...new Set(ownedBuy.map(x => x.book_id))];
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
