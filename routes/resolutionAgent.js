// backend/routes/resolutionAgent.js
// MULTI-AGENT RESOLUTION & SUPPORT SYSTEM
// Features: 4 Specialized Agents (Intent Classifier, Data Retrieval, Resolution Engine, Response Composer)
// Uses: Groq API (FREE) with Llama 3.3 70B

const router = require('express').Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const https = require('https');
const crypto = require('crypto');

// ============================================
// GROQ API CONFIGURATION
// ============================================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'api.groq.com';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ============================================
// AGENT DEFINITIONS — 4 specialized agents
// ============================================
const AGENTS = {
    INTENT: {
        name: '🎯 Intent Classifier',
        role: 'Classify the user query into a resolution category',
        systemPrompt: `You are the Intent Classifier Agent for a bookstore support system.

Classify the user query into EXACTLY ONE of these categories:
1. "payment_issue" — payment was deducted but order not placed, payment failed, double charge, refund request
2. "order_status" — where is my order, delivery status, tracking, when will it arrive
3. "last_order" — show my last/recent order, what did I order last
4. "general_help" — anything else (return policy, how to use, account questions)

Also extract:
- urgency: "high" (money stuck, payment problem) | "medium" (delivery question) | "low" (general info)
- keywords: relevant terms from the query

RESPOND ONLY WITH VALID JSON:
{"category": "payment_issue", "urgency": "high", "keywords": [], "reasoning": "..."}`
    },

    DATA_RETRIEVAL: {
        name: '🔍 Data Retrieval Agent',
        role: 'Determine what data to fetch based on intent',
        systemPrompt: `You are the Data Retrieval Agent. Given the classified intent and available user data, decide what information is needed.

Based on the intent category, determine:
1. data_needed: array of data types to fetch ["orders", "failed_payments", "last_order", "payment_details"]
2. filters: any filters to apply (status, date range, etc.)
3. priority_data: the most important piece of data for this query

RESPOND ONLY WITH VALID JSON:
{"data_needed": [], "filters": {}, "priority_data": "..."}`
    },

    RESOLUTION: {
        name: '⚡ Resolution Engine',
        role: 'Analyze data and determine the resolution action',
        systemPrompt: `You are the Resolution Engine Agent for a bookstore. Given user intent and their order/payment data, determine the resolution.

For payment_issue:
- If there's a failed order with payment deducted → recommend "retry_payment" or "auto_resolve"
- If payment_status is 'failed' but razorpay_payment_id exists → payment was captured but order failed → "auto_resolve"
- If no failed orders found → "no_issue_found"

For order_status:
- Calculate days remaining from delivery_eta
- Determine current status (Pending/Shipped/Delivered/Active for rentals)

For last_order:
- Summarize the most recent order details

Output:
1. action: the recommended action ("auto_resolve", "retry_payment", "show_status", "show_order", "escalate", "no_issue_found")
2. resolution_details: specific details about the resolution
3. confidence: "high", "medium", "low"

RESPOND ONLY WITH VALID JSON:
{"action": "...", "resolution_details": "...", "confidence": "...", "data_summary": "..."}`
    },

    COMPOSER: {
        name: '💬 Response Composer',
        role: 'Compose a friendly user-facing response',
        systemPrompt: `You are the Response Composer Agent. Given the resolution action and data, compose a friendly, clear response for the customer.

Rules:
- Be empathetic and professional
- Use simple language
- If payment was resolved, reassure the customer
- Include specific order details (order ID, amount, book titles) when available
- If action buttons are needed, mention them clearly
- Keep response under 150 words
- Use line breaks for readability
- If amounts are mentioned, use ₹ symbol

Output:
1. message: the formatted response message (can include <br> for line breaks, <strong> for emphasis)
2. show_action_button: true/false — whether to show a resolution action button
3. action_button_text: text for the button (e.g., "Resolve Payment", "View Order")
4. action_type: the action the button triggers ("resolve_payment", "view_order", "contact_support")
5. tone: "reassuring", "informative", "urgent", "friendly"

RESPOND ONLY WITH VALID JSON:
{"message": "...", "show_action_button": false, "action_button_text": "", "action_type": "", "tone": "friendly"}`
    }
};

