import express from 'express';
import { protect } from '../middleware/auth.js';
import pool from '../config/database.js';

const router = express.Router();

// Get search suggestions
router.get('/suggestions', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.json({ success: true, suggestions: [] });
    }
    
    const searchTerm = `%${q.trim()}%`;
    
    // Get unique job titles, company names, and locations
    const result = await pool.query(`
      SELECT DISTINCT
        j.title,
        c.name as company,
        j.location
      FROM jobs j
      JOIN companies c ON j.company_id = c.id
      WHERE j.is_active = true
        AND (
          j.title ILIKE $1 OR 
          c.name ILIKE $1 OR 
          j.location ILIKE $1
        )
      LIMIT 10
    `, [searchTerm]);
    
    const suggestions = [];
    const seen = new Set();
    
    result.rows.forEach(row => {
      // Add title suggestion
      if (row.title.toLowerCase().includes(q.toLowerCase()) && !seen.has(row.title.toLowerCase())) {
        suggestions.push({ type: 'title', text: row.title, icon: 'briefcase' });
        seen.add(row.title.toLowerCase());
      }
      
      // Add company suggestion
      if (row.company.toLowerCase().includes(q.toLowerCase()) && !seen.has(row.company.toLowerCase())) {
        suggestions.push({ type: 'company', text: row.company, icon: 'building' });
        seen.add(row.company.toLowerCase());
      }
      
      // Add location suggestion
      if (row.location.toLowerCase().includes(q.toLowerCase()) && !seen.has(row.location.toLowerCase())) {
        suggestions.push({ type: 'location', text: row.location, icon: 'map-pin' });
        seen.add(row.location.toLowerCase());
      }
    });
    
    res.json({ success: true, suggestions: suggestions.slice(0, 8) });
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ success: false, message: 'Error fetching suggestions' });
  }
});

