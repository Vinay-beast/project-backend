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

/**
 * DELETE /api/admin/orders/unpaid
 * Delete all orders where payment_status is 'pending' or 'failed' (never paid).
 * Restores book stock for buy-mode orders.
 */
router.delete('/orders/unpaid', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Find all unpaid buy-mode orders so we can restore stock
        const [unpaidBuy] = await conn.query(
            `SELECT o.id, oi.book_id, oi.quantity
             FROM orders o
             JOIN order_items oi ON oi.order_id = o.id
             WHERE o.payment_status IN ('pending', 'failed')
               AND o.mode = 'buy'`
        );

        // Restore stock for each item
        for (const row of unpaidBuy) {
            await conn.query(
                'UPDATE books SET stock = stock + ? WHERE id = ?',
                [row.quantity, row.book_id]
            );
        }

        // Delete order_items first (FK), then the orders
        const [unpaidOrders] = await conn.query(
            `SELECT id FROM orders WHERE payment_status IN ('pending', 'failed')`
        );
        const ids = unpaidOrders.map(o => o.id);

        let deleted = 0;
        if (ids.length) {
            await conn.query(`DELETE FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`, ids);
            const [result] = await conn.query(`DELETE FROM orders WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
            deleted = result.affectedRows;
        }

        await conn.commit();
        res.json({ success: true, deleted });
    } catch (e) {
        await conn.rollback();
        console.error('Delete unpaid orders failed:', e);
        res.status(500).json({ message: 'Server error' });
    } finally {
        conn.release();
    }
});

/**
 * PUT /api/admin/orders/:id/status
 * Admin can update the status of any order
 */
router.put('/orders/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const allowed = ['Pending', 'Delivered', 'Cancelled', 'Active', 'Completed'];
        if (!allowed.includes(status)) {
            return res.status(400).json({ message: `Invalid status. Allowed: ${allowed.join(', ')}` });
        }
        const [result] = await pool.query('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Order not found' });
        res.json({ success: true, id, status });
    } catch (e) {
        console.error('Admin update order status failed:', e);
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * GET /api/admin/stats
 * Dashboard analytics: revenue 7d, payment status breakdown, top books, low stock, new users
 */
router.get('/stats', async (req, res) => {
    try {
        const [revenueRows] = await pool.query(`
            SELECT DATE(created_at) as day, SUM(total) as revenue, COUNT(*) as count
            FROM orders
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
              AND payment_status = 'completed'
            GROUP BY DATE(created_at)
            ORDER BY day ASC
        `);
        const [paymentRows] = await pool.query(`
            SELECT COALESCE(payment_status, 'unknown') as status, COUNT(*) as count
            FROM orders
            GROUP BY payment_status
        `);
        const [topBooksRows] = await pool.query(`
            SELECT b.title, b.author, SUM(oi.quantity) as total_sold
            FROM books b
            JOIN order_items oi ON b.id = oi.book_id
            JOIN orders o ON oi.order_id = o.id
            WHERE o.payment_status = 'completed'
            GROUP BY b.id
            ORDER BY total_sold DESC
            LIMIT 5
        `);
        const [lowStockRows] = await pool.query(`
            SELECT id, title, author, stock
            FROM books
            WHERE stock <= 5
            ORDER BY stock ASC
            LIMIT 10
        `);
        const [newUsersRows] = await pool.query(`
            SELECT id, name, email, created_at
            FROM users
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            ORDER BY created_at DESC
        `);
        res.json({
            success: true,
            revenueLast7Days: revenueRows,
            paymentStatus: paymentRows,
            topBooks: topBooksRows,
            lowStock: lowStockRows,
            newUsers: newUsersRows,
            newUsersCount: newUsersRows.length
        });
    } catch (e) {
        console.error('Admin stats error:', e);
        res.status(500).json({ message: 'Failed to fetch stats' });
    }
});


module.exports = router;
