import express from 'express';
import { protect } from '../middleware/auth.js';
import pool from '../config/database.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

// @route   GET /api/candidates/profile
// @desc    Get current candidate's profile
// @access  Private (Candidate only)
router.get('/profile', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'candidate') {
      return next(new AppError('Access denied. Candidates only.', 403));
    }

    const result = await pool.query(
      `SELECT c.*, u.name, u.email 
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

      const userResult = await pool.query(
        'SELECT name, email FROM users WHERE id = $1',
        [req.user.id]
      );

      return res.json({
        success: true,
        profile: {
          ...createResult.rows[0],
          name: userResult.rows[0].name,
          email: userResult.rows[0].email
        }
      });
    }

    res.json({
      success: true,
      profile: result.rows[0]
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

    const { title, bio, location, phone, linkedin_url, skills, is_public } = req.body;

    // Check if profile exists
    const checkProfile = await pool.query(
      'SELECT id FROM candidates WHERE user_id = $1',
      [req.user.id]
    );

    let result;
    if (checkProfile.rows.length === 0) {
      // Create profile
      result = await pool.query(
        `INSERT INTO candidates (user_id, title, bio, location, phone, linkedin_url, skills, is_public, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
         RETURNING *`,
        [req.user.id, title, bio, location, phone, linkedin_url, skills, is_public ?? true]
      );
    } else {
      // Update profile
      result = await pool.query(
        `UPDATE candidates 
         SET title = COALESCE($2, title),
             bio = COALESCE($3, bio),
             location = COALESCE($4, location),
             phone = COALESCE($5, phone),
             linkedin_url = COALESCE($6, linkedin_url),
             skills = COALESCE($7, skills),
             is_public = COALESCE($8, is_public),
             updated_at = NOW()
         WHERE user_id = $1
         RETURNING *`,
        [req.user.id, title, bio, location, phone, linkedin_url, skills, is_public]
      );
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

// @route   GET /api/candidates/:id
// @desc    Get candidate profile by ID (public profiles only)
// @access  Public
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.name 
       FROM candidates c
       JOIN users u ON c.user_id = u.id
       WHERE c.id = $1 AND c.is_public = true`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Candidate profile not found or not public', 404));
    }

    res.json({
      success: true,
      profile: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

export default router;
