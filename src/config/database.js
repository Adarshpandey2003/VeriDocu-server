import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Supabase
  },
  max: 10, // Reduced for Supabase Session Pooler
  min: 2, // Keep minimum connections alive
  idleTimeoutMillis: 10000, // Shorter idle timeout for Supabase (10 seconds)
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: false, // Keep pool alive
  // Supabase-specific settings
  keepAlive: true, // Send TCP keepalive packets
  keepAliveInitialDelayMillis: 10000,
});

// Test connection
pool.on('connect', (client) => {
  console.log('✓ Connected to PostgreSQL database');
  // Set statement timeout to prevent long-running queries
  client.query('SET statement_timeout = 30000').catch(err => {
    console.error('Error setting statement timeout:', err);
  });
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err.message);
  // Don't exit process - let pool handle reconnection
  // Supabase connections may be terminated by the server
});

export const query = (text, params) => pool.query(text, params);

export default pool;
