// routes/payments.js
const router = require('express').Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const pool = require('../config/database');
const auth = require('../middleware/auth');

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_RMwydkIY55I1PM',
    key_secret: process.env.RAZORPAY_KEY_SECRET || '5KWtl1v7Xgx55aRzcf5TkM6C'
});

/**
 * POST /api/payments/create-order
 * Create Razorpay order for payment
 */
router.post('/create-order', auth, async (req, res) => {
    try {
        const { amount, currency = 'INR', orderId, customerInfo } = req.body;

        // Validate required fields
        if (!amount || !orderId) {
            return res.status(400).json({
                success: false,
                message: 'Amount and order ID are required'
            });
        }

        // Get order details from database
        const [orderDetails] = await pool.query(
            'SELECT * FROM orders WHERE id = ? AND user_id = ?',
            [orderId, req.user.id]
        );

        if (!orderDetails.length) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        const order = orderDetails[0];

        // Create Razorpay order
        const razorpayOrder = await razorpay.orders.create({
            amount: Math.round(amount * 100), // Convert to paise
            currency: currency,
            receipt: `order_${orderId}_${Date.now()}`,
            notes: {
                booknook_order_id: orderId,
                user_id: req.user.id,
                order_mode: order.mode
            }
        });

        // Store Razorpay order ID in database
        await pool.query(
            'UPDATE orders SET razorpay_order_id = ? WHERE id = ?',
            [razorpayOrder.id, orderId]
        );

        res.json({
            success: true,
            orderId: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            key: process.env.RAZORPAY_KEY_ID || 'rzp_test_RMwydkIY55I1PM'
        });

    } catch (error) {
        console.error('Create order error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create payment order'
        });
    }
});

/**
 * POST /api/payments/verify
 * Verify Razorpay payment signature
 */
router.post('/verify', auth, async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            booknook_order_id
        } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({
                success: false,
                message: 'Missing required payment parameters'
            });
        }

        // Verify signature
        const sign = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSign = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '5KWtl1v7Xgx55aRzcf5TkM6C')
            .update(sign.toString())
            .digest('hex');

        if (razorpay_signature !== expectedSign) {
            return res.status(400).json({
                success: false,
                message: 'Invalid payment signature'
            });
        }

        // Get payment details from Razorpay
        const payment = await razorpay.payments.fetch(razorpay_payment_id);

        // Check if payment was actually successful
        if (payment.status !== 'captured' && payment.status !== 'authorized') {
            return res.status(400).json({
                success: false,
                message: `Payment was not successful. Status: ${payment.status}`
            });
        }

        // Update order status in database only if payment is successful
        const paymentStatus = payment.status === 'captured' ? 'completed' : 'pending';
        await pool.query(`
            UPDATE orders 
            SET 
                payment_status = ?,
                razorpay_payment_id = ?,
                razorpay_signature = ?,
                payment_method = 'razorpay',
                updated_at = NOW()
            WHERE razorpay_order_id = ? AND user_id = ?
        `, [paymentStatus, razorpay_payment_id, razorpay_signature, razorpay_order_id, req.user.id]);

        // Get updated order details
        const [updatedOrder] = await pool.query(
            'SELECT * FROM orders WHERE razorpay_order_id = ? AND user_id = ?',
            [razorpay_order_id, req.user.id]
        );

        if (updatedOrder.length && paymentStatus === 'completed') {
            const order = updatedOrder[0];

            // Update order status based on mode - only if payment is completed
            let newStatus = 'Pending';
            if (order.mode === 'buy') {
                newStatus = 'Pending'; // Will be updated to Delivered when delivery_eta passes
            } else if (order.mode === 'rent') {
                newStatus = 'Active';
            } else if (order.mode === 'gift') {
                newStatus = 'Delivered'; // Digital gifts are instantly delivered
            }

            await pool.query(
                'UPDATE orders SET status = ? WHERE id = ?',
                [newStatus, order.id]
            );

            // Create gifts only after successful payment - for gift orders
            if (order.mode === 'gift' && order.gift_email) {
                const crypto = require('crypto');

                // Find recipient user ID if they exist
                let recipientUserId = null;
                const [users] = await pool.query('SELECT id FROM users WHERE email = ?', [order.gift_email]);
                if (users.length) {
                    recipientUserId = users[0].id;
                }

                // Get order items to create gifts
                const [orderItems] = await pool.query(
                    'SELECT book_id, quantity FROM order_items WHERE order_id = ?',
                    [order.id]
                );

                // Create gift entries
                for (const item of orderItems) {
                    const token = crypto.randomBytes(24).toString('hex');
                    await pool.query(
                        `INSERT INTO gifts (order_id, book_id, quantity, recipient_email, claim_token, recipient_user_id)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [order.id, item.book_id, item.quantity, order.gift_email, token, recipientUserId]
                    );
                }

                console.log(`Gifts created for order ${order.id} to recipient ${order.gift_email}`);
            }
        }

        res.json({
            success: true,
            message: 'Payment verified successfully',
            payment: {
                id: payment.id,
                amount: payment.amount / 100,
                currency: payment.currency,
                status: payment.status,
                method: payment.method
            }
        });

    } catch (error) {
        console.error('Payment verification error:', error);
        res.status(500).json({
            success: false,
            message: 'Payment verification failed'
        });
    }
});

/**
 * POST /api/payments/webhook
 * Razorpay webhook handler
 */
router.post('/webhook', async (req, res) => {
    try {
        const webhookSignature = req.headers['x-razorpay-signature'];
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

        if (webhookSecret) {
            const expectedSignature = crypto
                .createHmac('sha256', webhookSecret)
                .update(JSON.stringify(req.body))
                .digest('hex');

            if (webhookSignature !== expectedSignature) {
                return res.status(400).json({ message: 'Invalid webhook signature' });
            }
        }

        const event = req.body;

        // Handle different webhook events
        switch (event.event) {
            case 'payment.captured':
                await handlePaymentCaptured(event.payload.payment.entity);
                break;
            case 'payment.failed':
                await handlePaymentFailed(event.payload.payment.entity);
                break;
            default:
                console.log('Unhandled webhook event:', event.event);
        }

        res.json({ status: 'ok' });

    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ message: 'Webhook processing failed' });
    }
});

async function handlePaymentCaptured(payment) {
    try {
        await pool.query(
            'UPDATE orders SET payment_status = "captured" WHERE razorpay_payment_id = ?',
            [payment.id]
        );
        console.log('Payment captured for payment ID:', payment.id);
    } catch (error) {
        console.error('Error handling payment captured:', error);
    }
}

async function handlePaymentFailed(payment) {
    try {
        await pool.query(
            'UPDATE orders SET payment_status = "failed" WHERE razorpay_payment_id = ?',
            [payment.id]
        );
        console.log('Payment failed for payment ID:', payment.id);
    } catch (error) {
        console.error('Error handling payment failed:', error);
    }
}

/**
 * GET /api/payments/status/:orderId
 * Get payment status for an order
 */
router.get('/status/:orderId', auth, async (req, res) => {
    try {
        const orderId = req.params.orderId;

        const [orders] = await pool.query(
            'SELECT payment_status, razorpay_payment_id, razorpay_order_id FROM orders WHERE id = ? AND user_id = ?',
            [orderId, req.user.id]
        );

        if (!orders.length) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        res.json({
            success: true,
            paymentStatus: orders[0].payment_status || 'pending',
            razorpayOrderId: orders[0].razorpay_order_id,
            razorpayPaymentId: orders[0].razorpay_payment_id
        });

    } catch (error) {
        console.error('Payment status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get payment status'
        });
    }
});

module.exports = router;