import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres.rkfvqsdklbzfozfgizmk:1229141198%40Ap@aws-1-eu-west-1.pooler.supabase.com:5432/postgres',
  ssl: {
    rejectUnauthorized: false
  }
});

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('Starting migration: Add verification comments table...');
    
    // Read the migration file
    const migrationPath = join(__dirname, '..', 'database', 'migrations', 'add_verification_comments.sql');
    const migrationSQL = readFileSync(migrationPath, 'utf8');
    
    // Run the migration
    await client.query('BEGIN');
    await client.query(migrationSQL);
    await client.query('COMMIT');
    
    console.log('✅ Migration completed successfully!');
    console.log('   - verification_comments table created');
    console.log('   - Indexes added for better query performance');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(console.error);
