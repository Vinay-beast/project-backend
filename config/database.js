// config/database.js - AFTER (Use this code)
const mysql = require('mysql2/promise');

// This single line connects using the URL provided by Render.
// It's simpler and more secure for production.
const pool = mysql.createPool({
    uri: process.env.DATABASE_URL,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;