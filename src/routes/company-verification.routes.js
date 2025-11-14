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

// Upload HR verification document
router.post('/hr-verification', authorize('company'), upload.single('document'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    if (!req.file) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Document is required' });
    }

    // Get company ID from user
    const companyResult = await client.query(
      'SELECT company_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!companyResult.rows[0]?.company_id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Company not found' });
    }

    const companyId = companyResult.rows[0].company_id;

    // Upload to Supabase Storage
    const fileExt = path.extname(req.file.originalname);
    const fileName = `company-${companyId}-hr-${Date.now()}${fileExt}`;
    const filePath = `verification_docs/hr-verifications/${fileName}`;

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

    // Update company with HR document
    await client.query(`
      UPDATE companies
      SET 
        hr_document_url = $1,
        hr_verification_status = 'pending',
        updated_at = NOW()
      WHERE id = $2
    `, [publicUrl, companyId]);

    await client.query('COMMIT');

    res.json({
      message: 'HR verification document uploaded successfully. Pending admin review.',
      documentUrl: publicUrl
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error uploading HR document:', error);
    res.status(500).json({ message: 'Failed to upload verification document' });
  } finally {
    client.release();
  }
});

// Get verification requests for the company
router.get('/verification-requests', authorize('company'), async (req, res) => {
  try {
    // Get company ID
    const companyResult = await pool.query(
      'SELECT company_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!companyResult.rows[0]?.company_id) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const companyId = companyResult.rows[0].company_id;

    // Check if HR is verified
    const hrStatusResult = await pool.query(
      'SELECT hr_verification_status FROM companies WHERE id = $1',
      [companyId]
    );

    if (hrStatusResult.rows[0]?.hr_verification_status !== 'verified') {
      return res.status(403).json({ 
        message: 'Your HR account must be verified before you can access verification requests' 
      });
    }

    const { status } = req.query;

    let query = `
      SELECT 
        eh.id,
        eh.position,
        eh.start_date,
        eh.end_date,
        eh.is_current,
        eh.location,
        eh.verification_status,
        eh.document_url,
        eh.rejection_reason,
        eh.created_at,
        u.name as "candidateName",
        u.email as "candidateEmail"
      FROM employment_history eh
      JOIN users u ON eh.candidate_id = u.id
      WHERE eh.company_id = $1
    `;

    const params = [companyId];

    if (status && status !== 'all') {
      query += ` AND eh.verification_status = $2`;
      params.push(status);
    }

    query += ` ORDER BY eh.created_at DESC`;

    const result = await pool.query(query, params);

    const requests = result.rows.map(row => ({
      id: row.id,
      candidateName: row.candidateName,
      candidateEmail: row.candidateEmail,
      position: row.position,
      startDate: row.start_date,
      endDate: row.end_date,
      isCurrent: row.is_current,
      location: row.location,
      verificationStatus: row.verification_status,
      documentUrl: row.document_url,
      rejectionReason: row.rejection_reason,
      createdAt: row.created_at
    }));

    res.json({ requests });
  } catch (error) {
    console.error('Error fetching verification requests:', error);
    res.status(500).json({ message: 'Failed to fetch verification requests' });
  }
});

// Approve verification request
router.post('/verification-requests/:id/approve', authorize('company'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { notes } = req.body;

    // Get company ID
    const companyResult = await client.query(
      'SELECT company_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!companyResult.rows[0]?.company_id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Company not found' });
    }

    const companyId = companyResult.rows[0].company_id;

    // Verify the employment belongs to this company
    const employmentCheck = await client.query(
      'SELECT id FROM employment_history WHERE id = $1 AND company_id = $2',
      [id, companyId]
    );

    if (employmentCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Employment record not found' });
    }

    // Update verification status
    await client.query(`
      UPDATE employment_history
      SET 
        verification_status = 'verified',
        verified_by = $1,
        verified_at = NOW(),
        notes = $2,
        updated_at = NOW()
      WHERE id = $3
    `, [req.user.id, notes || null, id]);

    await client.query('COMMIT');

    res.json({ message: 'Employment verified successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error approving verification:', error);
    res.status(500).json({ message: 'Failed to approve verification' });
  } finally {
    client.release();
  }
});

// Reject verification request
router.post('/verification-requests/:id/reject', authorize('company'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Rejection reason is required' });
    }

    // Get company ID
    const companyResult = await client.query(
      'SELECT company_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!companyResult.rows[0]?.company_id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Company not found' });
    }

    const companyId = companyResult.rows[0].company_id;

    // Verify the employment belongs to this company
    const employmentCheck = await client.query(
      'SELECT id FROM employment_history WHERE id = $1 AND company_id = $2',
      [id, companyId]
    );

    if (employmentCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Employment record not found' });
    }

    // Update verification status
    await client.query(`
      UPDATE employment_history
      SET 
        verification_status = 'rejected',
        verified_by = $1,
        verified_at = NOW(),
        rejection_reason = $2,
        updated_at = NOW()
      WHERE id = $3
    `, [req.user.id, reason, id]);

    await client.query('COMMIT');

    res.json({ message: 'Verification request rejected' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error rejecting verification:', error);
    res.status(500).json({ message: 'Failed to reject verification' });
  } finally {
    client.release();
  }
});

export default router;
