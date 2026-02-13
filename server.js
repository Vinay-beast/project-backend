// server.js
require('dotenv').config();
console.log("Is the JWT_SECRET loaded?", process.env.JWT_SECRET ? "Yes, it is." : "NO, IT IS MISSING!");
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const morgan = require('morgan');

const pool = require('./config/database');         // mysql2/promise pool
const auth = require('./middleware/auth');         // your JWT middleware

const admin = require('firebase-admin');

// This code reads the secret key from a Render environment variable
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// ... the rest of your server.js file

// ----------------------------------------
// Init
// ----------------------------------------
const app = express();

// ----------------------------------------
// Security & Core Middleware (order matters)
// ----------------------------------------
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// This is the only CORS code you need
app.use(cors({
    origin: process.env.FRONTEND_URL
}));

app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ----------------------------------------
// DB health
// ----------------------------------------
pool.query('SELECT 1')
    .then(() => console.log('✅ Database connected'))
    .catch(err => {
        console.error('❌ Database connection failed:', err);
        process.exit(1);
    });

// ----------------------------------------
// Health check
// ----------------------------------------
app.get('/api/health', async (req, res) => {
    try {
        const [r] = await pool.query('SELECT 1 AS ok');
        res.json({ status: 'ok', db: !!(r && r.length), timestamp: new Date().toISOString() });
    } catch (e) {
        res.status(500).json({ status: 'down', message: e.message });
    }
});

// ----------------------------------------
// Inline Addresses  (basic endpoints)
// ----------------------------------------
app.get('/api/users/addresses', auth, async (req, res, next) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, label, recipient, street, city, state, zip FROM addresses WHERE user_id=? ORDER BY id DESC',
            [req.user.id]
        );
        res.json(rows);
    } catch (e) { next(e); }
});

app.post('/api/users/addresses', auth, async (req, res, next) => {
    try {
        const { label, recipient, street, city, state, zip } = req.body || {};
        if (!label || !recipient || !street || !city || !state || !zip) {
            return res.status(400).json({ message: 'All address fields are required' });
        }
        const [r] = await pool.query(
            'INSERT INTO addresses (user_id, label, recipient, street, city, state, zip) VALUES (?,?,?,?,?,?,?)',
            [req.user.id, label, recipient, street, city, state, zip]
        );
        res.status(201).json({ id: r.insertId });
    } catch (e) { next(e); }
});

app.delete('/api/users/addresses/:id', auth, async (req, res, next) => {
    try {
        await pool.query('DELETE FROM addresses WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
        res.json({ message: 'deleted' });
    } catch (e) { next(e); }
});

// ===== PAYMENT CARDS REMOVED =====
// Razorpay handles all card storage and PCI-DSS compliance
// No need to store card details on our server

// ----------------------------------------
// Routers
// ----------------------------------------
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/books', require('./routes/books'));
app.use('/api/book-content', require('./routes/bookContent'));
app.use('/api/secure-reader', require('./routes/secureReader'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/gifts', require('./routes/gifts'));
app.use('/api/library', require('./routes/library'));
app.use('/api/wishlist', require('./routes/wishlist'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/google-books', require('./routes/googleBooks'));
app.use('/api/recommendations', require('./routes/recommendations'));

// Book Search & Indexing (Agentic AI)
app.use('/api/book-search', require('./routes/bookSearch'));
app.use('/api/indexing', require('./routes/indexing'));

// Shopping Agent (AI Shopping Assistant)
app.use('/api/shopping-agent', require('./routes/shoppingAgent'));

// ----------------------------------------
// 404 handler
// ----------------------------------------
app.use((req, res, next) => {
    res.status(404).json({ message: 'Not found' });
});

// ----------------------------------------
// Error handlers
// ----------------------------------------
app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ message: 'Invalid JSON body' });
    }
    return next(err);
});

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    const status = err.status || 500;
    res.status(status).json({ message: err.message || 'Something went wrong!' });
});

// ----------------------------------------
// Background Job: Auto-update orders & rentals
// ----------------------------------------
setInterval(async () => {
    try {
        // Deliver pending orders whose ETA passed
        await pool.query(
            "UPDATE orders SET status='Delivered' WHERE status='Pending' AND delivery_eta IS NOT NULL AND delivery_eta <= NOW()"
        );
        // Complete rentals whose due date passed
        await pool.query(
            "UPDATE orders SET status='Completed' WHERE mode='rent' AND rental_end IS NOT NULL AND rental_end <= NOW() AND status!='Completed'"
        );
    } catch (err) {
        console.error("Auto-update job failed:", err.message);
    }
}, 60 * 1000); // run every 1 min

// ----------------------------------------
// Start server
// ----------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://127.0.0.1:${PORT}`);
});
