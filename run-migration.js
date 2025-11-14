import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function runMigration() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Starting migration...\n');

    // Add columns to employment_history
    console.log('Adding columns to employment_history table...');
    
    await client.query(`
      ALTER TABLE employment_history 
      ADD COLUMN IF NOT EXISTS verification_type VARCHAR(20) DEFAULT 'auto'
    `);
    
    await client.query(`
      ALTER TABLE employment_history 
      ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id)
    `);
    
    await client.query(`
      ALTER TABLE employment_history 
      ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP
    `);
    
    await client.query(`
      ALTER TABLE employment_history 
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT
    `);
    
    await client.query(`
      ALTER TABLE employment_history 
      ADD COLUMN IF NOT EXISTS notes TEXT
    `);

    console.log('✅ Employment history columns added\n');

    // Add columns to companies
    console.log('Adding columns to companies table...');
    
    await client.query(`
      ALTER TABLE companies 
      ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) DEFAULT 'pending'
    `);
    
    await client.query(`
      ALTER TABLE companies 
      ADD COLUMN IF NOT EXISTS verification_type VARCHAR(20) DEFAULT 'manual'
    `);
    
    await client.query(`
      ALTER TABLE companies 
      ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id)
    `);
    
    await client.query(`
      ALTER TABLE companies 
      ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP
    `);
    
    await client.query(`
      ALTER TABLE companies 
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT
    `);

    console.log('✅ Company columns added\n');

    // Create indexes
    console.log('Creating indexes...');
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_employment_verification_status 
      ON employment_history(verification_status)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_employment_verification_type 
      ON employment_history(verification_type)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_company_verification_status 
      ON companies(verification_status)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_company_verification_type 
      ON companies(verification_type)
    `);

    console.log('✅ Indexes created\n');

    // Update existing records
    console.log('Updating existing employment records...');
    
    const empResult = await client.query(`
      UPDATE employment_history 
      SET verification_status = COALESCE(verification_status, 'pending'),
          verification_type = COALESCE(verification_type, 'auto')
      WHERE verification_status IS NULL OR verification_type IS NULL
    `);
    
    console.log(`✅ Updated ${empResult.rowCount} employment records\n`);

    console.log('Updating existing company records...');
    
    const compResult = await client.query(`
      UPDATE companies 
      SET verification_status = CASE 
            WHEN is_verified = true THEN 'verified' 
            ELSE 'pending' 
          END,
          verification_type = 'manual'
      WHERE verification_status IS NULL OR verification_type IS NULL
    `);
    
    console.log(`✅ Updated ${compResult.rowCount} company records\n`);

    console.log('🎉 Migration completed successfully!\n');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
