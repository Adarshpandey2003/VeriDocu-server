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

    // Get education verification stats
    const educationStatsQuery = `
      SELECT 
        COUNT(*) as total_requests,
        COUNT(CASE WHEN verification_type = 'manual' THEN 1 END) as total_manual,
        COUNT(CASE WHEN verification_status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN verification_status = 'pending' AND verification_type = 'manual' THEN 1 END) as pending_manual,
        COUNT(CASE WHEN verification_status = 'verified' THEN 1 END) as approved,
        COUNT(CASE WHEN verification_status = 'verified' AND verification_type = 'manual' THEN 1 END) as approved_manual,
        COUNT(CASE WHEN verification_status = 'rejected' THEN 1 END) as rejected,
        COUNT(CASE WHEN verification_status = 'rejected' AND verification_type = 'manual' THEN 1 END) as rejected_manual
      FROM education_history
    `;

    const [employmentStats, companyStats, educationStats] = await Promise.all([
      pool.query(employmentStatsQuery),
      pool.query(companyStatsQuery),
      pool.query(educationStatsQuery)
    ]);

    const empStats = employmentStats.rows[0];
    const compStats = companyStats.rows[0];
    const eduStats = educationStats.rows[0];

    const stats = {
      totalRequests: (parseInt(empStats.total_requests) || 0) + (parseInt(compStats.total_companies) || 0) + (parseInt(eduStats.total_requests) || 0),
      totalManual: (parseInt(empStats.total_manual) || 0) + (parseInt(eduStats.total_manual) || 0),
      totalCompanies: parseInt(compStats.total_companies) || 0,
      pending: (parseInt(empStats.pending) || 0) + (parseInt(compStats.pending_companies) || 0) + (parseInt(eduStats.pending) || 0),
      pendingCompanies: parseInt(compStats.pending_companies) || 0,
      pendingManual: (parseInt(empStats.pending_manual) || 0) + (parseInt(eduStats.pending_manual) || 0),
      approved: (parseInt(empStats.approved) || 0) + (parseInt(compStats.approved_companies) || 0) + (parseInt(eduStats.approved) || 0),
      approvedCompanies: parseInt(compStats.approved_companies) || 0,
      approvedManual: (parseInt(empStats.approved_manual) || 0) + (parseInt(eduStats.approved_manual) || 0),
      rejected: (parseInt(empStats.rejected) || 0) + (parseInt(compStats.rejected_companies) || 0) + (parseInt(eduStats.rejected) || 0),
      rejectedCompanies: parseInt(compStats.rejected_companies) || 0,
      rejectedManual: (parseInt(empStats.rejected_manual) || 0) + (parseInt(eduStats.rejected_manual) || 0),
      // Education-specific stats
      totalEducationRequests: parseInt(eduStats.total_requests) || 0,
      pendingEducation: parseInt(eduStats.pending) || 0,
      approvedEducation: parseInt(eduStats.approved) || 0,
      rejectedEducation: parseInt(eduStats.rejected) || 0,
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
        cand.id as candidate_id,
        u.id as user_id,
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
        c.slug,
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
        candidateId: row.candidate_id,
        candidateUserId: row.user_id,
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
        slug: row.slug,
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
        eh.company_id,
        eh.position,
        eh.start_date,
        eh.end_date,
        eh.is_current,
        eh.verification_status,
        eh.verification_type,
        eh.created_at,
        cand.id as candidate_id,
        u.name as candidate_name,
        u.email as candidate_email,
        cand.avatar_url,
        comp.slug as company_slug,
        comp.logo_url as company_logo
      FROM employment_history eh
      JOIN candidates cand ON eh.candidate_id = cand.id
      JOIN users u ON cand.user_id = u.id
      LEFT JOIN companies comp ON eh.company_id = comp.id
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
            // Extract file path - handle both full URLs and relative paths
            let filePath = avatarUrl;
            const urlParts = avatarUrl.split('/VeriBoard_bucket/');
            if (urlParts.length >= 2) {
              filePath = urlParts[1];
            }
            
            const { data, error } = await createSignedUrl(BUCKET_NAME, filePath, 3600);
            if (!error && data?.signedUrl) {
              avatarUrl = data.signedUrl;
            }
          } catch (err) {
            console.error('Error generating signed URL for avatar:', err);
          }
        }

        // Generate signed URL for company logo
        let companyLogoUrl = row.company_logo;
        if (companyLogoUrl) {
          try {
            // Extract file path - handle both full URLs and relative paths
            let filePath = companyLogoUrl;
            const urlParts = companyLogoUrl.split('/VeriBoard_bucket/');
            if (urlParts.length >= 2) {
              filePath = urlParts[1];
            }
            
            const { data, error } = await createSignedUrl(BUCKET_NAME, filePath, 3600);
            if (!error && data?.signedUrl) {
              companyLogoUrl = data.signedUrl;
            }
          } catch (err) {
            console.error('Error generating signed URL for company logo:', err);
          }
        }

        return {
          id: row.id,
          candidateId: row.candidate_id,
          candidateName: row.candidate_name,
          candidateEmail: row.candidate_email,
          companyName: row.company_name,
          companySlug: row.company_slug,
          companyLogo: companyLogoUrl,
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
        c.slug,
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
          // Extract file path - handle both full URLs and relative paths
          let filePath = hrDocumentUrl;
          const urlParts = hrDocumentUrl.split('/VeriBoard_bucket/');
          if (urlParts.length >= 2) {
            filePath = urlParts[1];
          }
          
          const { data, error } = await supabase.storage
            .from('VeriBoard_bucket')
            .createSignedUrl(filePath, 3600);
          
          if (!error && data?.signedUrl) {
            hrDocumentUrl = data.signedUrl;
          }
        } catch (err) {
          console.error('Error generating signed URL for HR document:', err);
        }
      }

      if (logoUrl) {
        try {
          // Extract file path - handle both full URLs and relative paths
          let filePath = logoUrl;
          const urlParts = logoUrl.split('/VeriBoard_bucket/');
          if (urlParts.length >= 2) {
            filePath = urlParts[1];
          }
          
          const { data, error } = await createSignedUrl(BUCKET_NAME, filePath, 3600);
          if (!error && data?.signedUrl) {
            logoUrl = data.signedUrl;
          }
        } catch (err) {
          console.error('Error generating signed URL for company logo:', err);
        }
      }

      return {
        id: row.id,
        email: row.email,
        name: row.company_name || row.name,
        slug: row.slug,
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
       WHERE c.id = $1`,
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
    const { position, companyName, startDate, endDate, verificationStatus } = req.body;

    // First get the current employment record to check for changes and get candidate info
    const currentRecord = await pool.query(
      `SELECT eh.*, c.user_id as candidate_user_id, c.id as candidate_id
       FROM employment_history eh
       JOIN candidates c ON eh.candidate_id = c.id
       WHERE eh.id = $1`,
      [id]
    );

    if (currentRecord.rows.length === 0) {
      return next(new AppError('Employment record not found', 404));
    }

    const previousRecord = currentRecord.rows[0];
    const candidateUserId = previousRecord.candidate_user_id;

    const result = await pool.query(
      `UPDATE employment_history 
       SET position = $1,
           company_name = $2,
           start_date = $3,
           end_date = $4,
           verification_status = $5,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [position, companyName, startDate, endDate, verificationStatus, id]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Employment record not found', 404));
    }

    // Create notification if status changed
    const statusChanged = previousRecord.verification_status !== verificationStatus;

    if (candidateUserId && statusChanged) {
      let notificationTitle = '';
      let notificationMessage = '';
      let notificationType = 'verification_update';

      if (statusChanged) {
        const statusLabels = {
          'verified': 'Verified',
          'rejected': 'Rejected',
          'pending': 'Under Review'
        };
        notificationTitle = `Employment Verification ${statusLabels[verificationStatus] || 'Updated'}`;
        notificationMessage = `Your employment at ${companyName} as ${position} has been ${statusLabels[verificationStatus]?.toLowerCase() || 'updated'}.`;
      } else if (notesAdded) {
        notificationTitle = 'Admin Note Added to Employment';
        notificationMessage = `An admin has added a note to your employment at ${companyName} as ${position}.`;
      }

      if (notificationMessage) {
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, message, link, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [
            candidateUserId,
            notificationType,
            notificationTitle,
            notificationMessage,
            '/verifications' // Link to verifications page
          ]
        );
      }
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

    // First get the current company record to check for changes
    const currentRecord = await pool.query(
      `SELECT c.*, c.user_id
       FROM companies c
       WHERE c.id = $1`,
      [id]
    );

    if (currentRecord.rows.length === 0) {
      return next(new AppError('Company not found', 404));
    }

    const previousRecord = currentRecord.rows[0];
    const companyUserId = previousRecord.user_id;

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

    // Create notification if status changed
    const statusChanged = previousRecord.verification_status !== verificationStatus;

    if (companyUserId && statusChanged) {
      const statusLabels = {
        'verified': 'Verified',
        'rejected': 'Rejected',
        'pending': 'Under Review'
      };
      const notificationTitle = `Company Verification ${statusLabels[verificationStatus] || 'Updated'}`;
      const notificationMessage = `Your company "${name}" verification status has been ${statusLabels[verificationStatus]?.toLowerCase() || 'updated'}.`;

      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, link, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          companyUserId,
          'verification_update',
          notificationTitle,
          notificationMessage,
          '/profile/company/edit' // Link to company profile
        ]
      );
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