// ============================================
// GROQ API CALL FUNCTION
// ============================================
async function callGroqAgent(agentType, userMessage, context = '') {
    const agent = AGENTS[agentType];

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`${agent.name} starting...`);
    console.log(`   Role: ${agent.role}`);

    return new Promise((resolve, reject) => {
        const requestBody = JSON.stringify({
            model: GROQ_MODEL,
            messages: [
                { role: 'system', content: agent.systemPrompt },
                { role: 'user', content: context ? `${context}\n\nUser Query: ${userMessage}` : userMessage }
            ],
            temperature: 0.3,
            max_tokens: 1024
        });

        const options = {
            hostname: GROQ_API_URL,
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (result.error) {
                        console.log(`   ❌ Error: ${result.error.message}`);
                        reject(new Error(result.error.message));
                        return;
                    }

                    const content = result.choices[0]?.message?.content || '';
                    console.log(`   ✅ Response received`);

                    // Parse JSON from response
                    try {
                        let jsonStr = content;
                        if (content.includes('```json')) {
                            jsonStr = content.split('```json')[1].split('```')[0].trim();
                        } else if (content.includes('```')) {
                            jsonStr = content.split('```')[1].split('```')[0].trim();
                        }
                        const parsed = JSON.parse(jsonStr);
                        console.log(`   📤 Parsed output:`, JSON.stringify(parsed).substring(0, 100) + '...');
                        resolve(parsed);
                    } catch (parseErr) {
                        console.log(`   ⚠️ Could not parse JSON, returning raw`);
                        resolve({ raw: content });
                    }
                } catch (e) {
                    console.log(`   ❌ Parse error:`, e.message);
                    reject(e);
                }
            });
        });

        req.on('error', (e) => {
            console.log(`   ❌ Request error:`, e.message);
            reject(e);
        });

        req.setTimeout(30000, () => {
            console.log(`   ⚠️ Timeout`);
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(requestBody);
        req.end();
    });
}

// ============================================
// HELPER: Fetch user order data
// ============================================
async function getUserOrders(userId, filters = {}) {
    let query = `
        SELECT o.*, 
               GROUP_CONCAT(b.title SEPARATOR ', ') as book_titles,
               GROUP_CONCAT(b.id) as book_ids
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN books b ON oi.book_id = b.id
        WHERE o.user_id = ?
    `;
    const params = [userId];

    if (filters.payment_status) {
        query += ` AND o.payment_status = ?`;
        params.push(filters.payment_status);
    }
    if (filters.status) {
        query += ` AND o.status = ?`;
        params.push(filters.status);
    }

    query += ` GROUP BY o.id ORDER BY o.created_at DESC`;

    if (filters.limit) {
        query += ` LIMIT ?`;
        params.push(filters.limit);
    }

    const [rows] = await pool.query(query, params);
    return rows;
}

async function getFailedPaymentOrders(userId) {
    const [rows] = await pool.query(`
        SELECT o.*, 
               GROUP_CONCAT(b.title SEPARATOR ', ') as book_titles,
               GROUP_CONCAT(b.id) as book_ids,
               (SELECT COUNT(*) FROM orders o2 WHERE o2.user_id = o.user_id AND o2.id <= o.id) as user_order_number
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN books b ON oi.book_id = b.id
        WHERE o.user_id = ? 
          AND (o.payment_status = 'failed' OR o.payment_status = 'pending')
          AND o.razorpay_order_id IS NOT NULL
        GROUP BY o.id
        ORDER BY o.created_at DESC
    `, [userId]);
    return rows;
}

// ============================================
// ROUTES
// ============================================

/**
 * POST /api/resolution-agent/process
 * Main orchestrator — runs all 4 agents in sequence
 */
