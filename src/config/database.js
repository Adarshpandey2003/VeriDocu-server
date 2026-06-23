import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Supabase
  },
  max: 10,
  min: 0, // Don't keep idle connections — Supabase kills them and causes ETIMEDOUT noise
  idleTimeoutMillis: 30000, // Remove idle clients from pool before Supabase kills them (~60s)
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err.message);
  // Don't exit process - let pool handle reconnection
  // Supabase connections may be terminated by the server
});

export default pool;
