// create_admin.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

(async () => {
    try {
        const email = process.argv[2] || 'admin@example.com';
        const plain = process.argv[3] || 'MyNewPass123!';
        const pool = await mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'booknook',
            waitForConnections: true,
            connectionLimit: 2
        });

        const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        const hash = await bcrypt.hash(plain, 10);

        if (rows.length) {
            await pool.query('UPDATE users SET password = ?, is_admin = 1 WHERE email = ?', [hash, email]);
            console.log('✅ Updated existing user as admin:', email);
        } else {
            const [r] = await pool.query(
                'INSERT INTO users (name, email, password, is_admin, created_at) VALUES (?, ?, ?, ?, NOW())',
                ['Admin', email, hash, 1]
            );
            console.log('✅ Created new admin:', email, 'id:', r.insertId);
        }

        await pool.end();
        process.exit(0);
    } catch (e) {
        console.error('❌ Error:', e && e.message ? e.message : e);
        process.exit(1);
    }
})();
