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

// Upload HR verification document
router.post('/hr-verification', protect, authorize('company'), upload.single('document'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    if (!req.file) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Document is required' });
    }

    // Get company ID from companies table
    const companyResult = await client.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (!companyResult.rows[0]?.id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Company not found' });
    }

    const companyId = companyResult.rows[0].id;

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
        verification_status = 'pending',
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
router.get('/verification-requests', protect, authorize('company'), async (req, res) => {
  try {
    // Get company ID from companies table
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (!companyResult.rows[0]?.id) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const companyId = companyResult.rows[0].id;

    // Check if HR is verified (for info only, don't block access)
    const hrStatusResult = await pool.query(
      'SELECT verification_status FROM companies WHERE id = $1',
      [companyId]
    );

    const hrVerified = hrStatusResult.rows[0]?.verification_status === 'verified';

    const { status } = req.query;

    // Get company name to match against employment records
    const companyNameResult = await pool.query(
      'SELECT name FROM companies WHERE id = $1',
      [companyId]
    );

    const companyName = companyNameResult.rows[0]?.name;

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
        u.email as "candidateEmail",
        c.user_id as candidate_user_id
      FROM employment_history eh
      JOIN candidates c ON eh.candidate_id = c.id
      JOIN users u ON c.user_id = u.id
      WHERE (eh.company_id = $1 OR LOWER(eh.company_name) = LOWER($2))
    `;

    const params = [companyId, companyName];
    let paramIndex = 3;

    if (status && status !== 'all') {
      query += ` AND eh.verification_status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    query += ` ORDER BY eh.created_at DESC`;

    const result = await pool.query(query, params);

    const requests = await Promise.all(result.rows.map(async row => {
      let documentUrl = row.document_url;
      
      // Generate signed URL if document exists
      if (documentUrl) {
        try {
          const urlParts = documentUrl.split('/VeriBoard_bucket/');
          if (urlParts.length >= 2) {
            const filePath = urlParts[1];
            const { data, error } = await supabase.storage
              .from('VeriBoard_bucket')
              .createSignedUrl(filePath, 3600);
            
            if (!error && data?.signedUrl) {
              documentUrl = data.signedUrl;
            }
          }
        } catch (err) {
          console.error('Error generating signed URL:', err);
        }
      }

      return {
        id: row.id,
        candidateName: row.candidateName,
        candidateEmail: row.candidateEmail,
        position: row.position,
        startDate: row.start_date,
        endDate: row.end_date,
        isCurrent: row.is_current,
        location: row.location,
        verificationStatus: row.verification_status,
        documentUrl,
        rejectionReason: row.rejection_reason,
        createdAt: row.created_at
      };
    }));

    res.json({ 
      requests,
      hrVerified,
      warning: hrVerified ? null : 'Your HR account is not verified. Please complete HR verification to approve/reject requests.'
    });
  } catch (error) {
    console.error('Error fetching verification requests:', error);
    res.status(500).json({ message: 'Failed to fetch verification requests' });
  }
});

// Approve verification request
router.post('/verification-requests/:id/approve', protect, authorize('company'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { notes } = req.body;

    // Get company ID from companies table
    const companyResult = await client.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (!companyResult.rows[0]?.id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Company not found' });
    }

    const companyId = companyResult.rows[0].id;

    // Get company name for matching
    const companyNameResult = await client.query(
      'SELECT name FROM companies WHERE id = $1',
      [companyId]
    );
    const companyName = companyNameResult.rows[0]?.name;

    // Verify the employment belongs to this company (by ID or name)
    const employmentCheck = await client.query(
      'SELECT id FROM employment_history WHERE id = $1 AND (company_id = $2 OR LOWER(company_name) = LOWER($3))',
      [id, companyId, companyName]
    );

    if (employmentCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Employment record not found or does not belong to your company' });
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
router.post('/verification-requests/:id/reject', protect, authorize('company'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Rejection reason is required' });
    }

    // Get company ID from companies table
    const companyResult = await client.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (!companyResult.rows[0]?.id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Company not found' });
    }

    const companyId = companyResult.rows[0].id;

    // Get company name for matching
    const companyNameResult = await client.query(
      'SELECT name FROM companies WHERE id = $1',
      [companyId]
    );
    const companyName = companyNameResult.rows[0]?.name;

    // Verify the employment belongs to this company (by ID or name)
    const employmentCheck = await client.query(
      'SELECT id FROM employment_history WHERE id = $1 AND (company_id = $2 OR LOWER(company_name) = LOWER($3))',
      [id, companyId, companyName]
    );

    if (employmentCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Employment record not found or does not belong to your company' });
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
