// ============================================
// SHOPPING AGENT API - AI Shopping Assistant
// Uses Groq AI to understand user intent
// Automatically processes buy/rent/gift orders
// ============================================

const router = require('express').Router();
const https = require('https');
const pool = require('../config/database');
const auth = require('../middleware/auth');

// Groq API Config (using same as bookSearch)
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'api.groq.com';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ============================================
// GROQ API HELPER
// ============================================

async function callGroqAI(systemPrompt, userMessage) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model: GROQ_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            temperature: 0.3,
            max_tokens: 500
        });

        const options = {
            hostname: GROQ_API_URL,
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        reject(new Error(parsed.error.message || 'Groq API error'));
                        return;
                    }
                    const content = parsed.choices?.[0]?.message?.content;
                    if (!content) {
                        reject(new Error('No response from AI'));
                        return;
                    }
                    resolve(content);
                } catch (err) {
                    reject(new Error('Failed to parse AI response: ' + err.message));
                }
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// ============================================
// INTENT EXTRACTION AGENT
// ============================================

const INTENT_SYSTEM_PROMPT = `You are a Shopping Intent Analyzer. Extract user's shopping intent from their message.

Identify:
1. action: "buy" | "rent" | "gift" | "unknown"
2. book_query: The book name/title they want (clean it up, e.g., "clean code book" -> "Clean Code")
3. rental_days: Number of days for rental (ONLY 30 or 60 allowed, default 30, extract from "for X days/weeks/months")
4. delivery_speed: For buy action only - "standard" | "express" | "priority" (extract from "fast/quick delivery" = express, "urgent/same day" = priority, default = standard)
5. gift_email: Email address if gifting (extract email format)
6. confidence: 0-100 how confident you are

IMPORTANT FOR RENTAL: Only 30 or 60 days allowed. If user says "45 days" or "2 weeks" -> default to 30. If "2 months" or "90 days" -> use 60.

Examples:
- "buy clean code book" -> action: buy, book_query: "Clean Code", delivery_speed: "standard"
- "buy atomic habits with fast delivery" -> action: buy, book_query: "Atomic Habits", delivery_speed: "express"
- "rent atomic habits for 30 days" -> action: rent, book_query: "Atomic Habits", rental_days: 30
- "rent for 2 months" -> rental_days: 60
- "gift sapiens to user@example.com" -> action: gift, book_query: "Sapiens", gift_email: "user@example.com"

RESPOND ONLY WITH VALID JSON:
{
    "action": "buy|rent|gift|unknown",
    "book_query": "Book Name",
    "rental_days": 30,
    "delivery_speed": "standard|express|priority",
    "gift_email": "email@example.com or null",
    "confidence": 85
}`;

// ============================================
// BOOK MATCHING (AI-Powered Semantic Search)
// ============================================

