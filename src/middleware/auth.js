import jwt from 'jsonwebtoken';
import { AppError } from './errorHandler.js';
import pool from '../config/database.js';

export const protect = async (req, res, next) => {
  try {
    let token;

    // Get token from header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(new AppError('Not authorized to access this route', 401));
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get user from database (Supabase schema: no name or role in users table)
      const result = await pool.query(
        'SELECT id, email, account_type, is_verified FROM users WHERE id = $1',
        [decoded.id]
      );

      if (result.rows.length === 0) {
        return next(new AppError('User not found', 404));
      }

      const user = result.rows[0];

      // Get name from company or candidate table
      let name = user.email.split('@')[0]; // Default to email prefix
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
          name = candidateResult.rows[0].full_name || user.email.split('@')[0];
        }
      }

      // Set user object with all needed fields (both camelCase and snake_case for compatibility)
      req.user = {
        id: user.id,
        email: user.email,
        name: name,
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
