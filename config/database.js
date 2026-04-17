const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Supabase connections
});

// Helper function to convert MySQL '?' to Postgres '$1, $2...'
const convertQuery = (text) => {
    let index = 1;
    let pgQuery = text.replace(/\?/g, () => `$${index++}`);
    
    // Automatically append 'RETURNING id' to INSERT statements if not present
    if (/^\s*INSERT\s+INTO/i.test(pgQuery) && !/\bRETURNING\b/i.test(pgQuery)) {
        pgQuery = pgQuery.replace(/;+\s*$/, '') + ' RETURNING id';
    }
    return pgQuery;
};

const handleResult = (result) => {
    if (result.command === 'SELECT') {
        return [result.rows, result.fields];
    }
    // For INSERT, UPDATE, DELETE, mysql2 returns an object
    const mysqlResult = {
        insertId: (result.rows && result.rows.length > 0 && result.rows[0].id) ? result.rows[0].id : null,
        affectedRows: result.rowCount,
        changedRows: result.rowCount
    };
    return [mysqlResult, result.fields];
};

const dbWrapper = {
    query: async (text, params) => {
        const pgQuery = convertQuery(text);
        const result = await pool.query(pgQuery, params);
        return handleResult(result);
    },
    execute: async (text, params) => {
        const pgQuery = convertQuery(text);
        const result = await pool.query(pgQuery, params);
        return handleResult(result);
    },
    getConnection: async () => {
        const client = await pool.connect();
        return {
            query: async (text, params) => {
                const pgQuery = convertQuery(text);
                const result = await client.query(pgQuery, params);
                return handleResult(result);
            },
            execute: async (text, params) => {
                const pgQuery = convertQuery(text);
                const result = await client.query(pgQuery, params);
                return handleResult(result);
            },
            beginTransaction: () => client.query('BEGIN'),
            commit: () => client.query('COMMIT'),
            rollback: () => client.query('ROLLBACK'),
            release: () => client.release()
        };
    }
};

module.exports = dbWrapper;