async function findBookByQuery(bookQuery) {
    // Step 1: Try exact match first (fast path)
    const [exactMatch] = await pool.query(
        'SELECT * FROM books WHERE LOWER(title) = LOWER(?) OR LOWER(author) = LOWER(?) LIMIT 1',
        [bookQuery, bookQuery]
    );

    if (exactMatch.length > 0) {
        console.log('✓ Exact match found');
        return exactMatch[0];
    }

    // Step 2: Get candidate books using word-based SQL filter
    // Extract meaningful words (remove short words and common stop words)
    const stopWords = ['and', 'the', 'for', 'with', 'or', 'a', 'an', 'of', 'in', 'to'];
    const words = bookQuery.toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.includes(w));

    if (words.length === 0) {
        console.log('✗ No meaningful words in query');
        return null;
    }

    console.log('📝 Search words extracted:', words);

    // Build OR conditions for each word
    const conditions = words.map(() =>
        '(LOWER(title) LIKE ? OR LOWER(author) LIKE ?)'
    ).join(' OR ');

    const params = words.flatMap(word => [`%${word}%`, `%${word}%`]);

    const [candidates] = await pool.query(
        `SELECT id, title, author, price, stock, image_url FROM books 
         WHERE ${conditions}
         LIMIT 50`,
        params
    );

    console.log(`📚 Found ${candidates.length} candidate books`);

    if (candidates.length === 0) {
        return null;
    }

    // If only one candidate, return it directly
    if (candidates.length === 1) {
        console.log('✓ Single candidate found');
        const [fullBook] = await pool.query('SELECT * FROM books WHERE id = ?', [candidates[0].id]);
        return fullBook[0];
    }

    // Step 3: Use AI to find best semantic match from candidates
    const bookList = candidates.map((b, idx) =>
        `${idx + 1}. ID=${b.id}: "${b.title}" by ${b.author}`
    ).join('\n');

    const matchPrompt = `You are a book matching expert. The user is searching for a book.

User's search query: "${bookQuery}"

Candidate books from our catalog:
${bookList}

Find the book that BEST matches the user's query. Consider:
- Semantic similarity (meaning, not just exact words)
- Handle typos, extra words, missing words, word order
- "rich dad and poor dad" should match "Rich Dad Poor Dad"
- "harry potter first book" should match "Harry Potter and the Philosopher's Stone"
- "atomic habit" should match "Atomic Habits"

RESPOND ONLY WITH VALID JSON:
{
    "book_id": <number>,
    "confidence": <0-100>,
    "matched_title": "<book title>"
}

If no good match exists, use: {"book_id": null, "confidence": 0, "matched_title": null}`;

    try {
        console.log('🤖 Asking AI to find best match...');
        const aiResponse = await callGroqAI(matchPrompt, `Find the best matching book for: "${bookQuery}"`);

        // Parse AI response
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        const result = JSON.parse(jsonMatch ? jsonMatch[0] : aiResponse);

        console.log('🎯 AI Match Result:', result);

        // Require at least 50% confidence
        if (!result.book_id || result.confidence < 50) {
            console.log('✗ Low confidence or no match');
            return null;
        }

        // Fetch full book details
        const [matchedBooks] = await pool.query('SELECT * FROM books WHERE id = ?', [result.book_id]);

        if (matchedBooks.length > 0) {
            console.log(`✓ AI matched: "${matchedBooks[0].title}" (${result.confidence}% confidence)`);
            return matchedBooks[0];
        }

        return null;

    } catch (error) {
        console.error('⚠ AI matching failed:', error.message);
        // Fallback: return first candidate
        console.log('↩ Falling back to first candidate');
        const [fullBook] = await pool.query('SELECT * FROM books WHERE id = ?', [candidates[0].id]);
        return fullBook.length > 0 ? fullBook[0] : null;
    }
}

// ============================================
// PREPARE ORDER DATA (NOT CREATED YET)
// ============================================

async function prepareOrderData(userId, bookId, mode, rentalDays = null, giftEmail = null, deliverySpeed = 'standard') {
    try {
        // Get book details
        const [books] = await pool.query('SELECT * FROM books WHERE id = ?', [bookId]);
        if (!books.length) {
            throw new Error('Book not found');
        }

        const book = books[0];
        const fullPrice = Number(book.price || 0);

        // Validate rental days (only 30 or 60 allowed)
        let rentalDuration = null;
        if (mode === 'rent') {
            rentalDuration = rentalDays || 30;
            if (rentalDuration !== 30 && rentalDuration !== 60) {
                // Round to nearest valid option
                rentalDuration = rentalDuration <= 45 ? 30 : 60;
            }
        }

        // Calculate price based on mode
        let finalPrice = fullPrice;

        if (mode === 'rent') {
            finalPrice = fullPrice * (rentalDuration === 30 ? 0.35 : 0.55);
        } else if (mode === 'gift') {
            finalPrice = fullPrice;
        } // buy: keep fullPrice

        // Check stock for buy mode (but DON'T reduce it yet - will reduce on payment success)
        if (mode === 'buy') {
            if (Number(book.stock) < 1) {
                throw new Error('Book out of stock');
            }
        }

        // Calculate shipping fee and ETA based on delivery speed
        let shippingFee = 0;
        let etaDays = 0;

        if (mode === 'buy') {
            const shippingCosts = { standard: 30, express: 70, priority: 120 };
            const etaMap = { standard: 5, express: 3, priority: 1 };

            const speed = deliverySpeed || 'standard';
            shippingFee = shippingCosts[speed] || 30;
            etaDays = etaMap[speed] || 5;
        }

        const total = finalPrice + shippingFee;

        // Return prepared order data (NOT created in DB yet)
        // Order will be created when user proceeds to payment
        return {
            book: {
                id: book.id,
                title: book.title,
                author: book.author,
                image_url: book.image_url,
                price: fullPrice,
                stock: book.stock
            },
            orderData: {
                items: [{ book_id: bookId, quantity: 1 }],
                mode,
                payment_method: 'razorpay',
                rental_duration: rentalDuration,
                gift_email: giftEmail,
                shipping_speed: mode === 'buy' ? (deliverySpeed || 'standard') : null,
                notes: 'Created via AI Shopping Agent'
            },
            pricing: {
                bookPrice: fullPrice,
                finalPrice: Number(finalPrice.toFixed(2)),
                shippingFee: shippingFee,
                total: Number(total.toFixed(2)),
                rentalDays: rentalDuration,
                deliverySpeed: mode === 'buy' ? (deliverySpeed || 'standard') : null,
                etaDays: mode === 'buy' ? etaDays : null
            },
            giftEmail: giftEmail
        };

    } catch (error) {
        throw error;
    }
}

