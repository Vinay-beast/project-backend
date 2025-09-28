const router = require('express').Router();
const multer = require('multer');
const bcrypt = require('bcrypt');

const auth = require('../middleware/auth');
const pool = require('../config/database');
const azureStorageService = require('../config/azureStorage');

// -----------------------------
// Multer (for memory storage - Azure upload)
// -----------------------------
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimetype);
        cb(ok ? null : new Error('Only image files are allowed'), ok);
    },
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB (increased from 2MB)
});

// Helper: save base64 data URL to Azure Blob Storage
async function saveDataUrlToAzure(dataUrl, userId) {
    try {
        // data:image/png;base64,xxxx
        const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
        if (!m) return null;

        const mimeType = m[1];
        const buffer = Buffer.from(m[2], 'base64');
        const ext = mimeType.split('/')[1] || 'png';
        const filename = `user_${userId}_${Date.now()}.${ext}`;

        // Upload to Azure Blob Storage
        const blobUrl = await azureStorageService.uploadProfilePicture(buffer, filename, mimeType);
        return blobUrl;
    } catch (error) {
        console.error('Error saving base64 image to Azure:', error);
        throw error;
    }
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

        // Add addresses
        const [addresses] = await pool.query(
            'SELECT id, recipient, street, city, state, zip, label FROM addresses WHERE user_id = ?',
            [req.user.id]
        );
        user.addresses = addresses;

        res.json(user);
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
        let oldProfilePic = null;

        // Get current profile pic for potential cleanup
        try {
            const [currentUser] = await pool.query('SELECT profile_pic FROM users WHERE id = ?', [req.user.id]);
            if (currentUser.length > 0 && currentUser[0].profile_pic) {
                oldProfilePic = currentUser[0].profile_pic;
            }
        } catch (error) {
            console.error('Error fetching current profile pic:', error);
        }

        // Priority 1: file upload via multipart
        if (req.file) {
            try {
                const filename = `user_${req.user.id}_${Date.now()}.${req.file.originalname.split('.').pop()}`;
                finalPicUrl = await azureStorageService.uploadProfilePicture(
                    req.file.buffer,
                    filename,
                    req.file.mimetype
                );
            } catch (error) {
                console.error('Failed to upload file to Azure:', error);
                return res.status(500).json({ message: 'Failed to upload profile picture' });
            }
        }
        // Priority 2: base64 data URL → store to Azure
        else if (profile_pic && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(profile_pic)) {
            try {
                finalPicUrl = await saveDataUrlToAzure(profile_pic, req.user.id);
            } catch (e) {
                console.error('Failed to save base64 image to Azure:', e);
                return res.status(400).json({ message: 'Invalid image data or upload failed' });
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

        // Clean up old Azure blob if we uploaded a new one
        if (finalPicUrl && oldProfilePic && oldProfilePic !== finalPicUrl && oldProfilePic.includes('blob.core.windows.net')) {
            try {
                await azureStorageService.deleteFile(oldProfilePic);
                console.log('Old profile picture deleted from Azure:', oldProfilePic);
            } catch (error) {
                console.error('Failed to delete old profile picture from Azure:', error);
                // Don't fail the request if cleanup fails
            }
        }

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

module.exports = router;