// @route   GET /api/jobs
// @desc    Browse all active jobs with filters
// @access  Public
router.get('/', async (req, res) => {
  try {
    const { 
      search, 
      location, 
      radius, 
      userLat, 
      userLng,
      salaryMin, 
      salaryMax,
      employmentType,
      companyId,
      topCompaniesOnly,
      sortBy = 'recent' // recent, salary-high, salary-low, company
    } = req.query;

    // Debug logging
    console.log('📊 GET /api/jobs - Query params:', {
      search,
      location,
      radius,
      salaryMin,
      salaryMax,
      employmentType,
      topCompaniesOnly,
      sortBy
    });

    let query = `
      SELECT 
        j.id,
        j.title,
        j.description,
        j.location,
        j.employment_type as "employmentType",
        j.salary_min as "salaryMin",
        j.salary_max as "salaryMax",
        j.required_skills as "requiredSkills",
        j.benefits,
        j.created_at as "postedAt",
        c.name as company,
        c.logo_url as "companyLogo",
        c.is_verified as "companyVerified",
        c.id as "companyId",
        (SELECT COUNT(*) FROM job_applications WHERE job_id = j.id) as "applicationsCount"
    `;

    // Add user-specific fields if authenticated
    const userId = req.user?.id;
    if (userId) {
      query += `,
        EXISTS(SELECT 1 FROM job_applications WHERE job_id = j.id AND user_id = ${userId}) as "hasApplied"
      `;
    } else {
      query += `, false as "hasApplied"`;
    }

    query += `
      FROM jobs j
      JOIN companies c ON j.company_id = c.id
      WHERE j.is_active = true
    `;

    const params = [];
    let paramIndex = 1;

    // Search filter
    if (search && search.trim()) {
      query += ` AND (
        j.title ILIKE $${paramIndex} OR 
        j.description ILIKE $${paramIndex} OR 
        c.name ILIKE $${paramIndex} OR
        j.location ILIKE $${paramIndex}
      )`;
      params.push(`%${search.trim()}%`);
      paramIndex++;
    }

    // Location filter (simple text match)
    if (location && location.trim() && !radius) {
      query += ` AND j.location ILIKE $${paramIndex}`;
      params.push(`%${location.trim()}%`);
      paramIndex++;
    }

    // Salary range filter
    if (salaryMin) {
      query += ` AND j.salary_max >= $${paramIndex}`;
      params.push(parseFloat(salaryMin));
      paramIndex++;
    }

    if (salaryMax) {
      query += ` AND j.salary_min <= $${paramIndex}`;
      params.push(parseFloat(salaryMax));
      paramIndex++;
    }

    // Employment type filter
    if (employmentType && employmentType !== 'all') {
      query += ` AND j.employment_type = $${paramIndex}`;
      params.push(employmentType);
      paramIndex++;
    }

    // Specific company filter
    if (companyId) {
      query += ` AND c.id = $${paramIndex}`;
      params.push(parseInt(companyId));
      paramIndex++;
    }

    // Top companies only (verified companies)
    if (topCompaniesOnly === 'true') {
      query += ` AND c.is_verified = true`;
    }

    // Sorting
    switch (sortBy) {
      case 'salary-high':
        query += ` ORDER BY j.salary_max DESC NULLS LAST, j.created_at DESC`;
        break;
      case 'salary-low':
        query += ` ORDER BY j.salary_min ASC NULLS LAST, j.created_at DESC`;
        break;
      case 'company':
        query += ` ORDER BY c.name ASC, j.created_at DESC`;
        break;
      case 'applications':
        query += ` ORDER BY "applicationsCount" DESC, j.created_at DESC`;
        break;
      case 'recent':
      default:
        query += ` ORDER BY j.created_at DESC`;
    }

    // Execute query
    const result = await pool.query(query, params);

    console.log(`📦 Found ${result.rows.length} jobs matching filters`);

    // Get unique locations and companies for filter options
    const locationsResult = await pool.query(`
      SELECT DISTINCT location 
      FROM jobs 
      WHERE is_active = true AND location IS NOT NULL
      ORDER BY location
    `);

    const companiesResult = await pool.query(`
      SELECT DISTINCT c.id, c.name, c.logo_url as "logoUrl", c.is_verified as "isVerified"
      FROM companies c
      JOIN jobs j ON c.id = j.company_id
      WHERE j.is_active = true
      ORDER BY c.is_verified DESC, c.name ASC
      LIMIT 50
    `);

    res.json({
      success: true,
      jobs: result.rows,
      filters: {
        locations: locationsResult.rows.map(r => r.location),
        companies: companiesResult.rows,
        employmentTypes: ['full-time', 'part-time', 'contract', 'internship']
      },
      total: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching jobs:', error);
    res.status(500).json({ success: false, message: 'Error fetching jobs' });
  }
});

// @route   GET /api/jobs/company/my-jobs
// @desc    Get all jobs for the logged-in company
// @access  Private (Company only)
router.get('/company/my-jobs', protect, async (req, res) => {
  try {
    // Verify user is a company
    if (req.user.account_type !== 'company') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Only companies can access this endpoint.' 
      });
    }

    // Get company_id for this user
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Company profile not found.' 
      });
    }

    const companyId = companyResult.rows[0].id;

    // Get all jobs for this company with application and view counts
    const result = await pool.query(`
      SELECT 
        j.*,
        COALESCE(app_count.count, 0) as applications_count,
        COALESCE(view_count.count, 0) as views_count
      FROM jobs j
      LEFT JOIN (
        SELECT job_id, COUNT(*) as count
        FROM job_applications
        GROUP BY job_id
      ) app_count ON j.id = app_count.job_id
      LEFT JOIN (
        SELECT job_id, COUNT(*) as count
        FROM job_views
        GROUP BY job_id
      ) view_count ON j.id = view_count.job_id
      WHERE j.company_id = $1
      ORDER BY j.created_at DESC
    `, [companyId]);

    res.json({
      success: true,
      jobs: result.rows.map(job => ({
        ...job,
        employment_type: job.employment_type,
        salary_min: job.salary_min,
        salary_max: job.salary_max,
        required_skills: job.required_skills || [],
        benefits: job.benefits || [],
        applications_count: parseInt(job.applications_count) || 0,
        views_count: parseInt(job.views_count) || 0
      }))
    });
  } catch (error) {
    console.error('Error fetching company jobs:', error);
    res.status(500).json({ success: false, message: 'Error fetching jobs' });
  }
});

