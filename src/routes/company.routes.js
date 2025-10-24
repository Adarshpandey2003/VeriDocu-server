import express from 'express';
import { protect } from '../middleware/auth.js';
import pool from '../config/database.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

// @route   GET /api/companies/profile
// @desc    Get current company's profile
// @access  Private (Company only)
router.get('/profile', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Access denied. Companies only.', 403));
    }

    let result = await pool.query(
      `SELECT c.*, u.name as user_name, u.email 
       FROM companies c
       JOIN users u ON c.user_id = u.id
       WHERE c.user_id = $1`,
      [req.user.id]
    );

    // Auto-create company profile if it doesn't exist
    if (result.rows.length === 0) {
      const slug = req.user.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      await pool.query(
        `INSERT INTO companies (name, slug, user_id, created_at) 
         VALUES ($1, $2, $3, NOW())`,
        [req.user.name, slug, req.user.id]
      );
      
      // Fetch the newly created profile
      result = await pool.query(
        `SELECT c.*, u.name as user_name, u.email 
         FROM companies c
         JOIN users u ON c.user_id = u.id
         WHERE c.user_id = $1`,
        [req.user.id]
      );
    }

    res.json({
      success: true,
      profile: result.rows[0]
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

    const { name, description, industry, size, website, location, logo_url } = req.body;

    // Generate slug from name if name is provided
    let slug = null;
    if (name) {
      slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [req.user.id, name, slug, description, industry, size, website, location, logo_url]
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
              (SELECT COUNT(*) FROM jobs WHERE company_id = c.id AND is_active = true) as active_jobs
       FROM companies c
       WHERE c.slug = $1`,
      [req.params.slug]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Company not found', 404));
    }

    res.json({
      success: true,
      company: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

export default router;
