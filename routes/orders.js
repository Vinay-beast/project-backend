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

    // Rent: due passed -> Completed
    if (order.mode === 'rent' && order.rental_end) {
        if (new Date(order.rental_end) <= now && order.status !== 'Completed') {
            order.status = 'Completed';
        } else if (new Date(order.rental_end) > now && !['Active', 'Completed'].includes(order.status)) {
            order.status = 'Active';
        }
    }

    // Buy: ETA passed -> Delivered
    if (order.mode === 'buy' && order.delivery_eta) {
        if (order.status === 'Pending' && new Date(order.delivery_eta) <= now) {
            order.status = 'Delivered';
        }
    }

    // Gift: always Delivered (digital)
    if (order.mode === 'gift' && order.status !== 'Delivered') {
        order.status = 'Delivered';
    }

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

        // Basic validation
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
            // ---------- PRICE CALCULATION / VALIDATION ----------
            // We'll compute item-level final prices (based on mode), shipping fee (for buys),
            // COD fee (if applicable), and the overall total. We also maintain processedItems
            // array that holds { book_id, quantity, price } to insert into order_items.

            let total = 0.0;
            let shippingFee = 0.0;
            let codFee = 0.0;
            const processedItems = [];

            // Determine rentalDays used for pricing (default 30)
            const rentalDays = (mode === 'rent') ? (rental_duration && Number(rental_duration) > 0 ? Number(rental_duration) : 30) : null;

            for (const item of items) {
                if (!item.book_id || !item.quantity || Number(item.quantity) <= 0) {
                    throw new Error('Invalid order item data');
                }

                const [rows] = await conn.query('SELECT price, stock FROM books WHERE id = ?', [item.book_id]);
                if (!rows.length) throw new Error(`Book ${item.book_id} not found`);

                const book = rows[0];
                const fullPrice = Number(book.price || 0);

                // Price selection:
                // - buy: full price
                // - rent: frontend uses 0.35 for 30 days, 0.55 otherwise -> match that
                // - gift: treat as full price (unless you want different business rules)
                let finalPrice = fullPrice;
                if (mode === 'rent') {
                    finalPrice = fullPrice * (rentalDays === 30 ? 0.35 : 0.55);
                } else if (mode === 'gift') {
                    finalPrice = fullPrice;
                } // buy: keep fullPrice

                // Add to total (quantity * finalPrice)
                total += finalPrice * Number(item.quantity);

                // Save processed item for insertion (store price used)
                processedItems.push({
                    book_id: item.book_id,
                    quantity: Number(item.quantity),
                    price: Number(finalPrice)
                });

                // Stock management only for buy
                if (mode === 'buy') {
                    if (Number(book.stock) < Number(item.quantity)) {
                        throw new Error(`Insufficient stock for book ${item.book_id}`);
                    }
                    await conn.query('UPDATE books SET stock = stock - ? WHERE id = ?', [item.quantity, item.book_id]);
                }
            }

            // Shipping for buy mode
            if (mode === 'buy') {
                const shippingCosts = { standard: 30, express: 70, priority: 120 };
                const chosen = shipping_speed || 'standard';
                shippingFee = Number(shippingCosts[chosen] ?? shippingCosts['standard']);
                total += shippingFee;
            }

            // COD fee: only applies when buyer chooses COD and shipping is needed (i.e., buy)
            if (payment_method === 'cod' && mode === 'buy') {
                codFee = 10;
                total += codFee;
            }

            // ---------- dates & status ----------
            let deliveryEta = null;
            let rentalEnd = null;
            if (mode === 'buy') {
                const etaDays = shipping_speed === 'priority' ? 1 : (shipping_speed === 'express' ? 3 : 5);
                deliveryEta = new Date();
                deliveryEta.setDate(deliveryEta.getDate() + etaDays);
            }
            if (mode === 'rent') {
                const days = rentalDays || 30;
                rentalEnd = new Date();
                rentalEnd.setDate(rentalEnd.getDate() + days);
            }

            const initialStatus = mode === 'buy' ? 'Pending' : mode === 'rent' ? 'Active' : 'Delivered';

            // ---------- INSERT ORDER ----------
            // Ensure orders table has shipping_fee and cod_fee columns (see migration if not)
            const [orderResult] = await conn.query(
                `INSERT INTO orders (
                    user_id, mode, total, shipping_address_id,
                    payment_method, notes, rental_duration,
                    rental_end, gift_email, shipping_speed,
                    shipping_fee, cod_fee,
                    status, created_at, delivery_eta
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
                [
                    req.user.id,
                    mode,
                    Number(total.toFixed(2)),
                    shipping_address_id || null,
                    payment_method || null,
                    notes || null,
                    rental_duration || null,
                    rentalEnd,
                    gift_email || null,
                    mode === 'buy' ? (shipping_speed || 'standard') : null,
                    Number(shippingFee),
                    Number(codFee),
                    initialStatus,
                    deliveryEta
                ]
            );

            const orderId = orderResult.insertId;

            // ---------- INSERT ORDER ITEMS USING processedItems ----------
            for (const pi of processedItems) {
                await conn.query(
                    'INSERT INTO order_items (order_id, book_id, quantity, price) VALUES (?, ?, ?, ?)',
                    [orderId, pi.book_id, pi.quantity, Number(pi.price)]
                );
            }

            // ---------- GIFTS (unchanged semantics) ----------
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

            // Fetch the created order with items to return authoritative values to client
            const [ordersRows] = await conn.query('SELECT * FROM orders WHERE id = ?', [orderId]);
            const createdOrder = ordersRows[0] || null;
            if (createdOrder) {
                const [orderItemsRows] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
                createdOrder.items = orderItemsRows || [];
                // Soft status patch just in case
                softStatusPatch(createdOrder);
            }

            return res.status(201).json({ order: createdOrder, message: 'Order created successfully' });

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
            softStatusPatch(order);
        }
        setNoCache(res);
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
        softStatusPatch(order);
        setNoCache(res);
        return res.json(order);
    } catch (err) {
        console.error('Error fetching single order:', err);
        return res.status(500).json({ message: 'Server error while fetching order' });
    }
});

module.exports = router;
