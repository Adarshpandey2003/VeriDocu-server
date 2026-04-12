/**
 * Seed script — creates/resets tester accounts directly in the DB.
 * These accounts bypass OTP registration and are always is_verified = true.
 *
 * Usage: npm run db:seed  (from server/)
 */

import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });
dotenv.config({ path: resolve(__dirname, '../../.env.local') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const TESTERS = [
  {
    email: 'tester@veriboard.in',
    password: '12345678',
    name: 'Tester',
    account_type: 'candidate',
  },
];

async function detectPasswordColumn(client) {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'users'
       AND column_name IN ('password_hash', 'password')
     LIMIT 1`
  );
  return res.rows[0]?.column_name || 'password_hash';
}

async function upsertTester({ email, password, name, account_type }, client) {
  const hash = await bcrypt.hash(password, 10);
  const pwCol = await detectPasswordColumn(client);

  // Upsert user
  const userRes = await client.query(
    `INSERT INTO users (email, ${pwCol}, name, account_type, is_verified, created_at)
     VALUES ($1, $2, $3, $4, true, NOW())
     ON CONFLICT (email)
     DO UPDATE SET ${pwCol} = $2, is_verified = true, name = $3
     RETURNING id, account_type`,
    [email, hash, name, account_type]
  );

  const user = userRes.rows[0];

  if (user.account_type === 'candidate') {
    const exists = await client.query('SELECT 1 FROM candidates WHERE user_id = $1', [user.id]);
    if (exists.rowCount === 0) {
      await client.query(
        `INSERT INTO candidates (user_id, full_name, created_at) VALUES ($1, $2, NOW())`,
        [user.id, name]
      );
    }
  } else if (user.account_type === 'company') {
    const exists = await client.query('SELECT 1 FROM companies WHERE user_id = $1', [user.id]);
    if (exists.rowCount === 0) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      await client.query(
        `INSERT INTO companies (user_id, name, slug, created_at) VALUES ($1, $2, $3, NOW())`,
        [user.id, name, slug]
      );
    }
  }

  return user.id;
}

async function run() {
  const client = await pool.connect();
  try {
    for (const tester of TESTERS) {
      const id = await upsertTester(tester, client);
      console.log(`✓ Tester upserted: ${tester.email}  [${tester.account_type}]  id=${id}`);
    }
    console.log('\nDone. Log in with:');
    TESTERS.forEach(t => console.log(`  email: ${t.email}  password: ${t.password}`));
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
