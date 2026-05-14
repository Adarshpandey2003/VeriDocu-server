// Job access helper - check if a user can access (view/edit/manage) a job.
// A user can access a job if:
//   1. They are the owner (company.user_id matches)
//   2. They are an accepted collaborator on the job

import pool from '../config/database.js';

const ROLE_PERMS = {
  co_owner:  { view: true, edit: true,  manage_applicants: true,  invite: true  },
  recruiter: { view: true, edit: false, manage_applicants: true,  invite: false },
  reviewer:  { view: true, edit: false, manage_applicants: false, invite: false },
};

export async function getJobAccess(userId, jobId) {
  // Owner check
  const ownerRes = await pool.query(
    `SELECT j.id FROM jobs j
     JOIN companies c ON j.company_id = c.id
     WHERE j.id = $1 AND c.user_id = $2`,
    [jobId, userId]
  );
  if (ownerRes.rows.length > 0) {
    return { allowed: true, role: 'owner', perms: { view: true, edit: true, manage_applicants: true, invite: true } };
  }

  // Collaborator check
  const collabRes = await pool.query(
    `SELECT role FROM job_collaborators
     WHERE job_id = $1 AND user_id = $2 AND accepted_at IS NOT NULL`,
    [jobId, userId]
  );
  if (collabRes.rows.length > 0) {
    const role = collabRes.rows[0].role;
    return { allowed: true, role, perms: ROLE_PERMS[role] || ROLE_PERMS.reviewer };
  }

  return { allowed: false, role: null, perms: {} };
}

// Express middleware factory
export function requireJobAccess(permission = 'view') {
  return async (req, res, next) => {
    try {
      const jobId = req.params.jobId || req.params.id || req.body.jobId;
      if (!jobId) {
        return res.status(400).json({ success: false, message: 'Job ID required' });
      }
      const access = await getJobAccess(req.user.id, jobId);
      if (!access.allowed || !access.perms[permission]) {
        return res.status(403).json({ success: false, message: 'You do not have access to this job' });
      }
      req.jobAccess = access;
      next();
    } catch (err) {
      next(err);
    }
  };
}
