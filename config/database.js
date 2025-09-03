const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,
        require: true
    },
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 5000
});

module.exports = pool;
