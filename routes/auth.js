// backend/routes/auth.js
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const admin = require('firebase-admin');

/**
 * Register a new user
 */
router.post('/register', async (req, res) => {
    try {
        const { name, email, password, phone, bio } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ message: "Name, email, and password are required" });
        }
        if (password.length < 6) {
            return res.status(400).json({ message: "Password must be at least 6 characters long" });
        }

        const [existingUsers] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ message: "User already exists with this email" });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const [result] = await pool.query(
            'INSERT INTO users (name, email, password, phone, bio) VALUES (?, ?, ?, ?, ?)',
            [name, email, hashedPassword, phone || null, bio || null]
        );

        const payload = { userId: result.insertId };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

        return res.status(201).json({
            message: "User registered successfully",
            token,
            user: { id: result.insertId, name, email, is_admin: false }
        });

    } catch (err) {
        console.error("Error in registration:", err);
        return res.status(500).json({ message: "Server error during registration" });
    }
});

/**
 * Login user
 */
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required" });
        }

        const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const payload = { userId: user.id, isAdmin: !!user.is_admin };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

        return res.json({
            message: "Login successful",
            token,
            user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin }
        });

    } catch (err) {
        console.error("Error in login:", err);
        return res.status(500).json({ message: "Server error during login" });
    }
});

router.post('/google-login', async (req, res) => {
    const { token } = req.body;

    try {
        // 1. Verify the Firebase token
        const decodedToken = await admin.auth().verifyIdToken(token);
        const { name, email, picture } = decodedToken;

        // 2. Check if user exists in your MySQL database
        const [existingUsers] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);

        let user;
        if (existingUsers.length > 0) {
            user = existingUsers[0];
        } else {
            // User is new, create them in your database
            const [result] = await pool.query(
                'INSERT INTO users (name, email, profile_pic, password) VALUES (?, ?, ?, NULL)',
                [name, email, picture || null]
            );
            const [newUsers] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
            user = newUsers[0];
        }

        // 3. Create your own app's JWT token
        const payload = { userId: user.id, isAdmin: !!user.is_admin };
        const appToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

        // 4. Send the token and user data back to the frontend
        res.json({
            message: "Login successful",
            token: appToken,
            user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin }
        });

    } catch (error) {
        console.error("Error with Google login:", error);
        res.status(500).json({ message: 'Authentication failed' });
    }
});

module.exports = router;
