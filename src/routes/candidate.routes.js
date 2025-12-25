import express from 'express';
import { protect } from '../middleware/auth.js';
import pool from '../config/database.js';
import { AppError } from '../middleware/errorHandler.js';
import multer from 'multer';
import { uploadProfilePicture, getProfilePictureSignedUrl, uploadToBucket, createSignedUrl, BUCKET_NAME, FOLDERS } from '../utils/supabaseStorage.js';

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

// @route   GET /api/candidates/profile
// @desc    Get current candidate's profile
// @access  Private (Candidate only)
router.get('/profile', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'candidate') {
      return next(new AppError('Access denied. Candidates only.', 403));
    }

    const result = await pool.query(
      `SELECT c.*, u.email
       FROM candidates c
       JOIN users u ON c.user_id = u.id
       WHERE c.user_id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      // Create candidate profile if doesn't exist
      const createResult = await pool.query(
        `INSERT INTO candidates (user_id, created_at, updated_at)
         VALUES ($1, NOW(), NOW())
         RETURNING *`,
        [req.user.id]
      );

      // Use candidate.full_name if present later; for newly created profile fall back to user fields
      const fallbackName = req.user.username || req.user.email || 'candidate';

      return res.json({
        success: true,
        profile: {
          ...createResult.rows[0],
          name: fallbackName,
          email: req.user.email,
          experiences: []
        }
      });
    }

    // Fetch employment history
    const employmentResult = await pool.query(
      `SELECT id, company_name as company, position as job_title, location,
              TO_CHAR(start_date, 'YYYY-MM') as start_month,
              CASE WHEN is_current THEN NULL ELSE TO_CHAR(end_date, 'YYYY-MM') END as end_month,
              is_current, description, verification_status
       FROM employment_history
       WHERE candidate_id = $1
       ORDER BY start_date DESC`,
      [result.rows[0].id]
    );

    // Fetch education history
    const educationResult = await pool.query(
      `SELECT id, institution, degree, field_of_study, 
              TO_CHAR(start_date, 'YYYY-MM') as start_month,
              CASE WHEN is_current THEN NULL ELSE TO_CHAR(end_date, 'YYYY-MM') END as end_month,
              is_current, description, verification_status
       FROM education_history
       WHERE candidate_id = $1
       ORDER BY start_date DESC`,
      [result.rows[0].id]
    );

    const profile = {
      ...result.rows[0],
      experiences: employmentResult.rows,
      educations: educationResult.rows
    };

    res.json({
      success: true,
      profile
    });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/candidates/profile
// @desc    Update current candidate's profile
// @access  Private (Candidate only)
router.put('/profile', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'candidate') {
      return next(new AppError('Access denied. Candidates only.', 403));
    }

  const { professional_title, bio, location, phone, linkedin_url, skills, experiences, educations, is_public, avatar_url, cover_image_url } = req.body;

    // Check if profile exists
    const checkProfile = await pool.query(
      'SELECT id FROM candidates WHERE user_id = $1',
      [req.user.id]
    );

    let result;
    if (checkProfile.rows.length === 0) {
      // Create profile
      result = await pool.query(
        `INSERT INTO candidates (user_id, professional_title, bio, location, phone, linkedin_url, skills, is_public, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
         RETURNING *`,
        [req.user.id, professional_title, bio, location, phone, linkedin_url, skills, is_public ?? true]
      );
    } else {
      // Update profile
      result = await pool.query(
        `UPDATE candidates
         SET professional_title = COALESCE($2, professional_title),
             bio = COALESCE($3, bio),
             location = COALESCE($4, location),
             phone = COALESCE($5, phone),
             linkedin_url = COALESCE($6, linkedin_url),
             skills = COALESCE($7, skills),
             is_public = COALESCE($8, is_public),
             avatar_url = COALESCE($9, avatar_url),
             cover_image_url = COALESCE($10, cover_image_url),
             updated_at = NOW()
         WHERE user_id = $1
         RETURNING *`,
        [req.user.id, professional_title, bio, location, phone, linkedin_url, skills, is_public, avatar_url, cover_image_url]
      );
    }

    const candidateId = result.rows[0].id;

    // Handle employment history
    if (experiences && Array.isArray(experiences)) {
      // Delete existing employment records
      await pool.query('DELETE FROM employment_history WHERE candidate_id = $1', [candidateId]);

      // Insert new employment records
      for (const exp of experiences) {
        if (exp.job_title && exp.description) {
          // Convert month format to date format
          const startDate = exp.start_month ? `${exp.start_month}-01` : null;
          const endDate = exp.end_month ? `${exp.end_month}-01` : null;

          await pool.query(
            `INSERT INTO employment_history (candidate_id, company_name, position, location, start_date, end_date, is_current, description, verification_status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW(), NOW())`,
            [
              candidateId,
              exp.company || null,
              exp.job_title,
              exp.location || null,
              startDate,
              endDate,
              exp.is_current || false,
              exp.description
            ]
          );
        }
      }
    }

    // Handle education history
    if (educations && Array.isArray(educations)) {
      // Delete existing education records
      await pool.query('DELETE FROM education_history WHERE candidate_id = $1', [candidateId]);

      // Insert new education records
      for (const ed of educations) {
        if (ed.institution && ed.degree) {
          const startDate = ed.start_month ? `${ed.start_month}-01` : null;
          const endDate = ed.end_month ? `${ed.end_month}-01` : null;

          await pool.query(
            `INSERT INTO education_history (candidate_id, institution, degree, field_of_study, start_date, end_date, is_current, description, verification_status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW(), NOW())`,
            [
              candidateId,
              ed.institution,
              ed.degree,
              ed.field_of_study || null,
              startDate,
              endDate,
              ed.is_current || false,
              ed.description || null
            ]
          );
        }
      }
    }

    // Fetch updated employment history for response
    const employmentResult = await pool.query(
      `SELECT id, company_name as company, position as job_title, location,
              TO_CHAR(start_date, 'YYYY-MM') as start_month,
              CASE WHEN is_current THEN NULL ELSE TO_CHAR(end_date, 'YYYY-MM') END as end_month,
              is_current, description, verification_status
       FROM employment_history
       WHERE candidate_id = $1
       ORDER BY start_date DESC`,
      [candidateId]
    );

    // Fetch updated education history for response
    const educationResult = await pool.query(
      `SELECT id, institution, degree, field_of_study, 
              TO_CHAR(start_date, 'YYYY-MM') as start_month,
              CASE WHEN is_current THEN NULL ELSE TO_CHAR(end_date, 'YYYY-MM') END as end_month,
              is_current, description, verification_status
       FROM education_history
       WHERE candidate_id = $1
       ORDER BY start_date DESC`,
      [candidateId]
    );

    const profile = {
      ...result.rows[0],
      experiences: employmentResult.rows,
      educations: educationResult.rows
    };

    res.json({
      success: true,
      message: 'Profile updated successfully',
      profile
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/candidates/:id
// @desc    Get candidate profile by ID (public profiles only)
// @access  Public
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.name as username, u.email
       FROM candidates c
       JOIN users u ON c.user_id = u.id
       WHERE c.id = $1 AND c.is_public = true`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Candidate profile not found or not public', 404));
    }

    // Fetch employment history
    const employmentResult = await pool.query(
      `SELECT id, company_name as company, position as job_title, location,
              TO_CHAR(start_date, 'YYYY-MM') as start_month,
              CASE WHEN is_current THEN NULL ELSE TO_CHAR(end_date, 'YYYY-MM') END as end_month,
              is_current, description, verification_status
       FROM employment_history
       WHERE candidate_id = $1
       ORDER BY start_date DESC`,
      [req.params.id]
    );

    // Fetch education history
    const educationResult = await pool.query(
      `SELECT id, institution, degree, field_of_study, 
              TO_CHAR(start_date, 'YYYY-MM') as start_month,
              CASE WHEN is_current THEN NULL ELSE TO_CHAR(end_date, 'YYYY-MM') END as end_month,
              is_current, description, verification_status
       FROM education_history
       WHERE candidate_id = $1
       ORDER BY start_date DESC`,
      [req.params.id]
    );

    // Prefer candidate.full_name, fallback to username
    const row = result.rows[0];
    const profile = {
      ...row,
      name: row.full_name || row.username || null,
      experiences: employmentResult.rows,
      educations: educationResult.rows
    };

    res.json({
      success: true,
      profile
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/candidates/profile/avatar
// @desc    Upload profile picture for current candidate
// @access  Private (Candidate only)
router.post('/profile/avatar', protect, upload.single('avatar'), async (req, res, next) => {
  try {
    if (req.user.account_type !== 'candidate') {
      return next(new AppError('Access denied. Candidates only.', 403));
    }

    if (!req.file) {
      return next(new AppError('No file uploaded', 400));
    }

    const userId = req.user.id;
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;

    // Upload to Supabase storage
    const { data, error, path } = await uploadProfilePicture(userId, fileBuffer, fileName);

    if (error) {
      console.error('Supabase upload error:', error);
      return next(new AppError('Failed to upload image', 500));
    }

    // Update candidate profile with the new avatar path
    await pool.query(
      'UPDATE candidates SET avatar_url = $1, updated_at = NOW() WHERE user_id = $2',
      [path, userId]
    );

    res.json({
      success: true,
      message: 'Profile picture uploaded successfully',
      avatar_path: path
    });
  } catch (error) {
    next(error);
  }
});

// Configure multer for resume uploads (memory)
const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new AppError('Invalid resume file type. Allowed: PDF, DOC, DOCX, TXT', 400), false);
  }
});

