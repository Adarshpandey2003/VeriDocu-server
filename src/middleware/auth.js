import jwt from 'jsonwebtoken';
import { AppError } from './errorHandler.js';
import pool from '../config/database.js';

export const protect = async (req, res, next) => {
  try {
    let token;

    // Get token from header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
      console.log(`[AUTH] ✅ Token found in authorization header for ${req.method} ${req.path}`);
    }

    if (!token) {
      console.log(`[AUTH] ❌ No token found for ${req.method} ${req.path}`);
      console.log(`[AUTH] Headers:`, req.headers.authorization ? 'Authorization header exists but invalid format' : 'No authorization header');
      return next(new AppError('Not authorized to access this route', 401));
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get user from database - include name from users table
      const result = await pool.query(
        'SELECT id, email, account_type, is_verified, name FROM users WHERE id = $1',
        [decoded.id]
      );

      if (result.rows.length === 0) {
        return next(new AppError('User not found', 404));
      }

      const user = result.rows[0];

      // Get display name - for candidates from candidates table, for companies from users table
      let displayName = user.name || user.email.split('@')[0]; // Default to name from users table
      
      if (user.account_type === 'candidate') {
        // For candidates, get full_name from candidates table
        const candidateResult = await pool.query(
          'SELECT full_name FROM candidates WHERE user_id = $1',
          [user.id]
        );
        if (candidateResult.rows.length > 0 && candidateResult.rows[0].full_name) {
          displayName = candidateResult.rows[0].full_name;
        }
      }
      // For companies, use name from users table (already set above)

      // For companies, use name from users table (already set above)

      // Set user object with all needed fields (both camelCase and snake_case for compatibility)
      req.user = {
        id: user.id,
        email: user.email,
        name: displayName,
        accountType: user.account_type,
        account_type: user.account_type, // Keep snake_case for backward compatibility
        role: user.account_type, // Use account_type as role for authorization
        isVerified: user.is_verified,
        is_verified: user.is_verified // Keep snake_case for backward compatibility
      };
      
      next();
    } catch (error) {
      return next(new AppError('Not authorized to access this route', 401));
    }
  } catch (error) {
    next(error);
  }
};

export const authorize = (...accountTypes) => {
  return (req, res, next) => {
    // Check if user exists (protect middleware should have set this)
    if (!req.user) {
      return next(new AppError('Authentication required. Please log in.', 401));
    }

    // Check against account_type (candidate, company, admin)
    if (!accountTypes.includes(req.user.accountType) && !accountTypes.includes(req.user.role)) {
      return next(
        new AppError(
          `User account type ${req.user.accountType} is not authorized to access this route`,
          403
        )
      );
    }
    next();
  };
};
