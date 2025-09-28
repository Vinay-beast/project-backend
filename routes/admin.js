// backend/routes/admin.js
const router = require('express').Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/admin');
const { v4: uuidv4 } = require('uuid');

router.use(auth, adminOnly);

/**
 * GET /api/admin/orders
 */
router.get('/orders', async (req, res) => {
    try {
        const [orders] = await pool.query(
            `SELECT o.*, u.name as user_name, u.email as user_email
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       ORDER BY o.created_at DESC`
        );

        const orderIds = orders.map(o => o.id);
        let items = [];
        if (orderIds.length) {
            const [rows] = await pool.query(
                `SELECT oi.*, b.title, b.author FROM order_items oi
         LEFT JOIN books b ON b.id = oi.book_id
         WHERE oi.order_id IN (${orderIds.map(() => '?').join(',')})`,
                orderIds
            );
            items = rows;
        }

        const byOrder = new Map();
        items.forEach(it => {
            const arr = byOrder.get(it.order_id) || [];
            arr.push(it);
            byOrder.set(it.order_id, arr);
        });

        const out = orders.map(o => ({ ...o, items: byOrder.get(o.id) || [] }));
        res.json(out);
    } catch (e) {
        console.error('Admin fetch orders failed:', e);
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * GET /api/admin/users
 */
router.get('/users', async (req, res) => {
    try {
        const [users] = await pool.query(
            'SELECT id, name, email, phone, bio, is_admin, profile_pic, created_at FROM users ORDER BY id DESC'
        );

        const ids = users.map(u => u.id);
        let addrRows = [];
        if (ids.length) {
            const [a] = await pool.query(
                `SELECT user_id, COUNT(*) as cnt FROM addresses WHERE user_id IN (${ids.map(() => '?').join(',')}) GROUP BY user_id`,
                ids
            );
            addrRows = a;
        }

        const addrBy = new Map(addrRows.map(r => [r.user_id, r.cnt]));

        const out = users.map(u => ({
            id: u.id,
            name: u.name,
            email: u.email,
            phone: u.phone,
            bio: u.bio,
            is_admin: !!u.is_admin,
            profile_pic: u.profile_pic,
            addresses_count: addrBy.get(u.id) || 0,
            created_at: u.created_at
        }));

        res.json(out);
    } catch (e) {
        console.error('Admin fetch users failed:', e);
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * POST /api/admin/books  (create book)
 */
// --------- Admin books: create / update / delete ---------
// NOTE: adapt pool/db variable names to match your file (pool, db, or connection)
// add at top of file with other requires

// Create book (admin)
router.post('/books', async (req, res) => {
    try {
        // generate an id if client didn't provide one
        // using a short id like 'b' + timestamp to remain compatible with previous id format
        const id = req.body.id || ('b' + Date.now().toString().slice(-8));
        const { title, author, price = 0, stock = 0, description = null, image_url = null, cover = null } = req.body;

        const sql = `INSERT INTO books (id, title, author, price, stock, description, image_url, cover, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
        const params = [id, title, author, price, stock, description, image_url, cover];

        await pool.query(sql, params); // "pool" should be your mysql2 pool variable
        const [rows] = await pool.query('SELECT * FROM books WHERE id = ?', [id]);
        res.json({ success: true, book: rows[0] });
    } catch (err) {
        console.error('Admin create book failed:', err);
        res.status(500).json({ error: err.message || 'create book failed' });
    }
});

// Update book (admin) - partial fields allowed
router.put('/books/:id', async (req, res) => {
    try {
        const id = req.params.id;
        // Build dynamic SET clause safely
        const allowed = ['title', 'author', 'price', 'stock', 'description', 'image_url', 'cover'];
        const updates = [];
        const params = [];
        for (const k of allowed) {
            if (req.body[k] !== undefined) {
                updates.push(`${k} = ?`);
                params.push(req.body[k]);
            }
        }
        if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
        params.push(id);
        const sql = `UPDATE books SET ${updates.join(', ')} WHERE id = ?`;
        await pool.query(sql, params);
        const [rows] = await pool.query('SELECT * FROM books WHERE id = ?', [id]);
        res.json({ success: true, book: rows[0] });
    } catch (err) {
        console.error('Admin update book failed:', err);
        res.status(500).json({ error: err.message || 'update failed' });
    }
});

// Delete book (admin)
router.delete('/books/:id', async (req, res) => {
    try {
        const id = req.params.id;
        // If there are FK constraints (order_items, gifts) you may prefer to mark soft-delete.
        // This will attempt to delete; if FK blocks, return an error for manual handling.
        await pool.query('DELETE FROM books WHERE id = ?', [id]);
        res.json({ success: true, deletedId: id });
    } catch (err) {
        console.error('Admin delete book failed:', err);
        res.status(500).json({ error: err.message || 'delete failed' });
    }
});


module.exports = router;