// @route   POST /api/jobs
// @desc    Create a new job posting
// @access  Private (Company only)
router.post('/', protect, async (req, res) => {
  try {
    // Verify user is a company
    if (req.user.account_type !== 'company') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Only companies can create job postings.' 
      });
    }

    // Get company_id for this user
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Company profile not found. Please create a company profile first.' 
      });
    }

    const companyId = companyResult.rows[0].id;

    const { 
      title, 
      description, 
      requirements, 
      required_skills, 
      benefits, 
      location, 
      employment_type, 
      salary_min, 
      salary_max 
    } = req.body;

    console.log('Creating job with data:', { 
      title, 
      description, 
      requirements, 
      required_skills, 
      benefits, 
      location, 
      employment_type, 
      salary_min, 
      salary_max 
    });

    // Validate required fields
    if (!title || !description || !location) {
      return res.status(400).json({ 
        success: false, 
        message: 'Title, description, and location are required.' 
      });
    }

    // Prepare JSONB fields and numeric fields
    const skillsJson = required_skills && required_skills.length > 0 ? JSON.stringify(required_skills) : null;
    const benefitsJson = benefits && benefits.length > 0 ? JSON.stringify(benefits) : null;
    const salaryMinNum = salary_min ? parseFloat(salary_min) : null;
    const salaryMaxNum = salary_max ? parseFloat(salary_max) : null;

    // Create job posting
    const result = await pool.query(`
      INSERT INTO jobs (
        company_id, title, description, requirements, required_skills, 
        benefits, location, employment_type, salary_min, salary_max, 
        is_active, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, NOW(), NOW())
      RETURNING *
    `, [
      companyId, 
      title, 
      description, 
      requirements || null, 
      skillsJson, 
      benefitsJson, 
      location, 
      employment_type, 
      salaryMinNum, 
      salaryMaxNum
    ]);

    res.status(201).json({
      success: true,
      message: 'Job posting created successfully',
      job: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating job:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error creating job posting',
      error: error.message 
    });
  }
});

// @route   PUT /api/jobs/:id
// @desc    Update a job posting
// @access  Private (Company only - owner of the job)
router.put('/:id', protect, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify user is a company
    if (req.user.account_type !== 'company') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Only companies can update job postings.' 
      });
    }

    // Get company_id for this user
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Company profile not found.' 
      });
    }

    const companyId = companyResult.rows[0].id;

    // Verify job belongs to this company
    const jobCheck = await pool.query(
      'SELECT id FROM jobs WHERE id = $1 AND company_id = $2',
      [id, companyId]
    );

    if (jobCheck.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Job not found or you do not have permission to update it.' 
      });
    }

    const { 
      title, 
      description, 
      requirements, 
      required_skills, 
      benefits, 
      location, 
      employment_type, 
      salary_min, 
      salary_max,
      is_active
    } = req.body;

    // Update job posting
    const result = await pool.query(`
      UPDATE jobs 
      SET 
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        requirements = COALESCE($3, requirements),
        required_skills = COALESCE($4, required_skills),
        benefits = COALESCE($5, benefits),
        location = COALESCE($6, location),
        employment_type = COALESCE($7, employment_type),
        salary_min = COALESCE($8, salary_min),
        salary_max = COALESCE($9, salary_max),
        is_active = COALESCE($10, is_active),
        updated_at = NOW()
      WHERE id = $11 AND company_id = $12
      RETURNING *
    `, [
      title, 
      description, 
      requirements, 
      required_skills, 
      benefits, 
      location, 
      employment_type, 
      salary_min, 
      salary_max,
      is_active,
      id,
      companyId
    ]);

    res.json({
      success: true,
      message: 'Job posting updated successfully',
      job: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating job:', error);
    res.status(500).json({ success: false, message: 'Error updating job posting' });
  }
});

