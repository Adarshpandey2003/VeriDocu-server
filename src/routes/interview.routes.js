import express from 'express';
import pool from '../config/database.js';
import { protect } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { getJobAccess } from '../utils/jobAccess.js';
import { sendInterviewInvite, sendInterviewConfirmation } from '../utils/mailer.js';
import { generateICS } from '../utils/ics.js';

const router = express.Router();

const VALID_MODES = ['video', 'phone', 'in_person'];

// POST /api/interviews - company creates interview invite with proposed slots
router.post('/', protect, async (req, res, next) => {
  try {
    const { applicationId, proposedSlots, mode, meetingLink, location, notes } = req.body;

    if (!applicationId || !Array.isArray(proposedSlots) || proposedSlots.length === 0) {
      return next(new AppError('applicationId and at least one proposed slot required', 400));
    }
    if (!VALID_MODES.includes(mode)) {
      return next(new AppError('Invalid mode', 400));
    }
    if (proposedSlots.length > 5) {
      return next(new AppError('Maximum 5 slots allowed', 400));
    }

    // Validate slot shapes
    for (const slot of proposedSlots) {
      if (!slot.startsAt || !slot.endsAt) {
        return next(new AppError('Each slot needs startsAt and endsAt', 400));
      }
      if (new Date(slot.startsAt) <= new Date()) {
        return next(new AppError('Slots must be in the future', 400));
      }
    }

    // Authorize via job access
    const appRes = await pool.query(
      `SELECT ja.id, ja.job_id, ja.user_id,
              j.title AS job_title, c.name AS company_name,
              u.email AS candidate_email, ca.full_name AS candidate_name
       FROM job_applications ja
       JOIN jobs j ON ja.job_id = j.id
       JOIN companies c ON j.company_id = c.id
       JOIN users u ON ja.user_id = u.id
       LEFT JOIN candidates ca ON ja.candidate_id = ca.id
       WHERE ja.id = $1`,
      [applicationId]
    );
    if (appRes.rows.length === 0) return next(new AppError('Application not found', 404));
    const app = appRes.rows[0];

    const access = await getJobAccess(req.user.id, app.job_id);
    if (!access.allowed || !access.perms.manage_applicants) {
      return next(new AppError('Not authorized', 403));
    }

    // Cancel previous pending invites for this app
    await pool.query(
      `UPDATE interview_invites SET status = 'cancelled', updated_at = NOW()
       WHERE application_id = $1 AND status = 'pending'`,
      [applicationId]
    );

    const ins = await pool.query(
      `INSERT INTO interview_invites
         (application_id, proposed_slots, mode, meeting_link, location, notes, created_by_user_id)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)
       RETURNING id, magic_token`,
      [applicationId, JSON.stringify(proposedSlots), mode, meetingLink || null, location || null, notes || null, req.user.id]
    );

    // Advance application status to interviewing
    await pool.query(
      `UPDATE job_applications SET status = 'interviewing', updated_at = NOW() WHERE id = $1`,
      [applicationId]
    );

    const magicLink = `${process.env.CLIENT_URL || 'http://localhost:3000'}/interview/${ins.rows[0].magic_token}`;
    sendInterviewInvite({
      to: app.candidate_email,
      candidateName: app.candidate_name,
      companyName: app.company_name,
      jobTitle: app.job_title,
      magicLink,
      slotCount: proposedSlots.length,
    }).catch((err) => console.error('[Interview] invite email error:', err.message));

    res.json({
      success: true,
      interviewId: ins.rows[0].id,
      magicLink,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/interviews/by-token/:token - public, candidate fetches
router.get('/by-token/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const result = await pool.query(
      `SELECT ii.id, ii.proposed_slots, ii.selected_slot_index, ii.mode,
              ii.meeting_link, ii.location, ii.notes, ii.status,
              j.title AS job_title, c.name AS company_name, c.logo_url
       FROM interview_invites ii
       JOIN job_applications ja ON ii.application_id = ja.id
       JOIN jobs j ON ja.job_id = j.id
       JOIN companies c ON j.company_id = c.id
       WHERE ii.magic_token = $1`,
      [token]
    );
    if (result.rows.length === 0) return next(new AppError('Invalid invite link', 404));
    const inv = result.rows[0];

    res.json({
      success: true,
      interview: {
        id: inv.id,
        proposedSlots: inv.proposed_slots,
        selectedSlotIndex: inv.selected_slot_index,
        mode: inv.mode,
        meetingLink: inv.meeting_link,
        location: inv.location,
        notes: inv.notes,
        status: inv.status,
        jobTitle: inv.job_title,
        companyName: inv.company_name,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/interviews/by-token/:token/confirm - candidate picks slot
router.post('/by-token/:token/confirm', async (req, res, next) => {
  try {
    const { token } = req.params;
    const { slotIndex } = req.body;
    if (typeof slotIndex !== 'number' || slotIndex < 0) {
      return next(new AppError('slotIndex required', 400));
    }

    const result = await pool.query(
      `SELECT ii.*, ja.user_id, ja.job_id,
              j.title AS job_title, c.name AS company_name, c.user_id AS company_user_id,
              u.email AS candidate_email, ca.full_name AS candidate_name,
              cu.email AS company_email, cu.name AS company_contact
       FROM interview_invites ii
       JOIN job_applications ja ON ii.application_id = ja.id
       JOIN jobs j ON ja.job_id = j.id
       JOIN companies c ON j.company_id = c.id
       JOIN users u ON ja.user_id = u.id
       LEFT JOIN candidates ca ON ja.candidate_id = ca.id
       JOIN users cu ON c.user_id = cu.id
       WHERE ii.magic_token = $1`,
      [token]
    );
    if (result.rows.length === 0) return next(new AppError('Invalid invite link', 404));
    const inv = result.rows[0];

    if (inv.status !== 'pending') {
      return next(new AppError('This invite has already been processed', 400));
    }
    if (slotIndex >= inv.proposed_slots.length) {
      return next(new AppError('Slot index out of range', 400));
    }

    await pool.query(
      `UPDATE interview_invites
       SET selected_slot_index = $1, status = 'confirmed', updated_at = NOW()
       WHERE id = $2`,
      [slotIndex, inv.id]
    );

    const slot = inv.proposed_slots[slotIndex];

    // Generate ICS file
    const icsContent = generateICS({
      uid: inv.id,
      title: `Interview: ${inv.job_title} at ${inv.company_name}`,
      description: inv.notes || `Interview for ${inv.job_title} at ${inv.company_name}`,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      location: inv.mode === 'in_person' ? inv.location : inv.mode === 'video' ? inv.meeting_link : '',
      organizer: { email: inv.company_email, name: inv.company_contact || inv.company_name },
      attendee: { email: inv.candidate_email, name: inv.candidate_name },
    });

    // Send confirmations to both parties
    sendInterviewConfirmation({
      to: inv.candidate_email,
      recipientName: inv.candidate_name,
      jobTitle: inv.job_title,
      companyName: inv.company_name,
      scheduledAt: slot.startsAt,
      mode: inv.mode,
      meetingLink: inv.meeting_link,
      location: inv.location,
      icsContent,
    }).catch((err) => console.error('[Interview] confirm email error:', err.message));

    sendInterviewConfirmation({
      to: inv.company_email,
      recipientName: inv.company_contact || inv.company_name,
      jobTitle: inv.job_title,
      companyName: inv.company_name,
      scheduledAt: slot.startsAt,
      mode: inv.mode,
      meetingLink: inv.meeting_link,
      location: inv.location,
      icsContent,
    }).catch((err) => console.error('[Interview] company confirm email error:', err.message));

    // Insert notification for company
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, link, is_read)
       VALUES ($1, 'interview', $2, $3, $4, false)`,
      [
        inv.company_user_id,
        'Interview confirmed',
        `${inv.candidate_name || 'Candidate'} confirmed the interview for ${inv.job_title}`,
        `/applicants/${inv.application_id}`,
      ]
    );

    res.json({ success: true, scheduledAt: slot.startsAt });
  } catch (err) {
    next(err);
  }
});

// POST /api/interviews/:id/cancel - cancel an interview
router.post('/:id/cancel', protect, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT ii.id, ii.application_id, ja.job_id
       FROM interview_invites ii
       JOIN job_applications ja ON ii.application_id = ja.id
       WHERE ii.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return next(new AppError('Not found', 404));
    const access = await getJobAccess(req.user.id, result.rows[0].job_id);
    if (!access.allowed || !access.perms.manage_applicants) {
      return next(new AppError('Not authorized', 403));
    }
    await pool.query(
      `UPDATE interview_invites SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/interviews/upcoming - company dashboard widget
router.get('/upcoming', protect, async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Companies only', 403));
    }
    const companyRes = await pool.query('SELECT id FROM companies WHERE user_id = $1', [req.user.id]);
    if (companyRes.rows.length === 0) return res.json({ success: true, interviews: [] });
    const companyId = companyRes.rows[0].id;

    const result = await pool.query(
      `SELECT ii.id, ii.proposed_slots, ii.selected_slot_index, ii.mode, ii.status,
              j.title AS job_title,
              ca.full_name AS candidate_name, u.email AS candidate_email,
              ja.id AS application_id
       FROM interview_invites ii
       JOIN job_applications ja ON ii.application_id = ja.id
       JOIN jobs j ON ja.job_id = j.id
       JOIN users u ON ja.user_id = u.id
       LEFT JOIN candidates ca ON ja.candidate_id = ca.id
       WHERE j.company_id = $1 AND ii.status IN ('pending','confirmed')
       ORDER BY ii.created_at DESC
       LIMIT 10`,
      [companyId]
    );

    const upcoming = result.rows.map((r) => {
      const slot = r.selected_slot_index !== null && r.proposed_slots[r.selected_slot_index]
        ? r.proposed_slots[r.selected_slot_index]
        : r.proposed_slots[0];
      return {
        id: r.id,
        applicationId: r.application_id,
        status: r.status,
        mode: r.mode,
        scheduledAt: slot?.startsAt,
        jobTitle: r.job_title,
        candidateName: r.candidate_name || r.candidate_email.split('@')[0],
      };
    }).filter((i) => i.scheduledAt && new Date(i.scheduledAt) > new Date());

    res.json({ success: true, interviews: upcoming });
  } catch (err) {
    next(err);
  }
});

export default router;
