import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import pool from '../config/database.js';
import { AppError } from '../middleware/errorHandler.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// Generate JWT token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('accountType').isIn(['candidate', 'company']).withMessage('Invalid account type'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { name, email, password, accountType, companyName } = req.body;

      // Check if user exists
      const userExists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (userExists.rows.length > 0) {
        return next(new AppError('User already exists with this email', 409));
      }

      // Hash password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      // Create user (Supabase schema: password, not password_hash)
      const result = await pool.query(
        `INSERT INTO users (email, password, account_type, created_at) 
         VALUES ($1, $2, $3, NOW()) 
         RETURNING id, email, account_type`,
        [email, hashedPassword, accountType]
      );

      const user = result.rows[0];
      user.name = name; // Set name for response

      // If company account, create company profile
      if (accountType === 'company') {
        const slug = (companyName || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        await pool.query(
          `INSERT INTO companies (name, slug, user_id, created_at) VALUES ($1, $2, $3, NOW())`,
          [companyName || name, slug, user.id]
        );
      }

      // If candidate account, create candidate profile
      if (accountType === 'candidate') {
        await pool.query(
          `INSERT INTO candidates (user_id, full_name, created_at) VALUES ($1, $2, NOW())`,
          [user.id, name]
        );
      }

      // Generate token
      const token = generateToken(user.id);

      res.status(201).json({
        success: true,
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          accountType: user.account_type,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { email, password } = req.body;

      // Check if user exists (Supabase schema: password, not password_hash)
      const result = await pool.query(
        'SELECT id, email, password, account_type FROM users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        return next(new AppError('Invalid credentials', 401));
      }

      const user = result.rows[0];

      // Check password
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return next(new AppError('Invalid credentials', 401));
      }

      // Get name from company or candidate table
      let name = email.split('@')[0]; // Default to email prefix
      if (user.account_type === 'company') {
        const companyResult = await pool.query(
          'SELECT name FROM companies WHERE user_id = $1',
          [user.id]
        );
        if (companyResult.rows.length > 0) {
          name = companyResult.rows[0].name;
        }
      } else if (user.account_type === 'candidate') {
        const candidateResult = await pool.query(
          'SELECT full_name FROM candidates WHERE user_id = $1',
          [user.id]
        );
        if (candidateResult.rows.length > 0) {
          name = candidateResult.rows[0].full_name || email.split('@')[0];
        }
      }

      // Generate token
      const token = generateToken(user.id);

      res.json({
        success: true,
        token,
        user: {
          id: user.id,
          name: name,
          email: user.email,
          accountType: user.account_type,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', protect, async (req, res, next) => {
  try {
    res.json({
      success: true,
      user: req.user,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