// @route   DELETE /api/jobs/:id
// @desc    Delete a job posting
// @access  Private (Company only - owner of the job)
router.delete('/:id', protect, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify user is a company
    if (req.user.account_type !== 'company') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Only companies can delete job postings.' 
      });
    }

    // Get company_id for this user
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Company profile not found.' 
      });
    }

    const companyId = companyResult.rows[0].id;

    // Verify job belongs to this company
    const jobCheck = await pool.query(
      'SELECT id FROM jobs WHERE id = $1 AND company_id = $2',
      [id, companyId]
    );

    if (jobCheck.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Job not found or you do not have permission to delete it.' 
      });
    }

    // Delete the job (this will cascade delete applications and views)
    await pool.query('DELETE FROM jobs WHERE id = $1 AND company_id = $2', [id, companyId]);

    res.json({
      success: true,
      message: 'Job posting deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting job:', error);
    res.status(500).json({ success: false, message: 'Error deleting job posting' });
  }
});

// Get all jobs
router.get('/', async (req, res) => {
  try {
    const { search, location, type } = req.query;
    const userId = req.user?.id; // Get user ID if authenticated
    
    const params = [];
    let paramIndex = 0;
    
    let query = `
      SELECT 
        j.*,
        c.name as company,
        c.logo_url as "companyLogo",
        c.is_verified as "companyVerified",
        c.slug,
        COALESCE(app_count.count, 0) as "applicationsCount",
        COALESCE(view_count.count, 0) as "viewsCount"
    `;
    
    // Add hasApplied check if user is authenticated
    if (userId) {
      params.push(userId);
      paramIndex++;
      query += `, EXISTS(SELECT 1 FROM job_applications WHERE job_id = j.id AND user_id = $${paramIndex}) as "hasApplied"`;
    } else {
      query += `, false as "hasApplied"`;
    }
    
    query += `
      FROM jobs j
      JOIN companies c ON j.company_id = c.id
      LEFT JOIN (
        SELECT job_id, COUNT(*) as count
        FROM job_applications
        GROUP BY job_id
      ) app_count ON j.id = app_count.job_id
      LEFT JOIN (
        SELECT job_id, COUNT(*) as count
        FROM job_views
        GROUP BY job_id
      ) view_count ON j.id = view_count.job_id
      WHERE j.is_active = true
    `;
    
    if (search && search.trim()) {
      // Full-text search across title, description, and company name
      params.push(`%${search.trim()}%`);
      paramIndex++;
      query += ` AND (
        j.title ILIKE $${paramIndex} OR 
        j.description ILIKE $${paramIndex} OR 
        c.name ILIKE $${paramIndex} OR
        j.location ILIKE $${paramIndex}
      )`;
    }
    
    if (location && location.trim()) {
      params.push(`%${location.trim()}%`);
      paramIndex++;
      query += ` AND j.location ILIKE $${paramIndex}`;
    }
    
    if (type && type.trim()) {
      params.push(type.trim());
      paramIndex++;
      query += ` AND j.employment_type = $${paramIndex}`;
    }
    
    query += ` ORDER BY j.created_at DESC`;
    
    const result = await pool.query(query, params);
    
    res.json({ 
      success: true, 
      jobs: result.rows.map(job => ({
        ...job,
        postedAt: job.created_at,
        salaryMin: job.salary_min,
        salaryMax: job.salary_max,
        employmentType: job.employment_type,
        requiredSkills: job.required_skills || [],
        applicationsCount: parseInt(job.applicationsCount) || 0,
        viewsCount: parseInt(job.viewsCount) || 0
      }))
    });
  } catch (error) {
    console.error('Error fetching jobs:', error);
    res.status(500).json({ success: false, message: 'Error fetching jobs' });
  }
});