router.post('/process', auth, async (req, res) => {
    try {
        const { query } = req.body;
        if (!query || !query.trim()) {
            return res.status(400).json({ success: false, message: 'Query is required' });
        }

        console.log('\n' + '═'.repeat(60));
        console.log('🛡️ RESOLUTION AGENT PIPELINE START');
        console.log('═'.repeat(60));
        console.log(`User: ${req.user.id} | Query: "${query}"`);

        const agentInsights = {};

        // ── Agent 1: Intent Classifier ──
        const intentResult = await callGroqAgent('INTENT', query);
        agentInsights.intent = {
            agent: AGENTS.INTENT.name,
            category: intentResult.category || 'general_help',
            urgency: intentResult.urgency || 'low',
            keywords: intentResult.keywords || [],
            reasoning: intentResult.reasoning || ''
        };
        console.log(`\n📋 Intent: ${intentResult.category} (urgency: ${intentResult.urgency})`);

        // ── Agent 2: Data Retrieval ──
        const dataContext = `Intent: ${intentResult.category}, Urgency: ${intentResult.urgency}, Keywords: ${(intentResult.keywords || []).join(', ')}`;
        const dataResult = await callGroqAgent('DATA_RETRIEVAL', query, dataContext);
        agentInsights.dataRetrieval = {
            agent: AGENTS.DATA_RETRIEVAL.name,
            dataPulled: dataResult.data_needed || [],
            priorityData: dataResult.priority_data || ''
        };

        // ── Fetch actual data from DB ──
        let orderData = {};
        const category = intentResult.category || 'general_help';

        if (category === 'payment_issue') {
            orderData.failedOrders = await getFailedPaymentOrders(req.user.id);
            orderData.recentOrders = await getUserOrders(req.user.id, { limit: 3 });
        } else if (category === 'order_status') {
            orderData.recentOrders = await getUserOrders(req.user.id, { limit: 5 });
        } else if (category === 'last_order') {
            orderData.lastOrder = await getUserOrders(req.user.id, { limit: 1 });
        } else {
            orderData.recentOrders = await getUserOrders(req.user.id, { limit: 3 });
        }

        // ── Agent 3: Resolution Engine ──
        const resolutionContext = `
Intent: ${category}
Urgency: ${intentResult.urgency}
User Query: "${query}"

Order Data:
${JSON.stringify(orderData, null, 2)}
        `.trim();

        const resolutionResult = await callGroqAgent('RESOLUTION', query, resolutionContext);
        agentInsights.resolution = {
            agent: AGENTS.RESOLUTION.name,
            action: resolutionResult.action || 'no_action',
            confidence: resolutionResult.confidence || 'low',
            details: resolutionResult.resolution_details || ''
        };
        console.log(`\n⚡ Resolution: ${resolutionResult.action} (confidence: ${resolutionResult.confidence})`);

        // ── Deterministic override — never trust the LLM when we have clear evidence ──
        // If it's a payment issue AND we found a failed order with a payment ID → always auto_resolve
        if (category === 'payment_issue' && orderData.failedOrders?.length > 0) {
            const fo = orderData.failedOrders[0];
            if (fo.razorpay_payment_id) {
                resolutionResult.action = 'auto_resolve';
                resolutionResult.confidence = 'high';
                resolutionResult.resolution_details = `Found payment issue on order #${fo.user_order_number || fo.id} for ₹${fo.total} (${fo.book_titles}). Payment ID ${fo.razorpay_payment_id} is captured. Ready to auto-resolve.`;
                agentInsights.resolution.action = 'auto_resolve';
                agentInsights.resolution.confidence = 'high';
                agentInsights.resolution.details = resolutionResult.resolution_details;
                console.log(`   🔒 Deterministic override → auto_resolve (payment ID found)`);
            }
        }

        // ── Agent 4: Response Composer ──
        const composerContext = `
Intent: ${category}
Resolution Action: ${resolutionResult.action}
Resolution Details: ${resolutionResult.resolution_details || 'N/A'}
Data Summary: ${resolutionResult.data_summary || JSON.stringify(orderData).substring(0, 500)}
Urgency: ${intentResult.urgency}
        `.trim();

        const composerResult = await callGroqAgent('COMPOSER', query, composerContext);

        console.log('\n' + '═'.repeat(60));
        console.log('🛡️ RESOLUTION AGENT PIPELINE COMPLETE');
        console.log('═'.repeat(60));

        // Build response
        const response = {
            success: true,
            message: composerResult.message || 'I apologize, but I could not process your request. Please try again.',
            category,
            urgency: intentResult.urgency,
            action: resolutionResult.action,
            showActionButton: composerResult.show_action_button || false,
            actionButtonText: composerResult.action_button_text || '',
            actionType: composerResult.action_type || '',
            tone: composerResult.tone || 'friendly',
            agentInsights,
            // Include failed order data for the frontend resolve action
            failedOrders: orderData.failedOrders || [],
        };

        // ── Force action button whenever action is auto_resolve ──
        // The Composer LLM may forget to set show_action_button=true — make it deterministic
        if (resolutionResult.action === 'auto_resolve' && orderData.failedOrders?.length > 0) {
            response.showActionButton = true;
            response.actionButtonText = response.actionButtonText || '🔧 Resolve My Payment';
            response.actionType = 'resolve_payment';
        }

        response.recentOrders = (orderData.recentOrders || orderData.lastOrder || []).slice(0, 3);

        res.json(response);

    } catch (error) {
        console.error('Resolution Agent error:', error);
        res.status(500).json({
            success: false,
            message: 'Resolution agent encountered an error. Please try again.',
            error: error.message
        });
    }
});