// Alternative: Keep old function for backwards compatibility
async function createOrderForUser_OLD(userId, bookId, mode, rentalDays = null, giftEmail = null) {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        // Get book details
        const [books] = await conn.query('SELECT * FROM books WHERE id = ?', [bookId]);
        if (!books.length) {
            throw new Error('Book not found');
        }

        const book = books[0];
        const fullPrice = Number(book.price || 0);

        let finalPrice = fullPrice;
        let rentalDuration = null;

        if (mode === 'rent') {
            rentalDuration = rentalDays || 30;
            finalPrice = fullPrice * (rentalDuration === 30 ? 0.35 : 0.55);
        }

        if (mode === 'buy' && Number(book.stock) < 1) {
            throw new Error('Book out of stock');
        }

        let deliveryEta = null;
        let rentalEnd = null;

        if (mode === 'buy') {
            deliveryEta = new Date();
            deliveryEta.setDate(deliveryEta.getDate() + 5);
        }

        if (mode === 'rent') {
            rentalEnd = new Date();
            rentalEnd.setDate(rentalEnd.getDate() + rentalDuration);
        }

        const initialStatus = mode === 'buy' ? 'Pending' : mode === 'rent' ? 'Active' : 'Delivered';
        const shippingSpeed = mode === 'buy' ? 'standard' : null;
        const shippingFee = mode === 'buy' ? 30 : 0;
        const total = finalPrice + shippingFee;

        const [orderResult] = await conn.query(
            `INSERT INTO orders (
                user_id, mode, total, 
                payment_method, payment_status, 
                rental_duration, rental_end, 
                gift_email, shipping_speed, 
                shipping_fee, cod_fee,
                status, delivery_eta, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [
                userId,
                mode,
                Number(total.toFixed(2)),
                'razorpay', // default payment method
                'pending', // payment pending
                rentalDuration,
                rentalEnd,
                giftEmail,
                shippingSpeed,
                shippingFee,
                0, // no COD fee for agent orders
                initialStatus,
                deliveryEta
            ]
        );

        const orderId = orderResult.insertId;

        // Insert order item
        await conn.query(
            'INSERT INTO order_items (order_id, book_id, quantity, price) VALUES (?, ?, ?, ?)',
            [orderId, bookId, 1, Number(finalPrice.toFixed(2))]
        );

        // If gift, create gift record
        if (mode === 'gift' && giftEmail) {
            const crypto = require('crypto');
            const claimToken = crypto.randomBytes(32).toString('hex');

            await conn.query(
                'INSERT INTO gifts (order_id, book_id, quantity, recipient_email, claim_token) VALUES (?, ?, ?, ?, ?)',
                [orderId, bookId, 1, giftEmail, claimToken]
            );
        }

        await conn.commit();

        return {
            orderId,
            bookId,
            bookTitle: book.title,
            mode,
            total: Number(total.toFixed(2)),
            rentalDays: rentalDuration,
            giftEmail
        };

    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

// ============================================
// MAIN SHOPPING AGENT ENDPOINT
// ============================================

/**
 * POST /api/shopping-agent/process
 * Process natural language shopping query
 * 
 * Body: { query: "buy clean code book" }
 * Returns: Order details and payment info
 */
router.post('/process', auth, async (req, res) => {
    try {
        const { query } = req.body;

        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a shopping query'
            });
        }

        console.log('\n🛒 Shopping Agent Processing:', query);
        console.log('User ID:', req.user.id);

        // STEP 1: Extract intent using AI
        console.log('\n📊 Step 1: Analyzing intent...');
        const intentResponse = await callGroqAI(INTENT_SYSTEM_PROMPT, query);

        let intent;
        try {
            // Extract JSON from response (handle markdown code blocks)
            const jsonMatch = intentResponse.match(/\{[\s\S]*\}/);
            intent = JSON.parse(jsonMatch ? jsonMatch[0] : intentResponse);
        } catch (err) {
            console.error('Failed to parse intent:', err);
            return res.status(500).json({
                success: false,
                message: 'Failed to understand your request. Please try rephrasing.'
            });
        }

        console.log('Intent extracted:', intent);

        // Validate intent
        if (!intent.action || intent.action === 'unknown' || intent.confidence < 50) {
            return res.status(400).json({
                success: false,
                message: 'Could not understand your request. Please specify if you want to buy, rent, or gift a book.',
                suggestion: 'Try: "buy [book name]", "rent [book name] for [X] days", or "gift [book name] to [email]"'
            });
        }

        if (!intent.book_query || intent.book_query.trim().length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Please specify which book you want to ' + intent.action
            });
        }

        // Validate gift email if action is gift
        if (intent.action === 'gift' && !intent.gift_email) {
            return res.status(400).json({
                success: false,
                message: 'Please provide recipient email for gifting',
                suggestion: 'Try: "gift [book name] to recipient@example.com"'
            });
        }

        // STEP 2: Find the book
        console.log('\n📚 Step 2: Searching for book:', intent.book_query);
        const book = await findBookByQuery(intent.book_query);

        if (!book) {
            return res.status(404).json({
                success: false,
                message: `Sorry, we couldn't find "${intent.book_query}" in our catalog.`,
                suggestion: 'Try browsing our catalog or searching with a different title'
            });
        }

        console.log('Book found:', book.title, 'by', book.author);

        // Check stock for buy mode
        if (intent.action === 'buy' && book.stock < 1) {
            return res.status(400).json({
                success: false,
                message: `"${book.title}" is currently out of stock. Would you like to rent it instead?`,
                book: {
                    id: book.id,
                    title: book.title,
                    author: book.author,
                    price: book.price
                }
            });
        }

        // Validate rental duration
        if (intent.action === 'rent') {
            let days = intent.rental_days || 30;
            if (days !== 30 && days !== 60) {
                days = days <= 45 ? 30 : 60;
                console.log(`Rental days adjusted from ${intent.rental_days} to ${days} (only 30/60 allowed)`);
                intent.rental_days = days;
            }
        }

        // STEP 3: Prepare order data (NOT creating order yet)
        console.log('\n💳 Step 3: Preparing order data...');
        const preparedOrder = await prepareOrderData(
            req.user.id,
            book.id,
            intent.action,
            intent.rental_days,
            intent.gift_email,
            intent.delivery_speed
        );

        console.log('Order prepared (not created yet)');

        // STEP 4: Generate friendly response
        let message = '';
        let deliveryInfo = '';

        if (intent.action === 'buy') {
            const speedNames = { standard: 'Standard', express: 'Express', priority: 'Priority' };
            const speedName = speedNames[preparedOrder.pricing.deliverySpeed] || 'Standard';
            deliveryInfo = `${speedName} delivery (₹${preparedOrder.pricing.shippingFee}, ${preparedOrder.pricing.etaDays} days)`;
            message = `Great! "${book.title}" by ${book.author} is ready for purchase with ${speedName} delivery.`;
        } else if (intent.action === 'rent') {
            message = `Perfect! "${book.title}" by ${book.author} is ready as a ${preparedOrder.pricing.rentalDays}-day rental.`;
        } else if (intent.action === 'gift') {
            message = `Wonderful! "${book.title}" by ${book.author} will be gifted to ${intent.gift_email}.`;
        }

        // Return success with prepared order data (order NOT created yet)
        return res.json({
            success: true,
            message,
            deliveryInfo,
            action: intent.action,
            book: preparedOrder.book,
            orderData: preparedOrder.orderData, // Data to create order
            pricing: preparedOrder.pricing,
            needsPayment: true,
            instructions: 'Click "Proceed to Payment" to create order and complete purchase'
        });

    } catch (error) {
        console.error('Shopping agent error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to process your request',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ============================================
// QUICK SUGGESTIONS ENDPOINT
// ============================================

/**
 * GET /api/shopping-agent/suggestions
 * Get example queries for users
 */
router.get('/suggestions', (req, res) => {
    res.json({
        suggestions: [
            "buy Clean Code book",
            "buy Atomic Habits with express delivery",
            "rent Atomic Habits for 30 days",
            "rent for 60 days",
            "gift Sapiens to friend@example.com",
            "I want to buy The Pragmatic Programmer with priority delivery"
        ],
        examples: {
            buy: "buy [book name] with [standard/express/priority] delivery",
            rent: "rent [book name] for [30 or 60] days",
            gift: "gift [book name] to [email]"
        },
        deliveryOptions: [
            { speed: 'standard', fee: 30, days: 5, label: 'Standard (5 days) - ₹30' },
            { speed: 'express', fee: 70, days: 3, label: 'Express (3 days) - ₹70' },
            { speed: 'priority', fee: 120, days: 1, label: 'Priority (1 day) - ₹120' }
        ],
        rentalOptions: [
            { days: 30, label: '30 days' },
            { days: 60, label: '60 days (2 months)' }
        ]
    });
});

module.exports = router;
