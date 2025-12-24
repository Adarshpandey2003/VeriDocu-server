import express from 'express';
import pool from '../config/database.js';
import { protect, authorize } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { supabase } from '../config/supabase.js';
import { BUCKET_NAME, createSignedUrl } from '../utils/supabaseStorage.js';

const router = express.Router();

// Protect all admin routes
router.use(protect);
router.use(authorize('admin'));

// @route   GET /api/admin/verifications/stats
// @desc    Get verification statistics (employment + companies)
// @access  Admin only
router.get('/verifications/stats', async (req, res, next) => {
  try {
    const { status, verificationType } = req.query;

    // Get employment verification stats
    const employmentStatsQuery = `
      SELECT 
        COUNT(*) as total_requests,
        COUNT(CASE WHEN verification_type = 'manual' THEN 1 END) as total_manual,
        COUNT(CASE WHEN verification_status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN verification_status = 'pending' AND verification_type = 'manual' THEN 1 END) as pending_manual,
        COUNT(CASE WHEN verification_status = 'verified' THEN 1 END) as approved,
        COUNT(CASE WHEN verification_status = 'verified' AND verification_type = 'manual' THEN 1 END) as approved_manual,
        COUNT(CASE WHEN verification_status = 'rejected' THEN 1 END) as rejected,
        COUNT(CASE WHEN verification_status = 'rejected' AND verification_type = 'manual' THEN 1 END) as rejected_manual
      FROM employment_history
    `;

    // Get company verification stats
    const companyStatsQuery = `
      SELECT 
        COUNT(*) as total_companies,
        COUNT(CASE WHEN verification_status = 'pending' OR verification_status IS NULL THEN 1 END) as pending_companies,
        COUNT(CASE WHEN verification_status = 'verified' OR is_verified = true THEN 1 END) as approved_companies,
        COUNT(CASE WHEN verification_status = 'rejected' THEN 1 END) as rejected_companies
      FROM companies
    `;

    const [employmentStats, companyStats] = await Promise.all([
      pool.query(employmentStatsQuery),
      pool.query(companyStatsQuery)
    ]);

    const empStats = employmentStats.rows[0];
    const compStats = companyStats.rows[0];

    const stats = {
      totalRequests: (parseInt(empStats.total_requests) || 0) + (parseInt(compStats.total_companies) || 0),
      totalManual: parseInt(empStats.total_manual) || 0,
      totalCompanies: parseInt(compStats.total_companies) || 0,
      pending: (parseInt(empStats.pending) || 0) + (parseInt(compStats.pending_companies) || 0),
      pendingCompanies: parseInt(compStats.pending_companies) || 0,
      pendingManual: parseInt(empStats.pending_manual) || 0,
      approved: (parseInt(empStats.approved) || 0) + (parseInt(compStats.approved_companies) || 0),
      approvedCompanies: parseInt(compStats.approved_companies) || 0,
      approvedManual: parseInt(empStats.approved_manual) || 0,
      rejected: (parseInt(empStats.rejected) || 0) + (parseInt(compStats.rejected_companies) || 0),
      rejectedCompanies: parseInt(compStats.rejected_companies) || 0,
      rejectedManual: parseInt(empStats.rejected_manual) || 0,
    };

    // Get employment verification list with filters
    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      whereConditions.push(`eh.verification_status = $${paramIndex}`);
      queryParams.push(status);
      paramIndex++;
    }

    if (verificationType === 'manual') {
      whereConditions.push(`eh.verification_type = 'manual'`);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const verificationsQuery = `
      SELECT 
        eh.id,
        eh.company_name,
        eh.position,
        eh.verification_status,
        eh.verification_type,
        eh.start_date,
        eh.end_date,
        eh.is_current,
        eh.created_at,
        u.name as candidate_name,
        u.email as candidate_email,
        cand.avatar_url
      FROM employment_history eh
      JOIN candidates cand ON eh.candidate_id = cand.id
      JOIN users u ON cand.user_id = u.id
      ${whereClause}
      ORDER BY eh.created_at DESC
      LIMIT 100
    `;

    const verificationsResult = await pool.query(verificationsQuery, queryParams);

    // Get company verifications with filters
    let companyWhereConditions = [];
    let companyQueryParams = [];
    let companyParamIndex = 1;

    if (status && status !== 'all') {
      companyWhereConditions.push(`c.verification_status = $${companyParamIndex}`);
      companyQueryParams.push(status);
      companyParamIndex++;
    }

    const companyWhereClause = companyWhereConditions.length > 0 ? `WHERE ${companyWhereConditions.join(' AND ')}` : '';

    const companyVerificationsQuery = `
      SELECT 
        c.id,
        c.name,
        c.logo_url,
        c.verification_status,
        c.created_at,
        u.name as admin_name,
        u.email as admin_email
      FROM companies c
      LEFT JOIN users u ON c.user_id = u.id
      ${companyWhereClause}
      ORDER BY c.created_at DESC
      LIMIT 100
    `;

    const companyVerificationsResult = await pool.query(companyVerificationsQuery, companyQueryParams);

    // Helper function to generate signed URL for images
    const getSignedImageUrl = async (imageUrl) => {
      if (!imageUrl) return null;
      try {
        // If it's already a full signed URL, return it
        if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
          return imageUrl;
        }
        
        // Extract file path from URL if it contains the bucket name
        let filePath = imageUrl;
        const urlParts = imageUrl.split('/VeriBoard_bucket/');
        if (urlParts.length >= 2) {
          filePath = urlParts[1];
        }
        
        // Generate signed URL
        const { data, error } = await createSignedUrl(BUCKET_NAME, filePath, 3600);
        if (!error && data?.signedUrl) {
          return data.signedUrl;
        }
        
        console.error('Failed to generate signed URL for:', filePath, error);
      } catch (err) {
        console.error('Error generating signed URL:', err);
      }
      return null; // Return null if signed URL generation fails
    };

    // Combine employment and company verifications with signed URLs
    const employmentVerifications = await Promise.all(
      verificationsResult.rows.map(async (row) => ({
        id: row.id,
        entityName: `${row.candidate_name} - ${row.position} at ${row.company_name}`,
        entityType: 'employment',
        type: 'employment',
        requestedBy: row.candidate_email,
        submittedAt: row.created_at,
        verificationType: row.verification_type || 'auto',
        status: row.verification_status || 'pending',
        position: row.position,
        companyName: row.company_name,
        candidateName: row.candidate_name,
        candidateEmail: row.candidate_email,
        startDate: row.start_date,
        endDate: row.end_date,
        avatarUrl: await getSignedImageUrl(row.avatar_url),
      }))
    );

    const companyVerifications = await Promise.all(
      companyVerificationsResult.rows.map(async (row) => ({
        id: row.id,
        entityName: row.name,
        entityType: 'company',
        type: 'company',
        requestedBy: row.admin_email || 'N/A',
        submittedAt: row.created_at,
        verificationType: 'manual',
        status: row.verification_status || 'pending',
        name: row.name,
        adminName: row.admin_name,
        email: row.admin_email,
        logoUrl: await getSignedImageUrl(row.logo_url),
      }))
    );

    // Combine and sort by submission date
    const allVerifications = [...employmentVerifications, ...companyVerifications]
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    res.json({
      success: true,
      stats,
      verifications: allVerifications,
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/employments
// @desc    Get all employment verifications with filters
// @access  Admin only
router.get('/employments', async (req, res, next) => {
  try {
    const { status, verificationType } = req.query;

    // Build stats query
    const statsQuery = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN verification_status = 'pending' OR verification_status IS NULL THEN 1 END) as pending,
        COUNT(CASE WHEN verification_status = 'pending' AND verification_type = 'manual' THEN 1 END) as pending_manual,
        COUNT(CASE WHEN verification_status = 'verified' THEN 1 END) as verified,
        COUNT(CASE WHEN verification_status = 'verified' AND verification_type = 'manual' THEN 1 END) as verified_manual,
        COUNT(CASE WHEN verification_status = 'rejected' THEN 1 END) as rejected,
        COUNT(CASE WHEN verification_status = 'rejected' AND verification_type = 'manual' THEN 1 END) as rejected_manual
      FROM employment_history
    `;

    const statsResult = await pool.query(statsQuery);
    const stats = {
      total: parseInt(statsResult.rows[0].total) || 0,
      pending: parseInt(statsResult.rows[0].pending) || 0,
      pendingManual: parseInt(statsResult.rows[0].pending_manual) || 0,
      verified: parseInt(statsResult.rows[0].verified) || 0,
      verifiedManual: parseInt(statsResult.rows[0].verified_manual) || 0,
      rejected: parseInt(statsResult.rows[0].rejected) || 0,
      rejectedManual: parseInt(statsResult.rows[0].rejected_manual) || 0,
    };

    // Get employment list with filters
    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      if (status === 'pending') {
        whereConditions.push(`(eh.verification_status = 'pending' OR eh.verification_status IS NULL)`);
      } else {
        whereConditions.push(`eh.verification_status = $${paramIndex}`);
        queryParams.push(status);
        paramIndex++;
      }
    }

    if (verificationType === 'manual') {
      whereConditions.push(`eh.verification_type = 'manual'`);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const employmentsQuery = `
      SELECT 
        eh.id,
        eh.company_name,
        eh.position,
        eh.start_date,
        eh.end_date,
        eh.is_current,
        eh.verification_status,
        eh.verification_type,
        eh.created_at,
        u.name as candidate_name,
        u.email as candidate_email,
        cand.avatar_url
      FROM employment_history eh
      JOIN candidates cand ON eh.candidate_id = cand.id
      JOIN users u ON cand.user_id = u.id
      ${whereClause}
      ORDER BY eh.created_at DESC
    `;

    const employmentsResult = await pool.query(employmentsQuery, queryParams);

    res.json({
      success: true,
      stats,
      employments: await Promise.all(employmentsResult.rows.map(async row => {
        let documentUrl = row.document_url;
        let avatarUrl = row.avatar_url;
        
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
            console.error('Error generating signed URL for employment document:', err);
          }
        }

        // Generate signed URL for avatar
        if (avatarUrl) {
          try {
            const urlParts = avatarUrl.split('/VeriBoard_bucket/');
            if (urlParts.length >= 2) {
              const filePath = urlParts[1];
              const { data, error } = await createSignedUrl(BUCKET_NAME, filePath, 3600);
              if (!error && data?.signedUrl) {
                avatarUrl = data.signedUrl;
              }
            }
          } catch (err) {
            console.error('Error generating signed URL for avatar:', err);
          }
        }

        return {
          id: row.id,
          candidateName: row.candidate_name,
          candidateEmail: row.candidate_email,
          companyName: row.company_name,
          position: row.position,
          startDate: row.start_date,
          endDate: row.end_date,
          isCurrent: row.is_current,
          verificationStatus: row.verification_status || 'pending',
          verificationType: row.verification_type || 'auto',
          createdAt: row.created_at,
          documentUrl,
          avatarUrl,
        };
      })),
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/employments/:id/document
// @desc    Get employment verification document with signed URL
// @access  Admin only
router.get('/employments/:id/document', async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'SELECT document_url FROM employment_history WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0 || !result.rows[0].document_url) {
      return next(new AppError('Document not found', 404));
    }

    const documentUrl = result.rows[0].document_url;
    const urlParts = documentUrl.split('/VeriBoard_bucket/');
    
    if (urlParts.length < 2) {
      return next(new AppError('Invalid document URL format', 400));
    }

    const filePath = urlParts[1];
    const { data, error } = await supabase.storage
      .from('VeriBoard_bucket')
      .createSignedUrl(filePath, 3600);

    if (error) {
      console.error('Error creating signed URL:', error);
      return next(new AppError('Failed to generate document access URL', 500));
    }

    res.json({ url: data.signedUrl });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/employments/:id/verify
// @desc    Verify an employment record
// @access  Admin only
router.post('/employments/:id/verify', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const result = await pool.query(
      `UPDATE employment_history 
       SET verification_status = 'verified', 
           verified_by = $1,
           verified_at = NOW(),
           notes = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [req.user.id, notes, id]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Employment record not found', 404));
    }

    res.json({
      success: true,
      message: 'Employment verified successfully',
      employment: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/employments/:id/reject
// @desc    Reject an employment record
// @access  Admin only
router.post('/employments/:id/reject', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const result = await pool.query(
      `UPDATE employment_history 
       SET verification_status = 'rejected',
           rejection_reason = $1,
           verified_by = $2,
           verified_at = NOW(),
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [reason, req.user.id, id]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Employment record not found', 404));
    }

    res.json({
      success: true,
      message: 'Employment rejected',
      employment: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/companies
// @desc    Get all companies with filters
// @access  Admin only
router.get('/companies', async (req, res, next) => {
  try {
    const { status } = req.query;

    // Build stats query - use companies table for verification status
    const statsQuery = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN c.verification_status = 'pending' OR c.verification_status IS NULL THEN 1 END) as pending,
        COUNT(CASE WHEN c.verification_status = 'verified' OR c.is_verified = true THEN 1 END) as verified,
        COUNT(CASE WHEN c.verification_status = 'rejected' THEN 1 END) as rejected
      FROM users u
      LEFT JOIN companies c ON u.id = c.user_id
      WHERE u.account_type = 'company'
    `;

    const statsResult = await pool.query(statsQuery);
    const stats = {
      total: parseInt(statsResult.rows[0].total) || 0,
      pending: parseInt(statsResult.rows[0].pending) || 0,
      verified: parseInt(statsResult.rows[0].verified) || 0,
      rejected: parseInt(statsResult.rows[0].rejected) || 0,
    };

    // Get companies list with filters
    let whereConditions = ['u.account_type = $1'];
    let queryParams = ['company'];
    let paramIndex = 2;

    if (status && status !== 'all') {
      if (status === 'pending') {
        whereConditions.push(`(c.verification_status = 'pending' OR c.verification_status IS NULL)`);
      } else if (status === 'verified') {
        whereConditions.push(`(c.verification_status = 'verified' OR c.is_verified = true)`);
      } else {
        whereConditions.push(`c.verification_status = $${paramIndex}`);
        queryParams.push(status);
        paramIndex++;
      }
    }

    const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

    const companiesQuery = `
      SELECT 
        u.id,
        u.email,
        u.name,
        c.verification_status,
        c.is_verified,
        c.hr_verification_status,
        c.hr_document_url,
        c.logo_url,
        u.created_at,
        c.name as company_name,
        c.industry,
        c.size as company_size,
        c.website
      FROM users u
      LEFT JOIN companies c ON u.id = c.user_id
      ${whereClause}
      ORDER BY u.created_at DESC
    `;

    const companiesResult = await pool.query(companiesQuery, queryParams);

    // Generate signed URLs for HR documents and company logos
    const companies = await Promise.all(companiesResult.rows.map(async row => {
      let hrDocumentUrl = row.hr_document_url;
      let logoUrl = row.logo_url;
      
      if (hrDocumentUrl) {
        try {
          const urlParts = hrDocumentUrl.split('/VeriBoard_bucket/');
          if (urlParts.length >= 2) {
            const filePath = urlParts[1];
            const { data, error } = await supabase.storage
              .from('VeriBoard_bucket')
              .createSignedUrl(filePath, 3600);
            
            if (!error && data?.signedUrl) {
              hrDocumentUrl = data.signedUrl;
            }
          }
        } catch (err) {
          console.error('Error generating signed URL for HR document:', err);
        }
      }

      if (logoUrl) {
        try {
          const urlParts = logoUrl.split('/VeriBoard_bucket/');
          if (urlParts.length >= 2) {
            const filePath = urlParts[1];
            const { data, error } = await createSignedUrl(BUCKET_NAME, filePath, 3600);
            if (!error && data?.signedUrl) {
              logoUrl = data.signedUrl;
            }
          }
        } catch (err) {
          console.error('Error generating signed URL for company logo:', err);
        }
      }

      return {
        id: row.id,
        email: row.email,
        name: row.company_name || row.name,
        verificationStatus: row.verification_status || 'pending',
        hrVerificationStatus: row.hr_verification_status,
        hrDocumentUrl,
        logoUrl,
        industry: row.industry,
        companySize: row.company_size,
        website: row.website,
        createdAt: row.created_at,
      };
    }));

    res.json({
      success: true,
      stats,
      companies,
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/companies/:id/document
// @desc    Get company HR verification document with signed URL
// @access  Admin only
router.get('/companies/:id/document', async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT c.hr_document_url 
       FROM companies c
       JOIN users u ON c.user_id = u.id
       WHERE u.id = $1 AND u.account_type = 'company'`,
      [id]
    );

    if (result.rows.length === 0 || !result.rows[0].hr_document_url) {
      return next(new AppError('Document not found', 404));
    }

    const documentUrl = result.rows[0].hr_document_url;
    const urlParts = documentUrl.split('/VeriBoard_bucket/');
    
    if (urlParts.length < 2) {
      return next(new AppError('Invalid document URL format', 400));
    }

    const filePath = urlParts[1];
    const { data, error } = await supabase.storage
      .from('VeriBoard_bucket')
      .createSignedUrl(filePath, 3600);

    if (error) {
      console.error('Error creating signed URL:', error);
      return next(new AppError('Failed to generate document access URL', 500));
    }

    res.json({ signedUrl: data.signedUrl });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/companies/:id/verify
// @desc    Verify a company
// @access  Admin only
router.post('/companies/:id/verify', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    // Update companies table, not users table
    const result = await pool.query(
      `UPDATE companies 
       SET verification_status = 'verified', 
           is_verified = true,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING id, name`,
      [id]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Company not found', 404));
    }

    // Also update user's is_verified flag
    await pool.query(
      `UPDATE users 
       SET is_verified = true,
           updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    res.json({
      success: true,
      message: 'Company verified successfully',
      company: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/companies/:id/reject
// @desc    Reject a company
// @access  Admin only
router.post('/companies/:id/reject', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // Update companies table, not users table
    const result = await pool.query(
      `UPDATE companies 
       SET verification_status = 'rejected',
           rejection_reason = $2,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING id, name`,
      [id, reason]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Company not found', 404));
    }

    res.json({
      success: true,
      message: 'Company rejected',
      company: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/users/:id/status
// @desc    Update user verification status
// @access  Admin only
router.put('/users/:id/status', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'verified', 'rejected'];
    if (!validStatuses.includes(status)) {
      return next(new AppError('Invalid status', 400));
    }

    const result = await pool.query(
      `UPDATE users 
       SET verification_status = $1,
           is_verified = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, email, name, account_type, verification_status`,
      [status, status === 'verified', id]
    );

    if (result.rows.length === 0) {
      return next(new AppError('User not found', 404));
    }

    res.json({
      success: true,
      message: 'User status updated successfully',
      user: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/employments/:id
// @desc    Update employment verification details
// @access  Admin only
router.put('/employments/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { position, companyName, startDate, endDate, verificationStatus, adminNotes } = req.body;

    const result = await pool.query(
      `UPDATE employment_history 
       SET position = $1,
           company_name = $2,
           start_date = $3,
           end_date = $4,
           verification_status = $5,
           notes = $6,
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [position, companyName, startDate, endDate, verificationStatus, adminNotes, id]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Employment record not found', 404));
    }

    res.json({
      success: true,
      message: 'Employment verification updated successfully',
      employment: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/admin/companies/:id
// @desc    Update company verification details
// @access  Admin only
router.put('/companies/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, industry, location, verificationStatus } = req.body;

    const result = await pool.query(
      `UPDATE companies 
       SET name = $1,
           industry = $2,
           location = $3,
           verification_status = $4,
           is_verified = $5,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [name, industry, location, verificationStatus, verificationStatus === 'verified', id]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Company not found', 404));
    }

    res.json({
      success: true,
      message: 'Company verification updated successfully',
      company: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

export default router;
