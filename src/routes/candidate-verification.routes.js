import express from 'express';
import pool from '../config/database.js';
import { protect, authorize } from '../middleware/auth.js';
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
router.get('/employment-history', protect, authorize('candidate'), async (req, res) => {
  try {
    // First get the candidate ID from user ID
    let candidateResult = await pool.query(
      'SELECT id FROM candidates WHERE user_id = $1',
      [req.user.id]
    );

    // Auto-create candidate profile if it doesn't exist
    if (candidateResult.rows.length === 0) {
      const createResult = await pool.query(
        'INSERT INTO candidates (user_id, created_at, updated_at) VALUES ($1, NOW(), NOW()) RETURNING id',
        [req.user.id]
      );
      candidateResult = createResult;
    }

    const candidateId = candidateResult.rows[0].id;

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
        COALESCE(c.name, eh.company_name) as company_name
      FROM employment_history eh
      LEFT JOIN companies c ON eh.company_id = c.id
      WHERE eh.candidate_id = $1
      ORDER BY eh.start_date DESC
    `, [candidateId]);

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
router.get('/search-companies', protect, authorize('candidate'), async (req, res) => {
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

// Update employment with verification document
router.post('/employment-verification/update', protect, authorize('candidate'), upload.single('document'), async (req, res) => {
  try {
    const { employmentId, verificationType, companyId } = req.body;

    if (!employmentId) {
      return res.status(400).json({ message: 'Employment ID is required' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Verification document is required' });
    }

    // Get candidate_id from user_id
    const candidateResult = await pool.query(
      'SELECT id FROM candidates WHERE user_id = $1',
      [req.user.id]
    );

    if (candidateResult.rows.length === 0) {
      return res.status(404).json({ message: 'Candidate profile not found' });
    }

    const candidateId = candidateResult.rows[0].id;

    // Verify the employment belongs to this candidate
    const employmentCheck = await pool.query(
      'SELECT id FROM employment_history WHERE id = $1 AND candidate_id = $2',
      [employmentId, candidateId]
    );

    if (employmentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Employment record not found or access denied' });
    }

    // Upload to Supabase Storage
    const fileExt = path.extname(req.file.originalname);
    const fileName = `candidate-${candidateId}-${Date.now()}${fileExt}`;
    const filePath = `verification_docs/employment-verifications/${fileName}`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('VeriBoard_bucket')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      console.error('Supabase upload error:', uploadError);
      return res.status(500).json({ message: 'Failed to upload document' });
    }

    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('VeriBoard_bucket')
      .getPublicUrl(filePath);

    // Determine verification status based on type
    const verificationStatus = verificationType === 'manual' ? 'pending' : 'in_review';

    // Update employment record
    const updateResult = await pool.query(`
      UPDATE employment_history 
      SET 
        company_id = $1,
        document_url = $2,
        verification_status = $3,
        verification_type = $4,
        updated_at = NOW()
      WHERE id = $5 AND candidate_id = $6
      RETURNING *
    `, [companyId || null, publicUrl, verificationStatus, verificationType || 'auto', employmentId, candidateId]);

    res.json({
      message: 'Verification document uploaded successfully',
      employment: updateResult.rows[0]
    });
  } catch (error) {
    console.error('Error updating employment verification:', error);
    res.status(500).json({ message: 'Failed to upload verification document' });
  }
});

// Get signed URL for employment document
router.get('/employment-document/:employmentId', protect, authorize('candidate'), async (req, res) => {
  try {
    const { employmentId } = req.params;

    // Get candidate_id from user_id
    const candidateResult = await pool.query(
      'SELECT id FROM candidates WHERE user_id = $1',
      [req.user.id]
    );

    if (candidateResult.rows.length === 0) {
      return res.status(404).json({ message: 'Candidate profile not found' });
    }

    const candidateId = candidateResult.rows[0].id;

    // Get employment document URL
    const employmentResult = await pool.query(
      'SELECT document_url FROM employment_history WHERE id = $1 AND candidate_id = $2',
      [employmentId, candidateId]
    );

    if (employmentResult.rows.length === 0 || !employmentResult.rows[0].document_url) {
      return res.status(404).json({ message: 'Document not found' });
    }

    const documentUrl = employmentResult.rows[0].document_url;

    // Extract file path from public URL
    // Format: https://xxx.supabase.co/storage/v1/object/public/VeriBoard_bucket/path/to/file.pdf
    const urlParts = documentUrl.split('/VeriBoard_bucket/');
    if (urlParts.length < 2) {
      return res.status(400).json({ message: 'Invalid document URL format' });
    }
    const filePath = urlParts[1];

    // Generate signed URL (valid for 1 hour)
    const { data, error } = await supabase.storage
      .from('VeriBoard_bucket')
      .createSignedUrl(filePath, 3600);

    if (error) {
      console.error('Error creating signed URL:', error);
      return res.status(500).json({ message: 'Failed to generate document access URL' });
    }

    res.json({ url: data.signedUrl });
  } catch (error) {
    console.error('Error getting employment document:', error);
    res.status(500).json({ message: 'Failed to retrieve document' });
  }
});

// Add employment with verification request
router.post('/employment-verification', protect, authorize('candidate'), upload.single('document'), async (req, res) => {
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

    // Get candidate ID from user ID
    const candidateResult = await client.query(
      'SELECT id FROM candidates WHERE user_id = $1',
      [req.user.id]
    );

    if (candidateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Candidate profile not found' });
    }

    const candidateId = candidateResult.rows[0].id;

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
      candidateId,
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
