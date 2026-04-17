const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Supabase connections
});

// Helper function to convert MySQL '?' to Postgres '$1, $2...'
const convertQuery = (text) => {
    let index = 1;
    return text.replace(/\?/g, () => `$${index++}`);
};

// Wrapper to make 'pg' act exactly like 'mysql2/promise'
const dbWrapper = {
    query: async (text, params) => {
        const pgQuery = convertQuery(text);
        const result = await pool.query(pgQuery, params);
        return [result.rows, result.fields];
    },
    execute: async (text, params) => {
        const pgQuery = convertQuery(text);
        const result = await pool.query(pgQuery, params);
        return [result.rows, result.fields];
    },
    getConnection: async () => {
        const client = await pool.connect();
        return {
            query: async (text, params) => {
                const pgQuery = convertQuery(text);
                const result = await client.query(pgQuery, params);
                return [result.rows, result.fields];
            },
            execute: async (text, params) => {
                const pgQuery = convertQuery(text);
                const result = await client.query(pgQuery, params);
                return [result.rows, result.fields];
            },
            beginTransaction: () => client.query('BEGIN'),
            commit: () => client.query('COMMIT'),
            rollback: () => client.query('ROLLBACK'),
            release: () => client.release()
        };
    }
};

module.exports = dbWrapper;