/**
 * POST /api/resolution-agent/demo/simulate-failure
 * Creates a fake failed payment order for demo purposes
 */
router.post('/demo/simulate-failure', auth, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Pick a random book from the store
        const [books] = await conn.query(
            'SELECT id, title, price FROM books WHERE stock > 0 ORDER BY RAND() LIMIT 1'
        );
        if (!books.length) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({ success: false, message: 'No books available for demo' });
        }
        const book = books[0];
        const demoPaymentId = 'pay_DEMO_' + crypto.randomBytes(8).toString('hex');
        const demoOrderId = 'order_DEMO_' + crypto.randomBytes(8).toString('hex');

        // Create a failed order
        const [orderResult] = await conn.query(
            `INSERT INTO orders (
                user_id, mode, total, payment_method, payment_status,
                razorpay_order_id, razorpay_payment_id,
                status, notes, created_at, delivery_eta
            ) VALUES (?, 'buy', ?, 'razorpay', 'failed', ?, ?, 'Cancelled',
                      'DEMO: Simulated payment failure for testing', NOW(), NULL)`,
            [req.user.id, Number(book.price), demoOrderId, demoPaymentId]
        );

        // Insert order item
        await conn.query(
            'INSERT INTO order_items (order_id, book_id, quantity, price) VALUES (?, ?, 1, ?)',
            [orderResult.insertId, book.id, Number(book.price)]
        );

        await conn.commit();
        conn.release();

        res.json({
            success: true,
            message: `Demo: Simulated failed payment for "${book.title}" (₹${book.price})`,
            order: {
                id: orderResult.insertId,
                book: book.title,
                amount: book.price,
                payment_status: 'failed',
                razorpay_payment_id: demoPaymentId,
                razorpay_order_id: demoOrderId
            }
        });
    } catch (error) {
        await conn.rollback();
        conn.release();
        console.error('Demo simulate failure error:', error);
        res.status(500).json({ success: false, message: 'Failed to simulate payment failure' });
    }
});

/**
 * GET /api/resolution-agent/payment-issues
 * Lists user's failed/pending payment orders
 */
router.get('/payment-issues', auth, async (req, res) => {
    try {
        const failedOrders = await getFailedPaymentOrders(req.user.id);
        res.json({
            success: true,
            count: failedOrders.length,
            orders: failedOrders.map(o => ({
                id: o.id,
                user_order_number: o.user_order_number,
                total: o.total,
                book_titles: o.book_titles,
                payment_status: o.payment_status,
                razorpay_order_id: o.razorpay_order_id,
                razorpay_payment_id: o.razorpay_payment_id,
                created_at: o.created_at,
                is_demo: o.razorpay_payment_id?.startsWith('pay_DEMO_')
            }))
        });
    } catch (error) {
        console.error('Get payment issues error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch payment issues' });
    }
});

/**
 * POST /api/resolution-agent/resolve-payment/:orderId
 * Resolves a failed payment — auto-succeeds for DEMO orders
 */