// @route   GET /api/jobs/company/applicants
// @desc    Get all applicants for company's jobs
// @access  Private (Company only)
router.get('/company/applicants', protect, async (req, res) => {
  try {
    // Verify user is a company
    if (req.user.account_type !== 'company') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Only companies can access applicants.' 
      });
    }

    // Get company_id for this user
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Company profile not found.' 
      });
    }

    const companyId = companyResult.rows[0].id;
    const { job_id, status } = req.query;

    let query = `
      SELECT 
        ja.id,
        ja.job_id,
        ja.status,
        ja.applied_at,
        ja.updated_at,
        ja.cover_letter,
        ja.resume_url,
        j.title as job_title,
        j.id as job_id,
        u.id as user_id,
        u.email as candidate_email,
        c.full_name as candidate_name,
        c.phone as candidate_phone,
        c.linkedin_url as candidate_linkedin
      FROM job_applications ja
      JOIN jobs j ON ja.job_id = j.id
      JOIN users u ON ja.user_id = u.id
      LEFT JOIN candidates c ON ja.candidate_id = c.id
      WHERE j.company_id = $1
    `;

    const params = [companyId];
    let paramIndex = 1;

    if (job_id) {
      paramIndex++;
      query += ` AND ja.job_id = $${paramIndex}`;
      params.push(job_id);
    }

    if (status) {
      paramIndex++;
      query += ` AND ja.status = $${paramIndex}`;
      params.push(status);
    }

    query += ` ORDER BY ja.applied_at DESC`;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      applicants: result.rows.map(app => ({
        id: app.id,
        job_id: app.job_id,
        job_title: app.job_title,
        status: app.status,
        applied_at: app.applied_at,
        updated_at: app.updated_at,
        cover_letter: app.cover_letter,
        resume_url: app.resume_url,
        candidate_name: app.candidate_name || 'N/A',
        candidate_email: app.candidate_email,
        candidate_phone: app.candidate_phone || 'N/A',
        candidate_linkedin: app.candidate_linkedin || ''
      }))
    });
  } catch (error) {
    console.error('Error fetching applicants:', error);
    res.status(500).json({ success: false, message: 'Error fetching applicants' });
  }
});

// @route   PUT /api/jobs/applications/:applicationId/status
// @desc    Update application status (accept/reject/reviewing)
// @access  Private (Company only - owner of the job)
router.put('/applications/:applicationId/status', protect, async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { status, notes } = req.body;

    // Verify user is a company
    if (req.user.account_type !== 'company') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Only companies can update application status.' 
      });
    }

    // Validate status
    const validStatuses = ['pending', 'reviewing', 'interviewed', 'offered', 'accepted', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` 
      });
    }

    // Get company_id for this user
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Company profile not found.' 
      });
    }

    const companyId = companyResult.rows[0].id;

    // Verify the application belongs to a job owned by this company
    const checkResult = await pool.query(`
      SELECT ja.id 
      FROM job_applications ja
      JOIN jobs j ON ja.job_id = j.id
      WHERE ja.id = $1 AND j.company_id = $2
    `, [applicationId, companyId]);

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Application not found or you do not have permission to update it.' 
      });
    }

    // Update the application status
    const result = await pool.query(`
      UPDATE job_applications 
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [status, applicationId]);

    res.json({
      success: true,
      message: `Application status updated to ${status}`,
      application: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating application status:', error);
    res.status(500).json({ success: false, message: 'Error updating application status' });
  }
});

