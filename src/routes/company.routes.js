import express from 'express';
import { protect } from '../middleware/auth.js';
import pool from '../config/database.js';
import { AppError } from '../middleware/errorHandler.js';
import multer from 'multer';
import { uploadProfilePicture, getProfilePictureSignedUrl, uploadCompanyLogo, createSignedUrl } from '../utils/supabaseStorage.js';

const BUCKET_NAME = 'VeriBoard_bucket';

const router = express.Router();

// Configure multer for memory storage (files stored in memory as Buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new AppError('Only image files are allowed', 400), false);
    }
  },
});

// @route   GET /api/companies/profile
// @desc    Get current company's profile
// @access  Private (Company only)
router.get('/profile', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Access denied. Companies only.', 403));
    }

    // Helper function to generate signed URLs for images
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
      return null;
    };

    let result = await pool.query(
      `SELECT c.*, u.email,
              c.verification_status as "hrVerificationStatus",
              c.hr_document_url as "hrDocumentUrl",
              c.rejection_reason as "hrRejectionReason"
       FROM companies c
       JOIN users u ON c.user_id = u.id
       WHERE c.user_id = $1`,
      [req.user.id]
    );

    // Auto-create company profile if it doesn't exist
    if (result.rows.length === 0) {
      // Derive a sensible default name/slug from available user data
      const defaultName = (req.user.username || req.user.email || 'company').toString();
      const slug = defaultName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      await pool.query(
        `INSERT INTO companies (name, slug, user_id, created_at) 
         VALUES ($1, $2, $3, NOW())`,
        [defaultName, slug, req.user.id]
      );
      
      // Fetch the newly created profile
      result = await pool.query(
        `SELECT c.*, u.email,
                c.verification_status as "hrVerificationStatus",
                c.hr_document_url as "hrDocumentUrl",
                c.rejection_reason as "hrRejectionReason"
         FROM companies c
         JOIN users u ON c.user_id = u.id
         WHERE c.user_id = $1`,
        [req.user.id]
      );
    }

    const profile = result.rows[0];
    
    // Generate signed URLs for logo and cover image
    if (profile.logo_url) {
      profile.logo_url = await getSignedImageUrl(profile.logo_url);
    }
    if (profile.cover_image_url) {
      profile.cover_image_url = await getSignedImageUrl(profile.cover_image_url);
    }

    res.json({
      success: true,
      profile
    });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/companies/profile
