import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

const { Pool } = pg;

async function runMigration() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    console.log('🔄 Connecting to database...');
    
    // Read migration file
    const migrationPath = path.join(__dirname, '../database/migrations/add_employment_verification_system.sql');
    const migrationSQL = await fs.readFile(migrationPath, 'utf-8');
    
    console.log('📝 Running migration...');
    
    // Execute migration
    await pool.query(migrationSQL);
    
    console.log('✅ Migration completed successfully!');
    console.log('\nNew columns added:');
    console.log('  employment_history:');
    console.log('    - document_url');
    console.log('    - verification_status');
    console.log('  companies:');
    console.log('    - hr_verification_status');
    console.log('    - hr_document_url');
    console.log('    - hr_verified_by');
    console.log('    - hr_verified_at');
    console.log('    - hr_rejection_reason');
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