// Get all applications for the logged-in user (MUST be before /:id route)
router.get('/applications/my-applications', protect, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await pool.query(`
      SELECT 
        ja.*,
        j.title as job_title,
        j.location as job_location,
        j.employment_type as job_employment_type,
        j.salary_min as job_salary_min,
        j.salary_max as job_salary_max,
        c.name as company_name,
        c.logo_url as company_logo,
        c.slug as company_slug
      FROM job_applications ja
      JOIN jobs j ON ja.job_id = j.id
      JOIN companies c ON j.company_id = c.id
      WHERE ja.user_id = $1
      ORDER BY ja.applied_at DESC
    `, [userId]);
    
    const applications = result.rows.map(app => ({
      id: app.id,
      jobId: app.job_id,
      status: app.status,
      appliedAt: app.applied_at,
      updatedAt: app.updated_at,
      coverLetter: app.cover_letter,
      resumeUrl: app.resume_url,
      job: {
        title: app.job_title,
        location: app.job_location,
        employmentType: app.job_employment_type,
        salaryMin: app.job_salary_min,
        salaryMax: app.job_salary_max,
        company: app.company_name,
        logo: app.company_logo,
        slug: app.company_slug
      }
    }));
    
    res.json({ 
      success: true, 
      applications 
    });
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({ success: false, message: 'Error fetching applications' });
  }
});

// Get single job
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT 
        j.*,
        c.name as company,
        c.logo_url as "companyLogo",
        c.is_verified as "companyVerified",
        c.slug,
        c.description as "companyDescription",
        c.website as "companyWebsite",
        (SELECT COUNT(*) FROM job_applications WHERE job_id = j.id) as "applicationsCount",
        (SELECT COUNT(*) FROM job_views WHERE job_id = j.id) as "viewsCount"
      FROM jobs j
      JOIN companies c ON j.company_id = c.id
      WHERE j.id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    
    const job = result.rows[0];
    
    // Track view automatically if user is authenticated (limit to once per day per user per job)
    const userId = req.user?.id;
    if (userId) {
      try {
        // Check if user already viewed this job today
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        
        const existingView = await pool.query(`
          SELECT id FROM job_views 
          WHERE job_id = $1 AND user_id = $2 AND viewed_at >= $3
        `, [id, userId, todayStart]);
        
        if (existingView.rows.length === 0) {
          await pool.query(`
            INSERT INTO job_views (job_id, user_id, ip_address, user_agent)
            VALUES ($1, $2, $3, $4)
          `, [id, userId, req.ip, req.get('user-agent')]);
        }
      } catch (viewError) {
        // Silently fail view tracking - don't block the request
        console.error('Error tracking view:', viewError);
      }
    }
    
    res.json({ 
      success: true, 
      job: {
        ...job,
        postedAt: job.created_at,
        salaryMin: job.salary_min,
        salaryMax: job.salary_max,
        employmentType: job.employment_type,
        requiredSkills: job.required_skills || [],
        benefits: job.benefits || [],
        applicationsCount: parseInt(job.applicationsCount) || 0,
        viewsCount: parseInt(job.viewsCount) || 0
      }
    });
  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({ success: false, message: 'Error fetching job' });
  }
});

// Apply to a job
router.post('/:id/apply', protect, async (req, res) => {
  try {
    const { id } = req.params;
    const { coverLetter, resumeUrl } = req.body;
    const userId = req.user.id;
    
    // Verify user is a candidate (companies cannot apply to jobs)
    if (req.user.account_type !== 'candidate') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Only candidates can apply to jobs.' 
      });
    }
    
    // Check if job exists
    const jobCheck = await pool.query('SELECT id FROM jobs WHERE id = $1 AND is_active = true', [id]);
    if (jobCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    
    // Check if already applied
    const existingApp = await pool.query(
      'SELECT id FROM job_applications WHERE job_id = $1 AND user_id = $2',
      [id, userId]
    );
    
    if (existingApp.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'You have already applied to this job' });
    }
    
    // Get candidate_id if user has a candidate profile
    const candidateResult = await pool.query('SELECT id FROM candidates WHERE user_id = $1', [userId]);
    const candidateId = candidateResult.rows.length > 0 ? candidateResult.rows[0].id : null;
    
    // Create application
    const result = await pool.query(`
      INSERT INTO job_applications (job_id, candidate_id, user_id, cover_letter, resume_url, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING *
    `, [id, candidateId, userId, coverLetter, resumeUrl]);
    
    res.json({ 
      success: true, 
      message: 'Application submitted successfully',
      application: result.rows[0]
    });
  } catch (error) {
    console.error('Error applying to job:', error);
    res.status(500).json({ success: false, message: 'Error submitting application' });
  }
});