// @desc    Update current company's profile
// @access  Private (Company only)
router.put('/profile', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Access denied. Companies only.', 403));
    }

    const { name, description, industry, size, website, location, logo_url, cover_image_url } = req.body;

    // Incoming profile update received; lengths are intentionally not logged in production

    // If client attempted to send a base64 data URL, reject and instruct to use the upload endpoint
    if (logo_url && typeof logo_url === 'string' && logo_url.trim().startsWith('data:')) {
      console.warn('Client attempted to send base64 payload for logo_url; rejecting request');
      return next(new AppError('Please upload images using the /companies/profile/logo endpoint; do not send base64 in the profile body', 400));
    }

    // Validate and truncate fields to fit database limits
    const validatedData = {
      name: name ? name.substring(0, 255) : name,
      description: description, // TEXT field, no limit
      industry: industry ? industry.substring(0, 100) : industry,
      size: size ? size.substring(0, 50) : size,
      website: website ? website.substring(0, 255) : website,
      location: location ? location.substring(0, 255) : location,
      logo_url: logo_url ? logo_url.substring(0, 500) : logo_url,
      cover_image_url: cover_image_url ? cover_image_url.substring(0, 500) : cover_image_url
    };

    // Ensure logo_url contains only the path, not a full URL
    if (validatedData.logo_url && validatedData.logo_url.includes('http')) {
      // If logo_url contains a URL, treat as invalid for profile updates and reset
      validatedData.logo_url = null; // Reset to null if it's a URL
    }

    // Final validation - ensure logo_url is a valid path format
    if (validatedData.logo_url && !validatedData.logo_url.startsWith('company_logo/') && !validatedData.logo_url.startsWith('profile_pic/')) {
      // Invalid format for logo path; reset to avoid storing unexpected values
      validatedData.logo_url = null;
    }

    // Generate slug from name if name is provided
    let slug = null;
    if (validatedData.name) {
      slug = validatedData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    const result = await pool.query(
      `UPDATE companies 
       SET name = COALESCE($2, name),
           slug = COALESCE($3, slug),
           description = COALESCE($4, description),
           industry = COALESCE($5, industry),
           size = COALESCE($6, size),
           website = COALESCE($7, website),
           location = COALESCE($8, location),
           logo_url = COALESCE($9, logo_url),
           cover_image_url = COALESCE($10, cover_image_url),
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [req.user.id, validatedData.name, slug, validatedData.description, validatedData.industry, validatedData.size, validatedData.website, validatedData.location, validatedData.logo_url, validatedData.cover_image_url]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Company profile not found', 404));
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      profile: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/companies/search
// @desc    Search companies by name (for autocomplete)
// @access  Public
router.get('/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.json({
        success: true,
        companies: []
      });
    }

    const result = await pool.query(
      `SELECT id, name, slug, location, industry, logo_url, is_verified 
       FROM companies 
       WHERE name ILIKE $1 
       ORDER BY is_verified DESC, name ASC 
       LIMIT 10`,
      [`%${q.trim()}%`]
    );

    res.json({
      success: true,
      companies: result.rows
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/companies
// @desc    Get all companies
// @access  Public
router.get('/', async (req, res, next) => {
  try {
    const { search, industry, limit = 20, offset = 0 } = req.query;
    
    let query = `SELECT id, name, slug, description, industry, size, location, logo_url, is_verified 
                 FROM companies WHERE 1=1`;
    const params = [];
    let paramIndex = 1;

    if (search) {
      query += ` AND (name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (industry) {
      query += ` AND industry = $${paramIndex}`;
      params.push(industry);
      paramIndex++;
    }

    query += ` ORDER BY is_verified DESC, name ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      companies: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/companies/:slug
// @desc    Get company profile by slug
// @access  Public
router.get('/:slug', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.*, 
              c.verification_status as "verificationStatus",
              (SELECT COUNT(*) FROM jobs WHERE company_id = c.id AND is_active = true) as active_jobs
       FROM companies c
       WHERE c.slug = $1`,
      [req.params.slug]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Company not found', 404));
    }

    const companyRow = result.rows[0];

    // If logo_url is a storage path, try to convert it to a signed URL for client consumption
    try {
      if (companyRow.logo_url) {
        const { data, error } = await getProfilePictureSignedUrl(companyRow.logo_url, 3600);
        if (!error && data?.signedUrl) {
          // Provide a convenient field that contains the signed URL
          companyRow.companyLogo = data.signedUrl;
        } else {
          // Fall back to returning the original path in logo_url
          companyRow.companyLogo = companyRow.logo_url;
        }
      }
    } catch (err) {
      console.warn('Failed to generate signed URL for company logo:', err);
      companyRow.companyLogo = companyRow.logo_url || null;
    }

    res.json({
      success: true,
      company: companyRow
    });
  } catch (error) {
    next(error);
  }
});


