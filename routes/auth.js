const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');

/**
 * Register a new user
 */
router.post('/register', async (req, res) => {
    try {
        const { name, email, password, phone, bio } = req.body;

        // Validate input
        if (!name || !email || !password) {
            return res.status(400).json({ message: "Name, email, and password are required" });
        }
        if (password.length < 6) {
            return res.status(400).json({ message: "Password must be at least 6 characters long" });
        }

        // Check if user already exists
        const [existingUsers] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ message: "User already exists with this email" });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Insert new user
        const [result] = await pool.query(
            'INSERT INTO users (name, email, password, phone, bio) VALUES (?, ?, ?, ?, ?)',
            [name, email, hashedPassword, phone || null, bio || null]
        );

        // Generate JWT with expiry
        const token = jwt.sign(
            { userId: result.insertId },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        return res.status(201).json({
            message: "User registered successfully",
            token,
            user: { id: result.insertId, name, email }
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

        // Find user
        const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const user = users[0];

        // Compare password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Invalid credentials" });
        }

        // Generate JWT with expiry
        const token = jwt.sign(
            { userId: user.id },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        return res.json({
            message: "Login successful",
            token,
            user: { id: user.id, name: user.name, email: user.email }
        });

    } catch (err) {
        console.error("Error in login:", err);
        return res.status(500).json({ message: "Server error during login" });
    }
});

module.exports = router;