// Check if user has applied to a job
router.get('/:id/application-status', protect, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    const result = await pool.query(
      'SELECT status, applied_at FROM job_applications WHERE job_id = $1 AND user_id = $2',
      [id, userId]
    );
    
    if (result.rows.length === 0) {
      return res.json({ success: true, hasApplied: false });
    }
    
    res.json({ 
      success: true, 
      hasApplied: true,
      status: result.rows[0].status,
      appliedAt: result.rows[0].applied_at
    });
  } catch (error) {
    console.error('Error checking application status:', error);
    res.status(500).json({ success: false, message: 'Error checking application status' });
  }
});

// Withdraw application
router.delete('/applications/:applicationId/withdraw', protect, async (req, res) => {
  try {
    const { applicationId } = req.params;
    const userId = req.user.id;
    
    // Check if application exists and belongs to user
    const checkResult = await pool.query(
      'SELECT id, status FROM job_applications WHERE id = $1 AND user_id = $2',
      [applicationId, userId]
    );
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }
    
    const currentStatus = checkResult.rows[0].status;
    
    // Don't allow withdrawal of already withdrawn or rejected applications
    if (currentStatus === 'withdrawn' || currentStatus === 'rejected') {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot withdraw application with status: ${currentStatus}` 
      });
    }
    
    // Update status to withdrawn
    const result = await pool.query(
      `UPDATE job_applications 
       SET status = 'withdrawn', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND user_id = $2 
       RETURNING *`,
      [applicationId, userId]
    );
    
    res.json({ 
      success: true, 
      message: 'Application withdrawn successfully',
      application: result.rows[0]
    });
  } catch (error) {
    console.error('Error withdrawing application:', error);
    res.status(500).json({ success: false, message: 'Error withdrawing application' });
  }
});

// Get single application detail
router.get('/applications/:applicationId', protect, async (req, res) => {
  try {
    const { applicationId } = req.params;
    const userId = req.user.id;
    
    const result = await pool.query(`
      SELECT 
        ja.*,
        j.title as job_title,
        j.description as job_description,
        j.location as job_location,
        j.employment_type as job_employment_type,
        j.salary_min as job_salary_min,
        j.salary_max as job_salary_max,
        j.requirements as job_requirements,
        c.name as company_name,
        c.logo_url as company_logo,
        c.slug as company_slug,
        c.description as company_description,
        c.website as company_website
      FROM job_applications ja
      JOIN jobs j ON ja.job_id = j.id
      JOIN companies c ON j.company_id = c.id
      WHERE ja.id = $1 AND ja.user_id = $2
    `, [applicationId, userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }
    
    const app = result.rows[0];
    
    res.json({ 
      success: true, 
      application: {
        id: app.id,
        jobId: app.job_id,
        status: app.status,
        appliedAt: app.applied_at,
        updatedAt: app.updated_at,
        coverLetter: app.cover_letter,
        resumeUrl: app.resume_url,
        job: {
          title: app.job_title,
          description: app.job_description,
          location: app.job_location,
          employmentType: app.job_employment_type,
          salaryMin: app.job_salary_min,
          salaryMax: app.job_salary_max,
          requirements: app.job_requirements,
          company: app.company_name,
          logo: app.company_logo,
          slug: app.company_slug,
          description: app.company_description,
          website: app.company_website
        }
      }
    });
  } catch (error) {
    console.error('Error fetching application:', error);
    res.status(500).json({ success: false, message: 'Error fetching application' });
  }
});

export default router;