// @route   GET /api/admin/users
// @desc    Get all users with pagination
// @access  Admin only
router.get('/users', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, accountType, search } = req.query;
    const offset = (page - 1) * limit;

    // Build WHERE conditions
    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;

    if (accountType && accountType !== 'all') {
      whereConditions.push(`account_type = $${paramIndex}`);
      queryParams.push(accountType);
      paramIndex++;
    }

    if (search) {
      whereConditions.push(`(name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`);
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM users ${whereClause}`;
    const countResult = await pool.query(countQuery, queryParams);
    const totalUsers = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalUsers / limit);

    // Get users
    const usersQuery = `
      SELECT 
        u.id, 
        u.email, 
        u.name, 
        u.account_type, 
        u.is_verified, 
        u.created_at,
        u.updated_at,
        c.slug as company_slug
      FROM users u
      LEFT JOIN companies c ON u.id = c.user_id AND u.account_type = 'company'
      ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    
    queryParams.push(limit, offset);
    const usersResult = await pool.query(usersQuery, queryParams);

    // Get stats
    const statsQuery = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN account_type = 'candidate' THEN 1 END) as candidates,
        COUNT(CASE WHEN account_type = 'company' THEN 1 END) as companies,
        COUNT(CASE WHEN account_type = 'admin' THEN 1 END) as admins
      FROM users
    `;
    const statsResult = await pool.query(statsQuery);
    const stats = {
      total: parseInt(statsResult.rows[0].total),
      candidates: parseInt(statsResult.rows[0].candidates),
      companies: parseInt(statsResult.rows[0].companies),
      admins: parseInt(statsResult.rows[0].admins)
    };

    res.json({
      success: true,
      users: usersResult.rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalUsers,
        limit: parseInt(limit),
        hasMore: page < totalPages
      },
      stats
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/users/:id
// @desc    Get single user details
// @access  Admin only
router.get('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT 
        id, 
        email, 
        name, 
        account_type, 
        is_verified, 
        created_at,
        updated_at
      FROM users 
      WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return next(new AppError('User not found', 404));
    }

    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/admin/verifications/:type/:id/comments
// @desc    Add comment to verification
// @access  Admin only
router.post('/verifications/:type/:id/comments', async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const { comment } = req.body;

    if (!comment || !comment.trim()) {
      return next(new AppError('Comment text is required', 400));
    }

    if (!['employment', 'company', 'education'].includes(type)) {
      return next(new AppError('Invalid verification type', 400));
    }

    // Get admin details
    const userResult = await pool.query(
      'SELECT id, name, account_type FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return next(new AppError('User not found', 404));
    }

    const user = userResult.rows[0];

    // Insert comment
    const result = await pool.query(
      `INSERT INTO verification_comments 
       (verification_type, verification_id, user_id, user_name, user_role, comment_text, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [type, id, user.id, user.name || 'Admin', user.account_type, comment.trim()]
    );

    // Get candidate user ID based on verification type
    let candidateUserId = null;
    if (type === 'employment') {
      const empResult = await pool.query(
        `SELECT c.user_id 
         FROM employment_history eh
         JOIN candidates c ON eh.candidate_id = c.id
         WHERE eh.id = $1`,
        [id]
      );
      if (empResult.rows.length > 0) {
        candidateUserId = empResult.rows[0].user_id;
      }
    } else if (type === 'company') {
      const compResult = await pool.query(
        `SELECT c.user_id 
         FROM company_verifications cv
         JOIN candidates c ON cv.candidate_id = c.id
         WHERE cv.id = $1`,
        [id]
      );
      if (compResult.rows.length > 0) {
        candidateUserId = compResult.rows[0].user_id;
      }
    }

    // Create notification for candidate
    if (candidateUserId) {
      await pool.query(
        `INSERT INTO notifications 
         (user_id, type, title, message, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          candidateUserId,
          'comment_added',
          'New Comment from Admin',
          `Admin has added a comment on your ${type} verification: "${comment.trim().substring(0, 100)}${comment.trim().length > 100 ? '...' : ''}"`
        ]
      );
    }

    res.json({
      success: true,
      comment: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/verifications/:type/:id/comments
// @desc    Get comment history for verification
// @access  Admin only
router.get('/verifications/:type/:id/comments', async (req, res, next) => {
  try {
    const { type, id } = req.params;

    if (!['employment', 'company', 'education'].includes(type)) {
      return next(new AppError('Invalid verification type', 400));
    }

    const result = await pool.query(
      `SELECT 
        vc.*,
        u.email as user_email
       FROM verification_comments vc
       LEFT JOIN users u ON vc.user_id = u.id
       WHERE vc.verification_type = $1 AND vc.verification_id = $2
       ORDER BY vc.created_at ASC`,
      [type, id]
    );

    res.json({
      success: true,
      comments: result.rows
    });
  } catch (error) {
    next(error);
  }
});

// ============= EDUCATION VERIFICATION ROUTES =============

// @route   GET /api/admin/educations
// @desc    Get all education verifications for admin review
// @access  Admin only
router.get('/educations', async (req, res, next) => {
  try {
    const { status } = req.query;

    let query = `
      SELECT 
        eh.id,
        eh.candidate_id,
        eh.institution,
        eh.degree,
        eh.field_of_study,
        eh.start_date,
        eh.end_date,
        eh.is_current,
        eh.verification_status,
        eh.verification_type,
        eh.document_url,
        eh.rejection_reason,
        eh.verified_at,
        eh.created_at,
        c.id as candidate_id,
        u.id as user_id,
        u.name as candidate_name,
        u.email as candidate_email,
        u.avatar_url
      FROM education_history eh
      JOIN candidates c ON eh.candidate_id = c.id
      JOIN users u ON c.user_id = u.id
    `;

    const queryParams = [];
    if (status && status !== 'all') {
      query += ` WHERE eh.verification_status = $1`;
      queryParams.push(status);
    }

    query += ` ORDER BY eh.created_at DESC`;

    const result = await pool.query(query, queryParams);

    // Generate signed URLs for documents and avatars
    const educations = await Promise.all(result.rows.map(async (row) => {
      let documentUrl = row.document_url;
      let avatarUrl = row.avatar_url;

      // Generate signed URL for document
      if (documentUrl) {
        try {
          const urlParts = documentUrl.split('/VeriBoard_bucket/');
          let filePath = documentUrl;
          if (urlParts.length >= 2) {
            filePath = urlParts[1];
          }
          
          const { data, error } = await createSignedUrl(BUCKET_NAME, filePath, 3600);
          if (!error && data?.signedUrl) {
            documentUrl = data.signedUrl;
          }
        } catch (err) {
          console.error('Error generating signed URL for education document:', err);
        }
      }

      // Generate signed URL for avatar
      if (avatarUrl) {
        try {
          const urlParts = avatarUrl.split('/VeriBoard_bucket/');
          let filePath = avatarUrl;
          if (urlParts.length >= 2) {
            filePath = urlParts[1];
          }
          
          const { data, error } = await createSignedUrl(BUCKET_NAME, filePath, 3600);
          if (!error && data?.signedUrl) {
            avatarUrl = data.signedUrl;
          }
        } catch (err) {
          console.error('Error generating signed URL for avatar:', err);
        }
      }

      return {
        id: row.id,
        candidateId: row.candidate_id,
        candidateName: row.candidate_name,
        candidateEmail: row.candidate_email,
        institutionName: row.institution_name,
        degree: row.degree,
        fieldOfStudy: row.field_of_study,
        startDate: row.start_date,
        endDate: row.end_date,
        isCurrent: row.is_current,
        verificationStatus: row.verification_status || 'pending',
        verificationType: row.verification_type || 'manual',
        rejectionReason: row.rejection_reason,
        verifiedAt: row.verified_at,
        createdAt: row.created_at,
        documentUrl,
        avatarUrl,
      };
    }));

    res.json({
      success: true,
      educations,
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/educations/:id
// @desc    Get single education verification details
// @access  Admin only
router.get('/educations/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        eh.*,
        c.id as candidate_id,
        u.id as user_id,
        u.name as candidate_name,
        u.email as candidate_email,
        u.avatar_url
      FROM education_history eh
      JOIN candidates c ON eh.candidate_id = c.id
      JOIN users u ON c.user_id = u.id
      WHERE eh.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return next(new AppError('Education record not found', 404));
    }

    const education = result.rows[0];

    // Generate signed URL for document
    let documentUrl = education.document_url;
    if (documentUrl) {
      try {
        const urlParts = documentUrl.split('/VeriBoard_bucket/');
        let filePath = documentUrl;
        if (urlParts.length >= 2) {
          filePath = urlParts[1];
        }
        
        const { data, error } = await createSignedUrl(BUCKET_NAME, filePath, 3600);
        if (!error && data?.signedUrl) {
          documentUrl = data.signedUrl;
        }
      } catch (err) {
        console.error('Error generating signed URL:', err);
      }
    }

    res.json({
      success: true,
      education: {
        ...education,
        documentUrl
      }
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/admin/educations/:id/document
// @desc    Get education verification document with signed URL
// @access  Admin only
router.get('/educations/:id/document', async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'SELECT document_url FROM education_history WHERE id = $1',
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

// @route   PUT /api/admin/educations/:id
// @desc    Update education verification record
// @access  Admin only
router.put('/educations/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { institutionName, degree, fieldOfStudy, startDate, endDate, verificationStatus, rejectionReason } = req.body;

    // First get the current education record to check for changes and get candidate info
    const currentRecord = await pool.query(
      `SELECT eh.*, c.user_id as candidate_user_id
       FROM education_history eh
       JOIN candidates c ON eh.candidate_id = c.id
       WHERE eh.id = $1`,
      [id]
    );

    if (currentRecord.rows.length === 0) {
      return next(new AppError('Education record not found', 404));
    }

    const previousRecord = currentRecord.rows[0];
    const candidateUserId = previousRecord.candidate_user_id;
    const statusChanged = previousRecord.verification_status !== verificationStatus;

    // Update education record
    const result = await pool.query(
      `UPDATE education_history 
       SET institution_name = $1,
           degree = $2,
           field_of_study = $3,
           start_date = $4,
           end_date = $5,
           verification_status = $6,
           rejection_reason = $7,
           verified_by = $8,
           verified_at = CASE WHEN $6 = 'verified' THEN NOW() ELSE verified_at END,
           updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [institutionName, degree, fieldOfStudy, startDate, endDate, verificationStatus, rejectionReason, req.user.id, id]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Education record not found', 404));
    }

    // Create notification if status changed
    if (candidateUserId && statusChanged) {
      const statusLabels = {
        'verified': 'Verified',
        'rejected': 'Rejected',
        'pending': 'Under Review'
      };
      
      const notificationTitle = `Education Verification ${statusLabels[verificationStatus] || 'Updated'}`;
      const notificationMessage = `Your education at ${institutionName} (${degree}) has been ${statusLabels[verificationStatus]?.toLowerCase() || 'updated'}.`;

      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, link, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          candidateUserId,
          'verification_update',
          notificationTitle,
          notificationMessage,
          '/education-verifications'
        ]
      );
    }

    res.json({
      success: true,
      message: 'Education verification updated successfully',
      education: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

export default router;