// @route   POST /api/companies/profile/logo
// @desc    Upload company logo
// @access  Private (Company only)
router.post('/profile/logo', protect, upload.single('logo'), async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Access denied. Companies only.', 403));
    }

    if (!req.file) {
      return next(new AppError('No file uploaded', 400));
    }

    const userId = req.user.id;
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;

    // Server-side size check to avoid sending oversized files to Supabase
    const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(5 * 1024 * 1024), 10);
    const reportedSize = typeof req.file.size === 'number' ? req.file.size : null;
    const bufferLength = fileBuffer ? Buffer.byteLength(fileBuffer) : null;

  // Company logo upload attempt received (sizes not logged in production)

    if (reportedSize && reportedSize > MAX_UPLOAD_BYTES) {
      console.warn(`Rejected upload for user ${userId}: file size ${reportedSize} > ${MAX_UPLOAD_BYTES}`);
      return next(new AppError(`File too large. Maximum allowed size is ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`, 413));
    }
    if (bufferLength && bufferLength > MAX_UPLOAD_BYTES) {
      console.warn(`Rejected upload for user ${userId}: buffer length ${bufferLength} > ${MAX_UPLOAD_BYTES}`);
      return next(new AppError(`File too large. Maximum allowed size is ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`, 413));
    }

    // Upload to Supabase storage
    try {
      const { data, error, path } = await uploadCompanyLogo(userId, fileBuffer, fileName);

      if (error) {
        // Handle Supabase storage errors gracefully
        console.error('Supabase upload error:', error);
        const statusMsg = error?.statusCode || error?.status || 500;
        return next(new AppError(`Failed to upload image (storage error ${statusMsg})`, 500));
      }

      // Update company profile with the new logo path
      await pool.query(
        'UPDATE companies SET logo_url = $1, updated_at = NOW() WHERE user_id = $2',
        [path, userId]
      );

      res.json({
        success: true,
        message: 'Company logo uploaded successfully',
        logo_path: path
      });
      return;
    } catch (uploadErr) {
      console.error('Supabase upload exception:', uploadErr);
      // If it's a storage-js error with statusCode 413 or similar, surface a clear message
      if (uploadErr && uploadErr.__isStorageError && (uploadErr.statusCode === '413' || uploadErr.status === 413)) {
        return next(new AppError('File too large for storage backend', 413));
      }
      return next(new AppError('Failed to upload image', 500));
    }

    // Update company profile with the new logo path
    await pool.query(
      'UPDATE companies SET logo_url = $1, updated_at = NOW() WHERE user_id = $2',
      [path, userId]
    );

    res.json({
      success: true,
      message: 'Company logo uploaded successfully',
      logo_path: path
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/companies/profile/logo-url
// @desc    Get signed URL for current company's logo
// @access  Private (Company only)
router.get('/profile/logo-url', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Access denied. Companies only.', 403));
    }

    // Get the logo path from database
    const result = await pool.query(
      'SELECT logo_url FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0 || !result.rows[0].logo_url) {
      return next(new AppError('No company logo found', 404));
    }

    const logoPath = result.rows[0].logo_url;

    // Generate signed URL
    const { data, error } = await getProfilePictureSignedUrl(logoPath);

    if (error) {
      console.error('Signed URL error:', error);
      return next(new AppError('Failed to generate access URL', 500));
    }

    res.json({
      success: true,
      signedUrl: data.signedUrl
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/companies/profile/cover-image
// @desc    Upload cover image for current company
// @access  Private (Company only)
router.post('/profile/cover-image', protect, upload.single('cover_image'), async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Access denied. Companies only.', 403));
    }

    if (!req.file) {
      return next(new AppError('Please upload a cover image', 400));
    }

    const userId = req.user.id;
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;

    // Upload to storage
    const { data, error, path } = await uploadProfilePicture(userId, fileBuffer, fileName);

    if (error) {
      console.error('Storage upload error:', error);
      return next(new AppError('Failed to upload cover image', 500));
    }

    // Update database with storage path
    await pool.query(
      'UPDATE companies SET cover_image_url = $1, updated_at = NOW() WHERE user_id = $2',
      [path, userId]
    );

    res.json({
      success: true,
      message: 'Cover image uploaded successfully',
      cover_image_path: path
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/companies/profile/cover-image-url
// @desc    Get signed URL for current company's cover image
// @access  Private (Company only)
router.get('/profile/cover-image-url', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Access denied. Companies only.', 403));
    }

    // Get the cover image path from database
    const result = await pool.query(
      'SELECT cover_image_url FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0 || !result.rows[0].cover_image_url) {
      return next(new AppError('No cover image found', 404));
    }

    const coverImagePath = result.rows[0].cover_image_url;

    // Generate signed URL
    const { data, error } = await getProfilePictureSignedUrl(coverImagePath);

    if (error) {
      console.error('Signed URL error:', error);
      return next(new AppError('Failed to generate access URL', 500));
    }

    res.json({
      success: true,
      signedUrl: data.signedUrl
    });
  } catch (error) {
    next(error);
  }
});

// ====== BRANCH MANAGEMENT ROUTES ======

// @route   GET /api/companies/profile/branches
// @desc    Get all branches for current company
// @access  Private (Company only)
router.get('/profile/branches', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Access denied. Companies only.', 403));
    }

    // Get company ID
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (companyResult.rows.length === 0) {
      return next(new AppError('Company profile not found', 404));
    }

    const companyId = companyResult.rows[0].id;

    // Get all branches
    const branchesResult = await pool.query(
      `SELECT * FROM company_branches 
       WHERE company_id = $1 
       ORDER BY is_headquarters DESC, created_at ASC`,
      [companyId]
    );

    res.json({
      success: true,
      branches: branchesResult.rows
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/companies/profile/branches
// @desc    Add a new branch for current company
// @access  Private (Company only)
router.post('/profile/branches', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Access denied. Companies only.', 403));
    }

    const { name, address, city, state, country, postal_code, phone, email, is_headquarters } = req.body;

    if (!name || !address || !city || !country) {
      return next(new AppError('Name, address, city, and country are required', 400));
    }

    // Get company ID
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (companyResult.rows.length === 0) {
      return next(new AppError('Company profile not found', 404));
    }

    const companyId = companyResult.rows[0].id;

    // If this is being set as headquarters, unset other headquarters
    if (is_headquarters) {
      await pool.query(
        'UPDATE company_branches SET is_headquarters = FALSE WHERE company_id = $1',
        [companyId]
      );
    }

    // Insert new branch
    const result = await pool.query(
      `INSERT INTO company_branches 
       (company_id, name, address, city, state, country, postal_code, phone, email, is_headquarters, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       RETURNING *`,
      [companyId, name, address, city, state, country, postal_code, phone, email, is_headquarters || false]
    );

    res.status(201).json({
      success: true,
      message: 'Branch added successfully',
      branch: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/companies/profile/branches/:id
// @desc    Update a branch
// @access  Private (Company only)
router.put('/profile/branches/:id', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Access denied. Companies only.', 403));
    }

    const { id } = req.params;
    const { name, address, city, state, country, postal_code, phone, email, is_headquarters, is_active } = req.body;

    // Get company ID
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (companyResult.rows.length === 0) {
      return next(new AppError('Company profile not found', 404));
    }

    const companyId = companyResult.rows[0].id;

    // Verify branch belongs to this company
    const branchCheck = await pool.query(
      'SELECT id FROM company_branches WHERE id = $1 AND company_id = $2',
      [id, companyId]
    );

    if (branchCheck.rows.length === 0) {
      return next(new AppError('Branch not found', 404));
    }

    // If setting as headquarters, unset other headquarters
    if (is_headquarters) {
      await pool.query(
        'UPDATE company_branches SET is_headquarters = FALSE WHERE company_id = $1 AND id != $2',
        [companyId, id]
      );
    }

    // Update branch
    const result = await pool.query(
      `UPDATE company_branches 
       SET name = COALESCE($1, name),
           address = COALESCE($2, address),
           city = COALESCE($3, city),
           state = COALESCE($4, state),
           country = COALESCE($5, country),
           postal_code = COALESCE($6, postal_code),
           phone = COALESCE($7, phone),
           email = COALESCE($8, email),
           is_headquarters = COALESCE($9, is_headquarters),
           is_active = COALESCE($10, is_active),
           updated_at = NOW()
       WHERE id = $11
       RETURNING *`,
      [name, address, city, state, country, postal_code, phone, email, is_headquarters, is_active, id]
    );

    res.json({
      success: true,
      message: 'Branch updated successfully',
      branch: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/companies/profile/branches/:id
// @desc    Delete a branch
// @access  Private (Company only)
router.delete('/profile/branches/:id', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Access denied. Companies only.', 403));
    }

    const { id } = req.params;

    // Get company ID
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (companyResult.rows.length === 0) {
      return next(new AppError('Company profile not found', 404));
    }

    const companyId = companyResult.rows[0].id;

    // Delete branch (verify it belongs to this company)
    const result = await pool.query(
      'DELETE FROM company_branches WHERE id = $1 AND company_id = $2 RETURNING *',
      [id, companyId]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Branch not found', 404));
    }

    res.json({
      success: true,
      message: 'Branch deleted successfully'
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/companies/:slug/branches
// @desc    Get all branches for a company (public)
// @access  Public
router.get('/:slug/branches', async (req, res, next) => {
  try {
    const { slug } = req.params;

    // Get company ID by slug
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE slug = $1',
      [slug]
    );

    if (companyResult.rows.length === 0) {
      return next(new AppError('Company not found', 404));
    }

    const companyId = companyResult.rows[0].id;

    // Get active branches only for public view
    const branchesResult = await pool.query(
      `SELECT id, name, address, city, state, country, postal_code, phone, email, is_headquarters
       FROM company_branches 
       WHERE company_id = $1 AND is_active = TRUE
       ORDER BY is_headquarters DESC, created_at ASC`,
      [companyId]
    );

    res.json({
      success: true,
      branches: branchesResult.rows
    });
  } catch (error) {
    next(error);
  }
});

export default router;
