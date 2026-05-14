import express from 'express';
import pool from '../config/database.js';
import { protect } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { getJobAccess } from '../utils/jobAccess.js';
import { sendCollaboratorInvite } from '../utils/mailer.js';

const router = express.Router();

const VALID_ROLES = ['co_owner', 'recruiter', 'reviewer'];

// POST /api/jobs/:jobId/collaborators - invite a collaborator
router.post('/jobs/:jobId/collaborators', protect, async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { email, role = 'reviewer' } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return next(new AppError('Valid email required', 400));
    }
    if (!VALID_ROLES.includes(role)) {
      return next(new AppError('Invalid role', 400));
    }

    const access = await getJobAccess(req.user.id, jobId);
    if (!access.allowed || !access.perms.invite) {
      return next(new AppError('Only the owner can invite collaborators', 403));
    }

    // Check for existing invite
    const existing = await pool.query(
      'SELECT id, accepted_at, magic_token FROM job_collaborators WHERE job_id = $1 AND email = $2',
      [jobId, email.toLowerCase()]
    );

    let row;
    if (existing.rows.length > 0) {
      if (existing.rows[0].accepted_at) {
        return next(new AppError('That email has already accepted the invite', 409));
      }
      // Re-use existing pending invite
      row = existing.rows[0];
    } else {
      const ins = await pool.query(
        `INSERT INTO job_collaborators (job_id, email, role, invited_by_user_id)
         VALUES ($1, $2, $3, $4) RETURNING id, magic_token`,
        [jobId, email.toLowerCase(), role, req.user.id]
      );
      row = ins.rows[0];
    }

    // Gather job details for the email
    const jobRes = await pool.query(
      `SELECT j.title, c.name AS company_name
       FROM jobs j JOIN companies c ON j.company_id = c.id
       WHERE j.id = $1`,
      [jobId]
    );
    const job = jobRes.rows[0];
    const magicLink = `${process.env.CLIENT_URL || 'http://localhost:3000'}/invite/${row.magic_token}`;

    sendCollaboratorInvite({
      to: email,
      inviterName: req.user.name || req.user.email,
      companyName: job?.company_name || 'A company',
      jobTitle: job?.title || 'a position',
      role,
      magicLink,
    }).catch((err) => console.error('[Collaborator] email send error:', err.message));

    res.json({
      success: true,
      message: 'Invitation sent',
      collaboratorId: row.id,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:jobId/collaborators - list collaborators
router.get('/jobs/:jobId/collaborators', protect, async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const access = await getJobAccess(req.user.id, jobId);
    if (!access.allowed) {
      return next(new AppError('Not authorized', 403));
    }

    const result = await pool.query(
      `SELECT jc.id, jc.email, jc.role, jc.accepted_at, jc.created_at,
              u.id AS user_id, u.name AS user_name
       FROM job_collaborators jc
       LEFT JOIN users u ON jc.user_id = u.id
       WHERE jc.job_id = $1
       ORDER BY jc.created_at DESC`,
      [jobId]
    );

    res.json({
      success: true,
      collaborators: result.rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        status: r.accepted_at ? 'accepted' : 'pending',
        acceptedAt: r.accepted_at,
        invitedAt: r.created_at,
        userName: r.user_name || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/jobs/:jobId/collaborators/:id - remove a collaborator
router.delete('/jobs/:jobId/collaborators/:id', protect, async (req, res, next) => {
  try {
    const { jobId, id } = req.params;
    const access = await getJobAccess(req.user.id, jobId);
    if (!access.allowed || !access.perms.invite) {
      return next(new AppError('Only the owner can remove collaborators', 403));
    }
    await pool.query('DELETE FROM job_collaborators WHERE id = $1 AND job_id = $2', [id, jobId]);
    res.json({ success: true, message: 'Collaborator removed' });
  } catch (err) {
    next(err);
  }
});

// GET /api/invites/preview/:token - public, shows invite details
router.get('/invites/preview/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const result = await pool.query(
      `SELECT jc.id, jc.email, jc.role, jc.accepted_at,
              j.id AS job_id, j.title AS job_title, j.location,
              c.name AS company_name, c.logo_url,
              inviter.name AS inviter_name, inviter.email AS inviter_email
       FROM job_collaborators jc
       JOIN jobs j ON jc.job_id = j.id
       JOIN companies c ON j.company_id = c.id
       LEFT JOIN users inviter ON jc.invited_by_user_id = inviter.id
       WHERE jc.magic_token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return next(new AppError('Invalid invitation', 404));
    }
    const inv = result.rows[0];
    res.json({
      success: true,
      invite: {
        email: inv.email,
        role: inv.role,
        accepted: !!inv.accepted_at,
        jobId: inv.job_id,
        jobTitle: inv.job_title,
        jobLocation: inv.location,
        companyName: inv.company_name,
        inviterName: inv.inviter_name || inv.inviter_email,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/invites/accept/:token - authenticated user accepts
router.post('/invites/accept/:token', protect, async (req, res, next) => {
  try {
    const { token } = req.params;
    const result = await pool.query(
      'SELECT id, email, accepted_at, user_id FROM job_collaborators WHERE magic_token = $1',
      [token]
    );
    if (result.rows.length === 0) {
      return next(new AppError('Invalid invitation', 404));
    }
    const inv = result.rows[0];
    if (inv.accepted_at) {
      return res.json({ success: true, message: 'Already accepted', alreadyAccepted: true });
    }

    // Optional: enforce email match - we'll allow any logged-in user to accept,
    // but warn if email differs. Soft check for now.
    await pool.query(
      `UPDATE job_collaborators
       SET user_id = $1, accepted_at = NOW()
       WHERE id = $2`,
      [req.user.id, inv.id]
    );

    res.json({ success: true, message: 'Invitation accepted' });
  } catch (err) {
    next(err);
  }
});

export default router;
