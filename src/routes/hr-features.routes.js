// HR power features: AI resume screening, AI interview questions, bulk applicant actions, kanban pipeline.
import express from 'express';
import pool from '../config/database.js';
import { protect } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { screenResume, generateInterviewQuestions } from '../services/aiService.js';
import { getJobAccess } from '../utils/jobAccess.js';
import { sendApplicationStatusEmail } from '../utils/mailer.js';
import { BUCKET_NAME, createSignedUrl } from '../utils/supabaseStorage.js';

const router = express.Router();

const VALID_STATUSES = ['pending', 'reviewing', 'shortlisted', 'interviewing', 'offered', 'rejected', 'withdrawn'];

// Helper - build a resume text representation from candidate profile + resume_url
async function buildResumeText(applicationId) {
  const result = await pool.query(
    `SELECT
       ja.cover_letter, ja.resume_url, ja.application_answers,
       c.full_name, c.bio, c.skills, c.location,
       c.professional_title,
       j.title AS job_title, j.description AS job_description, j.required_skills
     FROM job_applications ja
     JOIN jobs j ON ja.job_id = j.id
     LEFT JOIN candidates c ON ja.candidate_id = c.id
     WHERE ja.id = $1`,
    [applicationId]
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];

  // Try to fetch employment + education history
  const empRes = await pool.query(
    `SELECT position, company_name, start_date, end_date, is_current, description
     FROM employment_history
     WHERE candidate_id = (SELECT candidate_id FROM job_applications WHERE id = $1)
     ORDER BY start_date DESC LIMIT 10`,
    [applicationId]
  );
  const eduRes = await pool.query(
    `SELECT degree, field_of_study, institution, start_date, end_date
     FROM education_history
     WHERE candidate_id = (SELECT candidate_id FROM job_applications WHERE id = $1)
     ORDER BY start_date DESC LIMIT 5`,
    [applicationId]
  );

  const parts = [
    r.full_name ? `Name: ${r.full_name}` : '',
    r.professional_title ? `Title: ${r.professional_title}` : '',
    r.location ? `Location: ${r.location}` : '',
    r.bio ? `\nBio:\n${r.bio}` : '',
    Array.isArray(r.skills) && r.skills.length ? `\nSkills: ${r.skills.join(', ')}` : '',
    empRes.rows.length ? '\nExperience:\n' + empRes.rows.map((e) =>
      `- ${e.position} at ${e.company_name} (${e.start_date}${e.is_current ? ' - Present' : e.end_date ? ' - ' + e.end_date : ''})${e.description ? '\n  ' + e.description : ''}`
    ).join('\n') : '',
    eduRes.rows.length ? '\nEducation:\n' + eduRes.rows.map((e) =>
      `- ${e.degree || ''} ${e.field_of_study || ''} @ ${e.institution}`
    ).join('\n') : '',
    r.cover_letter ? `\nCover Letter:\n${r.cover_letter}` : '',
  ].filter(Boolean);

  return {
    resumeText: parts.join('\n'),
    jobTitle: r.job_title,
    jobDescription: r.job_description,
    requiredSkills: r.required_skills || [],
  };
}

