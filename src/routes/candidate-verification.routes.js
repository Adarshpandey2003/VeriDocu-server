import express from 'express';
import pool from '../config/database.js';
import { authorize } from '../middleware/auth.js';
import multer from 'multer';
import { supabase } from '../config/supabase.js';
import path from 'path';

const router = express.Router();

// Configure multer for memory storage (we'll upload to Supabase)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only PDF and image files (JPG, PNG) are allowed'));
    }
  }
});

// Get candidate's employment history with verification status
router.get('/employment-history', authorize('candidate'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        eh.id,
        eh.candidate_id,
        eh.position,
        eh.start_date,
        eh.end_date,
        eh.is_current,
        eh.description,
        eh.location,
        eh.verification_status,
        eh.verification_type,
        eh.document_url,
        eh.rejection_reason,
        eh.notes,
        eh.verified_at,
        eh.created_at,
        COALESCE(c.name, '') as company_name
      FROM employment_history eh
      LEFT JOIN companies c ON eh.company_id = c.id
      WHERE eh.candidate_id = $1
      ORDER BY eh.start_date DESC
    `, [req.user.id]);

    const employments = result.rows.map(row => ({
      id: row.id,
      position: row.position,
      companyName: row.company_name,
      location: row.location,
      startDate: row.start_date,
      endDate: row.end_date,
      isCurrent: row.is_current,
      description: row.description,
      verificationStatus: row.verification_status,
      verificationType: row.verification_type,
      documentUrl: row.document_url,
      rejectionReason: row.rejection_reason,
      notes: row.notes,
      verifiedAt: row.verified_at,
      createdAt: row.created_at
    }));

    res.json({ employments });
  } catch (error) {
    console.error('Error fetching employment history:', error);
    res.status(500).json({ message: 'Failed to fetch employment history' });
  }
});

// Search companies
router.get('/search-companies', authorize('candidate'), async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res.json({ companies: [] });
    }

    const result = await pool.query(`
      SELECT 
        id,
        name,
        location,
        industry,
        size,
        is_verified
      FROM companies
      WHERE 
        name ILIKE $1 OR 
        location ILIKE $1
      ORDER BY 
        is_verified DESC,
        name ASC
      LIMIT 20
    `, [`%${q}%`]);

    res.json({ companies: result.rows });
  } catch (error) {
    console.error('Error searching companies:', error);
    res.status(500).json({ message: 'Failed to search companies' });
  }
});

// Add employment with verification request
router.post('/employment-verification', authorize('candidate'), upload.single('document'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const {
      position,
      companyName,
      location,
      startDate,
      endDate,
      isCurrent,
      verificationType,
      companyId
    } = req.body;

    if (!req.file) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Verification document is required' });
    }

    // Upload to Supabase Storage
    const fileExt = path.extname(req.file.originalname);
    const fileName = `candidate-${req.user.id}-${Date.now()}${fileExt}`;
    const filePath = `verification_docs/employment-verifications/${fileName}`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('VeriBoard_bucket')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      await client.query('ROLLBACK');
      console.error('Supabase upload error:', uploadError);
      return res.status(500).json({ message: 'Failed to upload document' });
    }

    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('VeriBoard_bucket')
      .getPublicUrl(filePath);

    // Insert employment record
    const insertResult = await client.query(`
      INSERT INTO employment_history (
        candidate_id,
        company_id,
        company_name,
        position,
        location,
        start_date,
        end_date,
        is_current,
        verification_status,
        verification_type,
        document_url,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
      RETURNING *
    `, [
      req.user.id,
      companyId || null,
      companyName,
      position,
      location || null,
      startDate,
      isCurrent === 'true' ? null : endDate,
      isCurrent === 'true',
      verificationType === 'manual' ? 'pending' : 'in_review',
      verificationType || 'auto',
      publicUrl
    ]);

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Employment verification request submitted successfully',
      employment: insertResult.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding employment verification:', error);
    res.status(500).json({ message: 'Failed to submit verification request' });
  } finally {
    client.release();
  }
});

export default router;
