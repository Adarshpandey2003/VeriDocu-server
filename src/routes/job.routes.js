import express from 'express';
import { protect } from '../middleware/auth.js';
import pool from '../config/database.js';
import { deleteFromBucket, BUCKET_NAME, createSignedUrl } from '../utils/supabaseStorage.js';

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

    // Debug logging removed to keep logs clean in production

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
      // companyId may be a UUID string; do not coerce to integer.
      params.push(companyId);
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

  // Removed verbose result count log

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

    // NOTE: Removed accidental logging that referenced out-of-scope variables
    // (previously attempted to log `app`, `skills`, `experiences`, etc.)
    // Keeping this placeholder comment in case we want to add safe logging later.

    // Convert any company logo storage paths to signed URLs when possible
    const jobsWithLogos = await Promise.all(result.rows.map(async (j) => {
      const jobCopy = { ...j };
      try {
        if (jobCopy.companyLogo) {
          const signed = await createSignedUrl(BUCKET_NAME, jobCopy.companyLogo, 3600);
          jobCopy.companyLogo = signed.data?.signedUrl || jobCopy.companyLogo;
        }
      } catch (err) {
        console.warn('Failed to create signed URL for company logo:', err);
      }
      return jobCopy;
    }));

    res.json({
      success: true,
      jobs: jobsWithLogos,
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
        ,
        application_form: job.application_form || null,
        resume_required: job.resume_required || false
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
      salary_max,
      application_form,
      resume_required
    } = req.body;

    // Removed verbose creation log

    // Validate required fields
    if (!title || !description || !location) {
      return res.status(400).json({ 
        success: false, 
        message: 'Title, description, and location are required.' 
      });
    }

  // Prepare fields for insertion
  // required_skills and benefits are Postgres TEXT[] columns, so pass JS arrays directly (not JSON strings)
  const skillsArray = required_skills && Array.isArray(required_skills) && required_skills.length > 0 ? required_skills : null;
  const benefitsArray = benefits && Array.isArray(benefits) && benefits.length > 0 ? benefits : null;
  const applicationFormJson = application_form ? JSON.stringify(application_form) : null;
    const salaryMinNum = salary_min ? parseFloat(salary_min) : null;
    const salaryMaxNum = salary_max ? parseFloat(salary_max) : null;

    // Create job posting
    const result = await pool.query(`
      INSERT INTO jobs (
        company_id, title, description, requirements, required_skills, 
        benefits, location, employment_type, salary_min, salary_max, application_form, resume_required,
        is_active, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, NOW(), NOW())
      RETURNING *
    `, [
        companyId, 
        title, 
        description, 
        requirements || null, 
        skillsArray, 
        benefitsArray, 
      location, 
      employment_type, 
      salaryMinNum, 
      salaryMaxNum,
      applicationFormJson,
      resume_required ?? false
    ]);
    const createdJob = result.rows[0];

    // After creating a job, notify matching candidates based on skills or title
    try {
      // Prepare match criteria
      const jobSkills = createdJob.required_skills || [];
      const title = createdJob.title || '';

      // Build title keyword patterns (ignore short words)
      const tokens = title
        .split(/\W+/)
        .map(t => t.trim())
        .filter(t => t.length >= 3);

      const titlePatterns = tokens.length > 0 ? tokens.map(t => `%${t}%`) : [];

      // Only run candidate matching when we have at least one skill or title token
      if ((Array.isArray(jobSkills) && jobSkills.length > 0) || titlePatterns.length > 0) {
        // Insert notifications for matching candidates (use candidates.user_id)
        const insertQuery = `
          INSERT INTO notifications (user_id, type, title, message, link, is_read)
          SELECT user_id, 'job', $1, $2, $3, false
          FROM candidates
          WHERE is_public = true
            AND (
              ($4::text[] IS NOT NULL AND array_length($4::text[], 1) > 0 AND (skills && $4::text[]))
              OR
              ($5::text[] IS NOT NULL AND array_length($5::text[], 1) > 0 AND (title ILIKE ANY ($5::text[])))
            )
        `;

        const notifTitle = `New job: ${createdJob.title}`;
        const notifMessage = `A new job was posted that matches your profile: ${createdJob.title} at ${createdJob.location || 'remote'}`;
        const notifLink = `/jobs/${createdJob.id}`;

        await pool.query(insertQuery, [notifTitle, notifMessage, notifLink, jobSkills, titlePatterns]);
      }
    } catch (notifyErr) {
      console.warn('Failed to create notifications for new job:', notifyErr);
    }

    res.status(201).json({
      success: true,
      message: 'Job posting created successfully',
      job: createdJob
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
      is_active,
      application_form,
      resume_required
    } = req.body;

    // Update job posting
    const applicationFormJsonUpdate = application_form ? JSON.stringify(application_form) : null;

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
        application_form = COALESCE($10, application_form),
        resume_required = COALESCE($11, resume_required),
        is_active = COALESCE($12, is_active),
        updated_at = NOW()
      WHERE id = $13 AND company_id = $14
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
      applicationFormJsonUpdate,
      resume_required,
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
    
    // convert company logos to signed urls for single-job list
    const rowsWithLogos = await Promise.all(result.rows.map(async (job) => {
      const j = { ...job };
      try {
        if (j.companyLogo) {
          const signed = await createSignedUrl(BUCKET_NAME, j.companyLogo, 3600);
          j.companyLogo = signed.data?.signedUrl || j.companyLogo;
        }
      } catch (err) {
        console.warn('Failed to create signed URL for company logo:', err);
      }
      return j;
    }));

    res.json({
      success: true,
      jobs: rowsWithLogos.map(job => ({
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
        AND ja.status != 'withdrawn'
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
        application_answers: app.application_answers || null,
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

// @route   GET /api/jobs/company/applicants/:applicationId
// @desc    Get a single application detail for a company (company must own the job)
// @access  Private (Company only)
router.get('/company/applicants/:applicationId', protect, async (req, res) => {
  try {
    if (req.user.account_type !== 'company') {
      return res.status(403).json({ success: false, message: 'Access denied. Only companies can access applicants.' });
    }

    const { applicationId } = req.params;

    // Get company_id for this user
    const companyResult = await pool.query(
      'SELECT id FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Company profile not found.' });
    }

    const companyId = companyResult.rows[0].id;

    // Fetch the application and ensure it belongs to a job owned by this company
    const result = await pool.query(`
      SELECT 
        ja.*, 
        j.title as job_title, 
        j.id as job_id,
        j.application_form as job_application_form,
        j.resume_required as job_resume_required,
        u.id as user_id,
        u.email as candidate_email,
        c.id as candidate_id,
        c.full_name as candidate_name,
        c.phone as candidate_phone,
        c.linkedin_url as candidate_linkedin,
        c.avatar_url as candidate_avatar,
        c.bio as candidate_bio
      FROM job_applications ja
      JOIN jobs j ON ja.job_id = j.id
      JOIN users u ON ja.user_id = u.id
      LEFT JOIN candidates c ON ja.candidate_id = c.id
      WHERE ja.id = $1 AND j.company_id = $2
      LIMIT 1
    `, [applicationId, companyId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Application not found or you do not have permission to view it.' });
    }

  const app = result.rows[0];

  // Generate signed URLs for avatar and resume if available
    let avatarSigned = null;
    let resumeSigned = null;
    try {
      if (app.candidate_avatar) {
        const av = await createSignedUrl(BUCKET_NAME, app.candidate_avatar, 3600);
        avatarSigned = av.data?.signedUrl || null;
      }
    } catch (err) {
      console.warn('Failed to create avatar signed URL:', err);
    }

    try {
      if (app.resume_url) {
        const rs = await createSignedUrl(BUCKET_NAME, app.resume_url, 3600);
        resumeSigned = rs.data?.signedUrl || null;
      }
    } catch (err) {
      console.warn('Failed to create resume signed URL:', err);
    }

    // If we have a candidate_id, fetch employment and education histories so
    // the company can view the full profile (companies are authorized above).
    let experiences = [];
    let educations = [];
    let skills = null;
    try {
      if (app.candidate_id) {
        const empRes = await pool.query(
          `SELECT id, company_name as company, position as job_title, location,
                  TO_CHAR(start_date, 'YYYY-MM') as start_month,
                  CASE WHEN is_current THEN NULL ELSE TO_CHAR(end_date, 'YYYY-MM') END as end_month,
                  is_current, description, verification_status
           FROM employment_history
           WHERE candidate_id = $1
           ORDER BY start_date DESC`,
          [app.candidate_id]
        );
        experiences = empRes.rows;

        const edRes = await pool.query(
          `SELECT id, institution, degree, field_of_study, 
                  TO_CHAR(start_date, 'YYYY-MM') as start_month,
                  CASE WHEN is_current THEN NULL ELSE TO_CHAR(end_date, 'YYYY-MM') END as end_month,
                  is_current, description, verification_status
           FROM education_history
           WHERE candidate_id = $1
           ORDER BY start_date DESC`,
          [app.candidate_id]
        );
        educations = edRes.rows;

        const skillsRes = await pool.query('SELECT skills FROM candidates WHERE id = $1', [app.candidate_id]);
        skills = skillsRes.rows[0]?.skills || null;
      }
    } catch (err) {
      console.warn('Failed to fetch candidate histories:', err);
    }

    res.json({
      success: true,
      application: {
        id: app.id,
        jobId: app.job_id,
        jobTitle: app.job_title,
        status: app.status,
        appliedAt: app.applied_at,
        updatedAt: app.updated_at,
        coverLetter: app.cover_letter,
        resumeUrl: resumeSigned || app.resume_url,
        applicationAnswers: app.application_answers || null,
        // include job metadata so client can resolve question ids (application form)
        job: {
          id: app.job_id,
          title: app.job_title,
          applicationForm: app.job_application_form || app.application_form || null,
          resumeRequired: app.job_resume_required || false
        },
        candidate: {
          id: app.candidate_id,
          userId: app.user_id,
          name: app.candidate_name,
          email: app.candidate_email,
          phone: app.candidate_phone,
          linkedin: app.candidate_linkedin,
          avatar: avatarSigned || app.candidate_avatar,
          bio: app.candidate_bio,
          skills: skills,
          experiences: experiences,
          educations: educations
        }
      }
    });
  } catch (error) {
    console.error('Error fetching application for company:', error);
    res.status(500).json({ success: false, message: 'Error fetching application' });
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

    // NOTE: Do not hard-code the allowed statuses here because the
    // database enforces a check constraint. We'll attempt the update and
    // surface any DB constraint errors to the client with a helpful message.

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

    // Fetch current resume_url for possible deletion if changing to a terminal status
    const appFetch = await pool.query('SELECT resume_url, status FROM job_applications WHERE id = $1', [applicationId]);
    const currentResume = appFetch.rows[0]?.resume_url || null;
    const previousStatus = appFetch.rows[0]?.status || null;

  // If status is being set to 'rejected', attempt to delete resume and null the column
  if (status === 'rejected' && currentResume) {
      try {
        const del = await deleteFromBucket(BUCKET_NAME, currentResume);
        if (del.error) console.warn('Failed to delete resume on rejection:', del.error);
      } catch (err) {
        console.error('Error deleting resume on rejection:', err);
      }

      // Update status and clear resume_url
      try {
        const result = await pool.query(`
          UPDATE job_applications 
          SET status = $1, resume_url = NULL, updated_at = NOW()
          WHERE id = $2
          RETURNING *
        `, [status, applicationId]);

        return res.json({
          success: true,
          message: `Application status updated to ${status}`,
          application: result.rows[0]
        });
      } catch (dbErr) {
        // Handle DB check constraint violations (e.g. invalid status value)
        if (dbErr && dbErr.code === '23514') {
          console.warn('Constraint violation updating status:', dbErr.detail || dbErr.message);
          return res.status(400).json({ success: false, message: dbErr.detail || 'Invalid status value (DB constraint).' });
        }
        throw dbErr;
      }
    }

    // Otherwise, perform a normal status update
    try {
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
    } catch (dbErr) {
      if (dbErr && dbErr.code === '23514') {
        console.warn('Constraint violation updating status:', dbErr.detail || dbErr.message);
        return res.status(400).json({ success: false, message: dbErr.detail || 'Invalid status value (DB constraint).' });
      }
      throw dbErr;
    }
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
      applicationAnswers: app.application_answers || null,
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
    
    // If company logo is stored as a bucket path, convert to signed URL for client
    try {
      if (job.companyLogo) {
        const signed = await createSignedUrl(BUCKET_NAME, job.companyLogo, 3600);
        job.companyLogo = signed.data?.signedUrl || job.companyLogo;
      }
    } catch (err) {
      console.warn('Failed to create signed URL for company logo:', err);
    }

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
        applicationForm: job.application_form || null,
        resumeRequired: job.resume_required || false,
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
    const { coverLetter, resumeUrl, applicationAnswers } = req.body;
    const userId = req.user.id;
    
    // Verify user is a candidate (companies cannot apply to jobs)
    if (req.user.account_type !== 'candidate') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Only candidates can apply to jobs.' 
      });
    }
    
    // Check if job exists and get application form / resume flag
    const jobRes = await pool.query('SELECT id, application_form, resume_required FROM jobs WHERE id = $1 AND is_active = true', [id]);
    if (jobRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    const jobRow = jobRes.rows[0];

    // Enforce resume requirement server-side when the job requires it
    if (jobRow.resume_required && (!resumeUrl || String(resumeUrl).trim() === '')) {
      return res.status(400).json({ success: false, message: 'This job requires a resume. Please upload a resume before applying.' });
    }
    
    // Check if an active (non-withdrawn) application exists
    // Allow re-apply only if the previous application was withdrawn
    const existingActiveApp = await pool.query(
      "SELECT id FROM job_applications WHERE job_id = $1 AND user_id = $2 AND status != 'withdrawn'",
      [id, userId]
    );

    if (existingActiveApp.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'You have already applied to this job' });
    }
    
    // Get candidate_id if user has a candidate profile
    const candidateResult = await pool.query('SELECT id FROM candidates WHERE user_id = $1', [userId]);
    const candidateId = candidateResult.rows.length > 0 ? candidateResult.rows[0].id : null;
    
    // Prepare application answers JSON if provided
    const applicationAnswersJson = applicationAnswers ? JSON.stringify(applicationAnswers) : null;

    // Create application (store application answers if provided)
    const result = await pool.query(`
      INSERT INTO job_applications (job_id, candidate_id, user_id, cover_letter, application_answers, resume_url, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      RETURNING *
    `, [id, candidateId, userId, coverLetter, applicationAnswersJson, resumeUrl]);
    
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
    
      // Get the most recent application for this user & job
      const result = await pool.query(
        'SELECT status, applied_at FROM job_applications WHERE job_id = $1 AND user_id = $2 ORDER BY applied_at DESC LIMIT 1',
        [id, userId]
      );

      if (result.rows.length === 0) {
        return res.json({ success: true, hasApplied: false });
      }

      const latest = result.rows[0];

      // Treat a latest status of 'withdrawn' as not having an active application
      if (latest.status === 'withdrawn') {
        return res.json({ success: true, hasApplied: false });
      }

      res.json({ 
        success: true, 
        hasApplied: true,
        status: latest.status,
        appliedAt: latest.applied_at
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
    
    // Check if application exists and belongs to user (also get resume_url)
    const checkResult = await pool.query(
      'SELECT id, status, resume_url FROM job_applications WHERE id = $1 AND user_id = $2',
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
    
    // If a resume URL exists for this application, attempt to delete it from storage
    const resumePath = checkResult.rows[0].resume_url;
    if (resumePath) {
      try {
        const del = await deleteFromBucket(BUCKET_NAME, resumePath);
        if (del.error) {
          console.warn('Failed to delete resume from storage:', del.error);
        }
      } catch (err) {
        console.error('Error deleting resume from storage:', err);
      }
    }

    // Update status to withdrawn and null out resume_url
    const result = await pool.query(
      `UPDATE job_applications 
       SET status = 'withdrawn', resume_url = NULL, updated_at = CURRENT_TIMESTAMP 
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
        applicationAnswers: app.application_answers || null,
        job: {
          id: app.job_id,
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
