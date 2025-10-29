import express from 'express';
import { protect } from '../middleware/auth.js';
import pool from '../config/database.js';

const router = express.Router();

// @route   GET /api/dashboard/candidate
// @desc    Get dashboard analytics for candidates
// @access  Private (Candidate only)
router.get('/candidate', protect, async (req, res) => {
  try {
    if (req.user.accountType !== 'candidate') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Candidates only.' 
      });
    }

    // Get application stats
    const applicationStats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'reviewing' THEN 1 END) as reviewing,
        COUNT(CASE WHEN status = 'accepted' THEN 1 END) as accepted,
        COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected,
        COUNT(CASE WHEN status = 'withdrawn' THEN 1 END) as withdrawn
      FROM job_applications
      WHERE user_id = $1
    `, [req.user.id]);

    // Get recent applications
    const recentApplications = await pool.query(`
      SELECT 
        ja.id,
        ja.status,
        ja.applied_at,
        j.title as job_title,
        c.name as company_name,
        c.logo_url as company_logo
      FROM job_applications ja
      JOIN jobs j ON ja.job_id = j.id
      JOIN companies c ON j.company_id = c.id
      WHERE ja.user_id = $1
      ORDER BY ja.applied_at DESC
      LIMIT 5
    `, [req.user.id]);

    // Get profile completion percentage
    // NOTE: candidate profiles use 'professional_title' in other parts of the app
    // keep the dashboard in sync by selecting professional_title here.
    const profileResult = await pool.query(`
      SELECT professional_title, bio, location, phone, linkedin_url, skills
      FROM candidates
      WHERE user_id = $1
    `, [req.user.id]);

    let profileCompletion = 20; // Base for having account
    if (profileResult.rows.length > 0) {
      const profile = profileResult.rows[0];
      // Use professional_title (keeps parity with profile edit page)
      if (profile.professional_title) profileCompletion += 15;
      if (profile.bio) profileCompletion += 15;
      if (profile.location) profileCompletion += 15;
      if (profile.phone) profileCompletion += 10;
      if (profile.linkedin_url) profileCompletion += 15;
      if (profile.skills && profile.skills.length > 0) profileCompletion += 10;
    }

    res.json({
      success: true,
      analytics: {
        applicationStats: applicationStats.rows[0],
        recentApplications: recentApplications.rows,
        profileCompletion
      }
    });
  } catch (error) {
    console.error('Error fetching candidate dashboard:', error);
    res.status(500).json({ success: false, message: 'Error fetching dashboard data' });
  }
});

// @route   GET /api/dashboard/company
// @desc    Get dashboard analytics for companies
// @access  Private (Company only)
router.get('/company', protect, async (req, res) => {
  try {
    if (req.user.accountType !== 'company') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Companies only.' 
      });
    }

    // Get company ID, create profile if doesn't exist
    let companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    let companyId;
    if (companyResult.rows.length === 0) {
      // Auto-create company profile
      const newCompany = await pool.query(
        `INSERT INTO companies (name, slug, user_id, created_at) 
         VALUES ($1, $2, $3, NOW()) 
         RETURNING id`,
        [req.user.name, req.user.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), req.user.id]
      );
      companyId = newCompany.rows[0].id;
    } else {
      companyId = companyResult.rows[0].id;
    }

    // Get job posting stats
    const jobStats = await pool.query(`
      SELECT 
        COUNT(*) as total_jobs,
        COUNT(CASE WHEN is_active = true THEN 1 END) as active_jobs,
        COUNT(CASE WHEN is_active = false THEN 1 END) as inactive_jobs
      FROM jobs
      WHERE company_id = $1
    `, [companyId]);

    // Get application stats
    const applicationStats = await pool.query(`
      SELECT 
        COUNT(*) as total_applications,
        COUNT(CASE WHEN ja.status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN ja.status = 'reviewing' THEN 1 END) as reviewing,
        COUNT(CASE WHEN ja.status = 'accepted' THEN 1 END) as accepted,
        COUNT(CASE WHEN ja.status = 'rejected' THEN 1 END) as rejected
      FROM job_applications ja
      JOIN jobs j ON ja.job_id = j.id
      WHERE j.company_id = $1
    `, [companyId]);

    // Get recent applications
    const recentApplications = await pool.query(`
      SELECT 
        ja.id,
        ja.status,
        ja.applied_at,
        j.title as job_title,
        COALESCE(c.full_name, SPLIT_PART(u.email, '@', 1)) as candidate_name
      FROM job_applications ja
      JOIN jobs j ON ja.job_id = j.id
      JOIN users u ON ja.user_id = u.id
      LEFT JOIN candidates c ON c.user_id = u.id
      WHERE j.company_id = $1
      ORDER BY ja.applied_at DESC
      LIMIT 10
    `, [companyId]);

    // Get top performing jobs
    const topJobs = await pool.query(`
      SELECT 
        j.id,
        j.title,
        j.location,
        j.created_at,
        COUNT(DISTINCT ja.id) as applications_count,
        COUNT(DISTINCT jv.id) as views_count
      FROM jobs j
      LEFT JOIN job_applications ja ON j.id = ja.job_id
      LEFT JOIN job_views jv ON j.id = jv.job_id
      WHERE j.company_id = $1 AND j.is_active = true
      GROUP BY j.id
      ORDER BY applications_count DESC, views_count DESC
      LIMIT 5
    `, [companyId]);

    res.json({
      success: true,
      analytics: {
        jobStats: jobStats.rows[0],
        applicationStats: applicationStats.rows[0],
        recentApplications: recentApplications.rows,
        topJobs: topJobs.rows
      }
    });
  } catch (error) {
    console.error('Error fetching company dashboard:', error);
    res.status(500).json({ success: false, message: 'Error fetching dashboard data' });
  }
});

export default router;