router.post('/resolve-payment/:orderId', auth, async (req, res) => {
    try {
        const orderId = req.params.orderId;

        // Fetch the order
        const [orders] = await pool.query(
            'SELECT * FROM orders WHERE id = ? AND user_id = ?',
            [orderId, req.user.id]
        );

        if (!orders.length) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const order = orders[0];

        if (order.payment_status === 'completed') {
            return res.json({ success: true, message: 'This order is already completed!', already_resolved: true });
        }

        // For DEMO orders — auto-resolve
        const isDemo = order.razorpay_payment_id?.startsWith('pay_DEMO_');

        if (isDemo) {
            // Simulate successful payment resolution
            const deliveryEta = new Date();
            deliveryEta.setDate(deliveryEta.getDate() + 5); // Standard 5-day delivery

            await pool.query(`
                UPDATE orders 
                SET payment_status = 'completed',
                    status = 'Pending',
                    delivery_eta = ?,
                    notes = CONCAT(IFNULL(notes, ''), ' | RESOLVED via Resolution Agent'),
                    updated_at = NOW()
                WHERE id = ? AND user_id = ?
            `, [deliveryEta, orderId, req.user.id]);

            return res.json({
                success: true,
                message: 'Payment issue resolved successfully! Your order is now being processed.',
                resolved: true,
                order: {
                    id: order.id,
                    total: order.total,
                    new_status: 'Pending',
                    delivery_eta: deliveryEta,
                    payment_status: 'completed'
                }
            });
        }

        // For real orders — mark as needing review (in production would trigger refund flow)
        await pool.query(`
            UPDATE orders 
            SET notes = CONCAT(IFNULL(notes, ''), ' | Resolution requested by user at ${new Date().toISOString()}'),
                updated_at = NOW()
            WHERE id = ? AND user_id = ?
        `, [orderId, req.user.id]);

        res.json({
            success: true,
            message: 'Your payment issue has been escalated. Our team will resolve this within 24 hours.',
            resolved: false,
            escalated: true
        });

    } catch (error) {
        console.error('Resolve payment error:', error);
        res.status(500).json({ success: false, message: 'Failed to resolve payment issue' });
    }
});

/**
 * GET /api/resolution-agent/order-status/:orderId
 * Gets detailed order status with ETA
 */
router.get('/order-status/:orderId', auth, async (req, res) => {
    try {
        const [orders] = await pool.query(`
            SELECT o.*, 
                   GROUP_CONCAT(b.title SEPARATOR ', ') as book_titles
            FROM orders o
            LEFT JOIN order_items oi ON o.id = oi.order_id
            LEFT JOIN books b ON oi.book_id = b.id
            WHERE o.id = ? AND o.user_id = ?
            GROUP BY o.id
        `, [req.params.orderId, req.user.id]);

        if (!orders.length) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const order = orders[0];
        let etaMessage = '';

        if (order.delivery_eta) {
            const now = new Date();
            const eta = new Date(order.delivery_eta);
            const daysLeft = Math.ceil((eta - now) / (1000 * 60 * 60 * 24));

            if (daysLeft <= 0) {
                etaMessage = 'Your order has been delivered!';
            } else if (daysLeft === 1) {
                etaMessage = 'Arriving tomorrow!';
            } else {
                etaMessage = `Estimated delivery in ${daysLeft} days`;
            }
        }

        res.json({
            success: true,
            order: {
                id: order.id,
                mode: order.mode,
                status: order.status,
                total: order.total,
                book_titles: order.book_titles,
                payment_status: order.payment_status,
                delivery_eta: order.delivery_eta,
                eta_message: etaMessage,
                created_at: order.created_at,
                shipping_speed: order.shipping_speed
            }
        });
    } catch (error) {
        console.error('Order status error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch order status' });
    }
});

/**
 * GET /api/resolution-agent/last-order
 * Returns the user's most recent order
 */
router.get('/last-order', auth, async (req, res) => {
    try {
        const orders = await getUserOrders(req.user.id, { limit: 1 });
        if (!orders.length) {
            return res.json({ success: true, message: 'No orders found', order: null });
        }

        const order = orders[0];
        res.json({
            success: true,
            order: {
                id: order.id,
                mode: order.mode,
                status: order.status,
                total: order.total,
                book_titles: order.book_titles,
                payment_status: order.payment_status,
                delivery_eta: order.delivery_eta,
                created_at: order.created_at
            }
        });
    } catch (error) {
        console.error('Last order error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch last order' });
    }
});

module.exports = router;
