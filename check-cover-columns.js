import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function checkColumns() {
  try {
    const result = await pool.query(`
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name IN ('candidates', 'companies') 
      AND column_name = 'cover_image_url' 
      ORDER BY table_name
    `);
    
    console.log('Cover image columns found:', result.rows.length);
    console.log(JSON.stringify(result.rows, null, 2));
    
    if (result.rows.length === 0) {
      console.log('\n⚠️  WARNING: cover_image_url column not found! Please run the migration.');
    } else {
      console.log('\n✅ cover_image_url columns exist in the database');
    }
  } catch (error) {
    console.error('Error checking columns:', error.message);
  } finally {
    await pool.end();
  }
}

checkColumns();