// POST /api/applications/:id/screen - manual AI screen trigger
router.post('/applications/:id/screen', protect, async (req, res, next) => {
  try {
    const { id } = req.params;
    // Authorize: company owner or collaborator on the job
    const appRes = await pool.query(
      `SELECT ja.id, ja.job_id, ja.ai_screened_at FROM job_applications ja WHERE ja.id = $1`,
      [id]
    );
    if (appRes.rows.length === 0) return next(new AppError('Application not found', 404));

    const access = await getJobAccess(req.user.id, appRes.rows[0].job_id);
    if (!access.allowed || !access.perms.manage_applicants) {
      return next(new AppError('Not authorized', 403));
    }

    const ctx = await buildResumeText(id);
    if (!ctx) return next(new AppError('Application not found', 404));

    let result;
    try {
      result = await screenResume(ctx);
    } catch (err) {
      console.error('[AI Screen] error:', err.message);
      return next(new AppError('AI screening failed: ' + err.message, 502));
    }

    await pool.query(
      `UPDATE job_applications
       SET ai_score = $1, ai_summary = $2, ai_strengths = $3, ai_concerns = $4, ai_screened_at = NOW()
       WHERE id = $5`,
      [result.score, result.summary, result.strengths, result.concerns, id]
    );

    res.json({ success: true, screening: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/applications/:id/interview-questions - generate AI questions
router.post('/applications/:id/interview-questions', protect, async (req, res, next) => {
  try {
    const { id } = req.params;
    const appRes = await pool.query(
      `SELECT ja.id, ja.job_id, ja.ai_interview_questions FROM job_applications ja WHERE ja.id = $1`,
      [id]
    );
    if (appRes.rows.length === 0) return next(new AppError('Application not found', 404));

    const access = await getJobAccess(req.user.id, appRes.rows[0].job_id);
    if (!access.allowed || !access.perms.manage_applicants) {
      return next(new AppError('Not authorized', 403));
    }

    // If cached and not regenerate, return cached
    if (appRes.rows[0].ai_interview_questions && !req.body.regenerate) {
      return res.json({ success: true, questions: appRes.rows[0].ai_interview_questions, cached: true });
    }

    const ctx = await buildResumeText(id);
    if (!ctx) return next(new AppError('Application not found', 404));

    let questions;
    try {
      questions = await generateInterviewQuestions(ctx);
    } catch (err) {
      console.error('[AI Interview Q] error:', err.message);
      return next(new AppError('Failed to generate questions: ' + err.message, 502));
    }

    await pool.query(
      'UPDATE job_applications SET ai_interview_questions = $1 WHERE id = $2',
      [questions, id]
    );

    res.json({ success: true, questions, cached: false });
  } catch (err) {
    next(err);
  }
});

// PUT /api/applications/bulk-status - bulk status update
router.put('/applications/bulk-status', protect, async (req, res, next) => {
  try {
    const { applicationIds, status, sendEmail = false, customMessage } = req.body;
    if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
      return next(new AppError('applicationIds required', 400));
    }
    if (!VALID_STATUSES.includes(status)) {
      return next(new AppError('Invalid status', 400));
    }

    // Authorize: every application must belong to a job the user can manage
    const checkRes = await pool.query(
      `SELECT DISTINCT ja.id, ja.job_id, j.title AS job_title,
              c.name AS company_name,
              u.email AS candidate_email, ca.full_name AS candidate_name
       FROM job_applications ja
       JOIN jobs j ON ja.job_id = j.id
       JOIN companies c ON j.company_id = c.id
       JOIN users u ON ja.user_id = u.id
       LEFT JOIN candidates ca ON ja.candidate_id = ca.id
       WHERE ja.id = ANY($1::uuid[])`,
      [applicationIds]
    );

    if (checkRes.rows.length === 0) {
      return next(new AppError('No matching applications', 404));
    }

    // Check access per unique job
    const jobIds = [...new Set(checkRes.rows.map((r) => r.job_id))];
    for (const jobId of jobIds) {
      const access = await getJobAccess(req.user.id, jobId);
      if (!access.allowed || !access.perms.manage_applicants) {
        return next(new AppError('Not authorized for one or more applications', 403));
      }
    }

    const validIds = checkRes.rows.map((r) => r.id);
    await pool.query(
      `UPDATE job_applications SET status = $1, updated_at = NOW() WHERE id = ANY($2::uuid[])`,
      [status, validIds]
    );

    // Send emails async
    let emailsSent = 0;
    if (sendEmail && ['rejected', 'shortlisted', 'reviewing'].includes(status)) {
      for (const row of checkRes.rows) {
        sendApplicationStatusEmail({
          to: row.candidate_email,
          candidateName: row.candidate_name,
          companyName: row.company_name,
          jobTitle: row.job_title,
          status,
          customMessage,
        }).catch((err) => console.error('[BulkStatus] email error:', err.message));
        emailsSent += 1;
      }
    }

    res.json({
      success: true,
      updated: validIds.length,
      emailsSent,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:jobId/pipeline - kanban pipeline view
router.get('/jobs/:jobId/pipeline', protect, async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const access = await getJobAccess(req.user.id, jobId);
    if (!access.allowed) return next(new AppError('Not authorized', 403));

    const result = await pool.query(
      `SELECT
         ja.id, ja.status, ja.applied_at, ja.updated_at,
         ja.ai_score, ja.ai_summary,
         u.email AS candidate_email,
         c.id AS candidate_id, c.full_name AS candidate_name,
         c.avatar_url AS candidate_avatar, c.professional_title
       FROM job_applications ja
       JOIN users u ON ja.user_id = u.id
       LEFT JOIN candidates c ON ja.candidate_id = c.id
       WHERE ja.job_id = $1
       ORDER BY ja.applied_at DESC`,
      [jobId]
    );

    // Sign avatar URLs
    const signed = await Promise.all(result.rows.map(async (row) => {
      let avatarUrl = row.candidate_avatar;
      if (avatarUrl) {
        try {
          let path = avatarUrl;
          const m = avatarUrl.match(/\/object\/(?:sign|public)\/[^/]+\/(.+?)(?:\?|$)/);
          if (m && m[1]) path = decodeURIComponent(m[1]);
          else if (avatarUrl.includes('/VeriBoard_bucket/')) path = avatarUrl.split('/VeriBoard_bucket/')[1];
          const { data } = await createSignedUrl(BUCKET_NAME, path, 3600);
          if (data?.signedUrl) avatarUrl = data.signedUrl;
        } catch {}
      }
      return {
        id: row.id,
        status: row.status,
        appliedAt: row.applied_at,
        updatedAt: row.updated_at,
        aiScore: row.ai_score,
        aiSummary: row.ai_summary,
        candidateId: row.candidate_id,
        candidateName: row.candidate_name || row.candidate_email.split('@')[0],
        candidateAvatar: avatarUrl,
        candidateTitle: row.professional_title,
      };
    }));

    const grouped = { pending: [], reviewing: [], shortlisted: [], interviewing: [], offered: [], rejected: [] };
    for (const card of signed) {
      if (grouped[card.status]) grouped[card.status].push(card);
    }
    res.json({ success: true, pipeline: grouped, total: signed.length });
  } catch (err) {
    next(err);
  }
});

export default router;
