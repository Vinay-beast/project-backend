// routes/orders.js
const router = require('express').Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const crypto = require('crypto');

/* ---------------------------- helpers ---------------------------- */
function setNoCache(res) {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
    });
}

function softStatusPatch(order) {
    const now = new Date();
    // ... (Your helper function is unchanged)
    return order;
}

/* ------------------------- create new order ------------------------- */
/**
 * POST /api/orders
 * Protected
 */
router.post('/', auth, async (req, res) => {
    try {
        const {
            items,
            mode,
            shipping_address_id,
            payment_method,
            notes,
            rental_duration,
            gift_email,
            shipping_speed
        } = req.body;

        // Basic validation (unchanged)
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ message: 'Order must contain at least one item' });
        }
        if (!mode || !['buy', 'rent', 'gift'].includes(mode)) {
            return res.status(400).json({ message: 'Invalid order mode' });
        }
        if (mode === 'gift' && !gift_email) {
            return res.status(400).json({ message: 'gift_email is required for gifts' });
        }

        const conn = await pool.getConnection();
        await conn.beginTransaction();

        try {
            // ===== FIX STARTS HERE =====

            let total = 0;
            const processedItems = []; // Array to hold items with their correct prices

            // First, loop through items to validate them and calculate the correct total price
            for (const item of items) {
                if (!item.book_id || !item.quantity || item.quantity <= 0) {
                    throw new Error('Invalid order item data');
                }

                const [rows] = await conn.query(
                    'SELECT price, stock FROM books WHERE id = ?',
                    [item.book_id]
                );
                if (!rows.length) throw new Error(`Book ${item.book_id} not found`);

                const book = rows[0];
                const fullPrice = Number(book.price);

                // **THIS IS THE FIX**: Calculate the final price based on the order mode
                let finalPrice = fullPrice; // Default to the book's full price
                if (mode === 'rent') {
                    const RENTAL_PERCENTAGE = 0.30; // 30% rental fee (you can adjust this)
                    finalPrice = fullPrice * RENTAL_PERCENTAGE;
                }

                // Add the correctly calculated price to the order total
                total += finalPrice * Number(item.quantity);
                processedItems.push({ ...item, price: finalPrice }); // Store the item with its correct price

                // Stock management logic is unchanged
                if (mode === 'buy') {
                    if (Number(book.stock) < Number(item.quantity)) {
                        throw new Error(`Insufficient stock for book ${item.book_id}`);
                    }
                    await conn.query(
                        'UPDATE books SET stock = stock - ? WHERE id = ?',
                        [item.quantity, item.book_id]
                    );
                }
            }

            // ===== END OF PRICE CALCULATION FIX =====


            // shipping cost logic is unchanged
            if (mode === 'buy') {
                const shippingCosts = { standard: 30, express: 70, priority: 120 };
                total += shippingCosts[shipping_speed] ?? 30;
            }

            // delivery_eta & rental_end logic is unchanged
            let deliveryEta = null;
            let rentalEnd = null;
            if (mode === 'buy') {
                const etaDays = shipping_speed === 'priority' ? 1 : shipping_speed === 'express' ? 3 : 5;
                deliveryEta = new Date();
                deliveryEta.setDate(deliveryEta.getDate() + etaDays);
            }
            if (mode === 'rent') {
                const days = rental_duration && Number(rental_duration) > 0 ? Number(rental_duration) : 30;
                rentalEnd = new Date();
                rentalEnd.setDate(rentalEnd.getDate() + days);
            }

            // initial status logic is unchanged
            const initialStatus = mode === 'buy' ? 'Pending' : mode === 'rent' ? 'Active' : 'Delivered';

            // insert order with the CORRECTED total
            const [orderResult] = await conn.query(
                `INSERT INTO orders (
                    user_id, mode, total, shipping_address_id,
                    payment_method, notes, rental_duration,
                    rental_end, gift_email, shipping_speed,
                    status, created_at, delivery_eta
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
                [
                    req.user.id, mode, total, shipping_address_id || null,
                    payment_method || null, notes || null, rental_duration || null,
                    rentalEnd, gift_email || null, mode === 'buy' ? (shipping_speed || 'standard') : null,
                    initialStatus, deliveryEta
                ]
            );
            const orderId = orderResult.insertId;

            // ===== FIX STARTS HERE (PART 2) =====

            // Now, insert the items using the `processedItems` array which has the CORRECT prices
            for (const item of processedItems) {
                await conn.query(
                    'INSERT INTO order_items (order_id, book_id, quantity, price) VALUES (?, ?, ?, ?)',
                    [orderId, item.book_id, item.quantity, item.price] // Use the correct price
                );
            }

            // ===== END OF ITEM INSERTION FIX =====

            // gifts logic is unchanged
            if (mode === 'gift') {
                let recipientUserId = null;
                const [u] = await conn.query('SELECT id FROM users WHERE email = ?', [gift_email]);
                if (u.length) recipientUserId = u[0].id;

                for (const item of items) {
                    const token = crypto.randomBytes(24).toString('hex');
                    await conn.query(
                        `INSERT INTO gifts (order_id, book_id, quantity, recipient_email, claim_token, recipient_user_id, claimed_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [orderId, item.book_id, item.quantity, gift_email, token, recipientUserId, recipientUserId ? new Date() : null]
                    );
                }
            }

            await conn.commit();
            return res.status(201).json({ orderId, message: 'Order created successfully' });

        } catch (e) {
            await conn.rollback();
            console.error('Order creation failed:', e);
            return res.status(400).json({ message: e.message || 'Order creation failed' });
        } finally {
            conn.release();
        }

    } catch (err) {
        console.error('Unexpected error in order creation:', err);
        return res.status(500).json({ message: 'Server error while creating order' });
    }
});


// All of your GET routes are unchanged and correct as we fixed them before.
/* ------------------------ list current user's orders ------------------------ */
router.get('/', auth, async (req, res) => {
    try {
        const [orders] = await pool.query(
            'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC',
            [req.user.id]
        );
        if (orders.length === 0) {
            return res.json([]);
        }
        const orderIds = orders.map(o => o.id);
        const [items] = await pool.query(
            'SELECT * FROM order_items WHERE order_id IN (?)',
            [orderIds]
        );
        for (const order of orders) {
            order.items = items.filter(item => item.order_id === order.id);
        }
        res.json(orders);
    } catch (err) {
        console.error("Error fetching user orders:", err);
        res.status(500).json({ message: "Server error while fetching orders" });
    }
});

/* ---------------------------- get a single order --------------------------- */
router.get('/:id', auth, async (req, res) => {
    try {
        const [orders] = await pool.query(
            'SELECT * FROM orders WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );
        if (orders.length === 0) {
            return res.status(404).json({ message: 'Order not found' });
        }
        const order = orders[0];
        const [items] = await pool.query(
            'SELECT * FROM order_items WHERE order_id = ?',
            [req.params.id]
        );
        order.items = items;
        return res.json(order);
    } catch (err) {
        console.error('Error fetching single order:', err);
        return res.status(500).json({ message: 'Server error while fetching order' });
    }
});

module.exports = router;