// @route   POST /api/candidates/profile/resume
// @desc    Upload candidate resume and save path on profile
// @access  Private (Candidate only)
router.post('/profile/resume', protect, resumeUpload.single('resume'), async (req, res, next) => {
  try {
    if (req.user.account_type !== 'candidate') {
      return next(new AppError('Access denied. Candidates only.', 403));
    }

    if (!req.file) {
      return next(new AppError('No file uploaded', 400));
    }

    const userId = req.user.id;
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;
    const ext = fileName.split('.').pop().toLowerCase();
    const path = `${FOLDERS.RESUME}/${userId}-${Date.now()}.${ext}`;

    const { data, error } = await uploadToBucket(BUCKET_NAME, path, fileBuffer, {
      contentType: req.file.mimetype,
      upsert: true,
    });

    if (error) {
      console.error('Supabase resume upload error:', error);
      return next(new AppError('Failed to upload resume', 500));
    }

    // Update candidate profile with the resume path
    await pool.query('UPDATE candidates SET resume_url = $1, updated_at = NOW() WHERE user_id = $2', [path, userId]);

    // Create signed URL for immediate access
    const signed = await createSignedUrl(BUCKET_NAME, path, 3600);

    res.json({
      success: true,
      message: 'Resume uploaded successfully',
      resume_path: path,
      signedUrl: signed.data?.signedUrl || null
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/candidates/profile/avatar-url
// @desc    Get signed URL for current candidate's profile picture
// @access  Private (Candidate only)
router.get('/profile/avatar-url', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'candidate') {
      return next(new AppError('Access denied. Candidates only.', 403));
    }

    // Get the avatar path from database
    const result = await pool.query(
      'SELECT avatar_url FROM candidates WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0 || !result.rows[0].avatar_url) {
      return next(new AppError('No profile picture found', 404));
    }

    const avatarPath = result.rows[0].avatar_url;

    // Generate signed URL
    const { data, error } = await getProfilePictureSignedUrl(avatarPath);

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

// @route   POST /api/candidates/profile/cover-image
// @desc    Upload cover image for current candidate
// @access  Private (Candidate only)
router.post('/profile/cover-image', protect, upload.single('cover_image'), async (req, res, next) => {
  try {
    if (req.user.account_type !== 'candidate') {
      return next(new AppError('Access denied. Candidates only.', 403));
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
      'UPDATE candidates SET cover_image_url = $1, updated_at = NOW() WHERE user_id = $2',
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

// @route   GET /api/candidates/profile/cover-image-url
// @desc    Get signed URL for current candidate's cover image
// @access  Private (Candidate only)
router.get('/profile/cover-image-url', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'candidate') {
      return next(new AppError('Access denied. Candidates only.', 403));
    }

    // Get the cover image path from database
    const result = await pool.query(
      'SELECT cover_image_url FROM candidates WHERE user_id = $1',
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

// @route   GET /api/candidates/:id
// @desc    Get candidate profile by ID (public/admin view)
// @access  Public
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    // First try to find by user_id
    let result = await pool.query(
      `SELECT c.*, u.email, u.name as user_name
       FROM candidates c
       JOIN users u ON c.user_id = u.id
       WHERE u.id = $1`,
      [id]
    );

    // If not found by user_id, try by candidate_id
    if (result.rows.length === 0) {
      result = await pool.query(
        `SELECT c.*, u.email, u.name as user_name
         FROM candidates c
         JOIN users u ON c.user_id = u.id
         WHERE c.id = $1`,
        [id]
      );
    }

    if (result.rows.length === 0) {
      return next(new AppError('Candidate not found', 404));
    }

    // Fetch employment history
    const employmentResult = await pool.query(
      `SELECT id, company_name as company, position as job_title, location,
              TO_CHAR(start_date, 'YYYY-MM') as start_month,
              CASE WHEN is_current THEN NULL ELSE TO_CHAR(end_date, 'YYYY-MM') END as end_month,
              is_current, description, verification_status
       FROM employment_history
       WHERE candidate_id = $1
       ORDER BY start_date DESC`,
      [result.rows[0].id]
    );

    // Fetch education history
    const educationResult = await pool.query(
      `SELECT id, institution, degree, field_of_study, 
              TO_CHAR(start_date, 'YYYY-MM') as start_month,
              CASE WHEN is_current THEN NULL ELSE TO_CHAR(end_date, 'YYYY-MM') END as end_month,
              is_current, description, verification_status
       FROM education_history
       WHERE candidate_id = $1
       ORDER BY start_date DESC`,
      [result.rows[0].id]
    );

    const candidate = {
      ...result.rows[0],
      experiences: employmentResult.rows,
      educations: educationResult.rows
    };

    res.json({
      success: true,
      candidate
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/candidates/:id/avatar-url
// @desc    Get candidate avatar signed URL by ID
// @access  Public
router.get('/:id/avatar-url', async (req, res, next) => {
  try {
    const { id } = req.params;

    // First try to find by user_id
    let result = await pool.query(
      `SELECT c.avatar_url
       FROM candidates c
       JOIN users u ON c.user_id = u.id
       WHERE u.id = $1`,
      [id]
    );

    // If not found by user_id, try by candidate_id
    if (result.rows.length === 0) {
      result = await pool.query(
        `SELECT avatar_url FROM candidates WHERE id = $1`,
        [id]
      );
    }

    if (result.rows.length === 0 || !result.rows[0].avatar_url) {
      return next(new AppError('No avatar found', 404));
    }

    const avatarPath = result.rows[0].avatar_url;

    // Generate signed URL
    const { data, error } = await getProfilePictureSignedUrl(avatarPath);

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

export default router;

