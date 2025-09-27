const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcrypt');

const auth = require('../middleware/auth');
const pool = require('../config/database');

// -----------------------------
// Multer (for file uploads)
// -----------------------------
const uploadDir = path.join(__dirname, '..', 'uploads', 'profiles');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = (file.mimetype && file.mimetype.split('/')[1]) || 'png';
        const safe = `${req.user?.id || 'u'}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        cb(null, safe);
    }
});
const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimetype);
        cb(ok ? null : new Error('Only image files are allowed'), ok);
    },
    limits: { fileSize: 2 * 1024 * 1024 } // 2MB
});

// Helper: save base64 data URL to file and return public URL
function saveDataUrlToFile(dataUrl, userId) {
    // data:image/png;base64,xxxx
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
    if (!m) return null;
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    const ext = mime.split('/')[1] || 'png';
    const filename = `${userId || 'u'}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const full = path.join(uploadDir, filename);
    fs.writeFileSync(full, buf);
    // public URL path that server.js serves: /uploads
    return `/uploads/profiles/${filename}`;
}

// -----------------------------
// Get user profile
// -----------------------------
router.get('/profile', auth, async (req, res) => {
    try {
        const [users] = await pool.query(
            'SELECT id, name, email, phone, bio, profile_pic, CASE WHEN password IS NULL THEN 0 ELSE 1 END as has_password FROM users WHERE id = ?',
            [req.user.id]
        );
        if (users.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        const user = users[0];

        const [addresses] = await pool.query(
            'SELECT id, label, recipient, street, city, state, zip FROM addresses WHERE user_id = ?',
            [req.user.id]
        );

        const [cards] = await pool.query(
            'SELECT id, card_name, CONCAT("**** **** **** ", RIGHT(card_number, 4)) AS card_number, expiry, is_default FROM payment_cards WHERE user_id = ?',
            [req.user.id]
        );

        user.addresses = addresses;
        user.cards = cards;

        return res.json(user);
    } catch (err) {
        console.error('Error fetching profile:', err);
        return res.status(500).json({ message: 'Server error while fetching profile' });
    }
});

// -----------------------------
// Update profile
// Accepts:
//  - JSON body with { name, phone, bio, profile_pic } where profile_pic
//    can be a URL or a "data:image/...;base64,..." data URL
//  - OR multipart/form-data with file field "profile_pic"
// -----------------------------
router.put('/profile', auth, upload.single('profile_pic'), async (req, res) => {
    try {
        let { name, phone, bio, profile_pic } = req.body || {};

        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Name is required' });
        }

        let finalPicUrl = null;

        // Priority 1: file upload via multipart
        if (req.file) {
            finalPicUrl = `/uploads/profiles/${req.file.filename}`;
        }
        // Priority 2: base64 data URL → store to file
        else if (profile_pic && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(profile_pic)) {
            try {
                finalPicUrl = saveDataUrlToFile(profile_pic, req.user.id);
            } catch (e) {
                console.error('Failed to save base64 image:', e);
                return res.status(400).json({ message: 'Invalid image data' });
            }
        }
        // Priority 3: plain URL (keep as-is) or empty
        else if (profile_pic && /^https?:\/\//i.test(profile_pic)) {
            finalPicUrl = profile_pic;
        } else if (profile_pic === '' || profile_pic == null) {
            // leave as null to clear if desired
            finalPicUrl = null;
        }

        // Build update fields
        const fields = ['name = ?', 'phone = ?', 'bio = ?'];
        const values = [name.trim(), phone || null, bio || null];

        if (typeof finalPicUrl !== 'undefined') {
            fields.push('profile_pic = ?');
            values.push(finalPicUrl);
        }

        values.push(req.user.id);

        await pool.query(
            `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
            values
        );

        // Respond with updated profile summary
        const [rows] = await pool.query(
            'SELECT id, name, email, phone, bio, profile_pic FROM users WHERE id = ?',
            [req.user.id]
        );
        return res.json(rows[0] || { message: 'Profile updated' });
    } catch (err) {
        console.error('Error updating profile:', err);
        return res.status(500).json({ message: 'Server error while updating profile' });
    }
});

// -----------------------------
// Change password
// Body: { oldPassword, newPassword }
// -----------------------------
router.put('/password', auth, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body || {};
        if (!oldPassword || !newPassword) {
            return res.status(400).json({ message: 'Both oldPassword and newPassword are required' });
        }
        if (String(newPassword).length < 6) {
            return res.status(400).json({ message: 'New password must be at least 6 characters' });
        }

        const [rows] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
        if (!rows.length) return res.status(404).json({ message: 'User not found' });

        const ok = await bcrypt.compare(oldPassword, rows[0].password || '');
        if (!ok) return res.status(400).json({ message: 'Old password is incorrect' });

        const hash = await bcrypt.hash(String(newPassword), 10);
        await pool.query('UPDATE users SET password = ? WHERE id = ?', [hash, req.user.id]);

        return res.json({ message: 'Password updated' });
    } catch (err) {
        console.error('Error changing password:', err);
        return res.status(500).json({ message: 'Server error while changing password' });
    }
});

// -----------------------------
// Addresses (create; list added for convenience)
// -----------------------------
router.get('/addresses', auth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, label, recipient, street, city, state, zip FROM addresses WHERE user_id = ? ORDER BY id DESC',
            [req.user.id]
        );
        res.json(rows);
    } catch (err) {
        console.error('Error listing addresses:', err);
        res.status(500).json({ message: 'Server error while fetching addresses' });
    }
});

router.post('/addresses', auth, async (req, res) => {
    try {
        const { label, recipient, street, city, state, zip } = req.body;
        if (!label || !recipient || !street || !city || !state || !zip) {
            return res.status(400).json({ message: 'All address fields are required' });
        }
        const [result] = await pool.query(
            'INSERT INTO addresses (user_id, label, recipient, street, city, state, zip) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [req.user.id, label, recipient, street, city, state, zip]
        );
        return res.status(201).json({ id: result.insertId, message: 'Address added successfully' });
    } catch (err) {
        console.error('Error adding address:', err);
        return res.status(500).json({ message: 'Server error while adding address' });
    }
});

// -----------------------------
// Cards (masked storage; never store CVV)
// -----------------------------
router.get('/cards', auth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, card_name, CONCAT("**** **** **** ", RIGHT(card_number, 4)) AS card_number, expiry, is_default FROM payment_cards WHERE user_id = ? ORDER BY is_default DESC, id DESC',
            [req.user.id]
        );
        res.json(rows);
    } catch (err) {
        console.error('Error listing cards:', err);
        res.status(500).json({ message: 'Server error while fetching cards' });
    }
});

router.post('/cards', auth, async (req, res) => {
    try {
        const { card_name, card_number, expiry, cvv, is_default } = req.body;

        if (!card_name || !card_number || !expiry || !cvv) {
            return res.status(400).json({ message: 'All card fields are required' });
        }
        if (String(cvv).length < 3 || String(cvv).length > 4) {
            return res.status(400).json({ message: 'Invalid CVV' });
        }

        // Mask number before saving (only last 4)
        const maskedCard = String(card_number).replace(/\d(?=\d{4})/g, '*');

        // ensure single default
        if (is_default) {
            await pool.query('UPDATE payment_cards SET is_default = 0 WHERE user_id = ?', [req.user.id]);
        }

        const [result] = await pool.query(
            'INSERT INTO payment_cards (user_id, card_name, card_number, expiry, is_default) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, card_name, maskedCard, expiry, is_default ? 1 : 0]
        );

        return res.status(201).json({ id: result.insertId, message: 'Card added successfully (masked)' });
    } catch (err) {
        console.error('Error adding card:', err);
        return res.status(500).json({ message: 'Server error while adding card' });
    }
});

module.exports = router;
