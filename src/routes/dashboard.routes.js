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

const STATUS_COLORS = {
  pending:      '#94a3b8',
  reviewing:    '#3b82f6',
  shortlisted:  '#8b5cf6',
  interviewing: '#f59e0b',
  offered:      '#10b981',
  rejected:     '#ef4444',
  withdrawn:    '#cbd5e1',
};

const FUNNEL_STAGES = ['pending', 'reviewing', 'shortlisted', 'interviewing', 'offered'];

function pctDelta(current, prev) {
  const c = Number(current) || 0;
  const p = Number(prev) || 0;
  if (p === 0) return c > 0 ? 100 : 0;
  return Math.round(((c - p) / p) * 1000) / 10;
}

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

    const rangeParam = parseInt(req.query.range, 10);
    const range = [7, 30, 90, 365].includes(rangeParam) ? rangeParam : 30;
    const rangeStart = new Date(Date.now() - range * 24 * 60 * 60 * 1000);
    const prevStart = new Date(Date.now() - 2 * range * 24 * 60 * 60 * 1000);

    // Get company ID, create profile if doesn't exist
    let companyResult = await pool.query(
      'SELECT id, name FROM companies WHERE user_id = $1',
      [req.user.id]
    );

    let companyId;
    let companyName;
    if (companyResult.rows.length === 0) {
      const newCompany = await pool.query(
        `INSERT INTO companies (name, slug, user_id, created_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING id, name`,
        [req.user.name, req.user.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), req.user.id]
      );
      companyId = newCompany.rows[0].id;
      companyName = newCompany.rows[0].name;
    } else {
      companyId = companyResult.rows[0].id;
      companyName = companyResult.rows[0].name;
    }

    const [
      jobStatsRes,
      kpiAppsRes,
      kpiViewsRes,
      kpiReviewRes,
      funnelRes,
      appsTrendRes,
      viewsTrendRes,
      topJobsRes,
      verificationRes,
      verificationRangeRes,
      recentAppsRes,
      recentVerifRes,
    ] = await Promise.all([
      // Job stats (active jobs is point-in-time, not range)
      pool.query(
        `SELECT
           COUNT(*)::int as total_jobs,
           COUNT(CASE WHEN is_active = true THEN 1 END)::int as active_jobs,
           COUNT(CASE WHEN is_active = true AND created_at >= $2 THEN 1 END)::int as new_jobs,
           COUNT(CASE WHEN is_active = true AND created_at >= $3 AND created_at < $2 THEN 1 END)::int as prev_new_jobs
         FROM jobs WHERE company_id = $1`,
        [companyId, rangeStart, prevStart]
      ),
      // Applications in current vs previous range, plus all-time status counts
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE ja.applied_at >= $2)::int as current,
           COUNT(*) FILTER (WHERE ja.applied_at >= $3 AND ja.applied_at < $2)::int as prev,
           COUNT(*) FILTER (WHERE ja.status = 'pending')::int as awaiting_review,
           COUNT(*) FILTER (WHERE ja.status = 'interviewing')::int as interviews_pending
         FROM job_applications ja
         JOIN jobs j ON ja.job_id = j.id
         WHERE j.company_id = $1`,
        [companyId, rangeStart, prevStart]
      ),
      // Job views in current vs previous range
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE jv.viewed_at >= $2)::int as current,
           COUNT(*) FILTER (WHERE jv.viewed_at >= $3 AND jv.viewed_at < $2)::int as prev
         FROM job_views jv
         JOIN jobs j ON jv.job_id = j.id
         WHERE j.company_id = $1`,
        [companyId, rangeStart, prevStart]
      ),
      // Avg time to first review (applied -> updated where status changed away from pending)
      pool.query(
        `SELECT
           AVG(EXTRACT(EPOCH FROM (ja.updated_at - ja.applied_at)) / 3600.0) FILTER (WHERE ja.applied_at >= $2)::float as current_hours,
           AVG(EXTRACT(EPOCH FROM (ja.updated_at - ja.applied_at)) / 3600.0) FILTER (WHERE ja.applied_at >= $3 AND ja.applied_at < $2)::float as prev_hours
         FROM job_applications ja
         JOIN jobs j ON ja.job_id = j.id
         WHERE j.company_id = $1 AND ja.status != 'pending' AND ja.updated_at > ja.applied_at`,
        [companyId, rangeStart, prevStart]
      ),
      // Funnel breakdown - all 7 statuses in current range
      pool.query(
        `SELECT ja.status, COUNT(*)::int as count
         FROM job_applications ja
         JOIN jobs j ON ja.job_id = j.id
         WHERE j.company_id = $1 AND ja.applied_at >= $2
         GROUP BY ja.status`,
        [companyId, rangeStart]
      ),
      // Applications per day
      pool.query(
        `SELECT date_trunc('day', ja.applied_at)::date as date, COUNT(*)::int as count
         FROM job_applications ja
         JOIN jobs j ON ja.job_id = j.id
         WHERE j.company_id = $1 AND ja.applied_at >= $2
         GROUP BY 1 ORDER BY 1`,
        [companyId, rangeStart]
      ),
      // Views per day
      pool.query(
        `SELECT date_trunc('day', jv.viewed_at)::date as date, COUNT(*)::int as count
         FROM job_views jv
         JOIN jobs j ON jv.job_id = j.id
         WHERE j.company_id = $1 AND jv.viewed_at >= $2
         GROUP BY 1 ORDER BY 1`,
        [companyId, rangeStart]
      ),
      // Top 5 jobs by applications
      pool.query(
        `SELECT
           j.id, j.title, j.location, j.is_active,
           COUNT(DISTINCT ja.id)::int as applications,
           COUNT(DISTINCT jv.id)::int as views
         FROM jobs j
         LEFT JOIN job_applications ja ON j.id = ja.job_id
         LEFT JOIN job_views jv ON j.id = jv.job_id
         WHERE j.company_id = $1
         GROUP BY j.id
         ORDER BY applications DESC, views DESC
         LIMIT 5`,
        [companyId]
      ),
      // Verification overall counts
      pool.query(
        `SELECT verification_status, COUNT(*)::int as count
         FROM employment_history
         WHERE company_id = $1
         GROUP BY verification_status`,
        [companyId]
      ),
      // Verification in range vs prev range
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE created_at >= $2 AND verification_status = 'pending')::int as current_pending,
           COUNT(*) FILTER (WHERE created_at >= $3 AND created_at < $2 AND verification_status = 'pending')::int as prev_pending,
           COUNT(*) FILTER (WHERE created_at >= $2)::int as current_requests,
           COUNT(*) FILTER (WHERE created_at >= $3 AND created_at < $2)::int as prev_requests
         FROM employment_history
         WHERE company_id = $1`,
        [companyId, rangeStart, prevStart]
      ),
      // Recent applications (last 8)
      pool.query(
        `SELECT
           ja.id, ja.status, ja.applied_at as timestamp,
           j.title as job_title, j.id as job_id,
           COALESCE(c.full_name, SPLIT_PART(u.email, '@', 1)) as actor
         FROM job_applications ja
         JOIN jobs j ON ja.job_id = j.id
         JOIN users u ON ja.user_id = u.id
         LEFT JOIN candidates c ON c.user_id = u.id
         WHERE j.company_id = $1
         ORDER BY ja.applied_at DESC
         LIMIT 8`,
        [companyId]
      ),
      // Recent verification requests (last 4)
      pool.query(
        `SELECT
           eh.id, eh.verification_status as status, eh.created_at as timestamp,
           eh.position as job_title,
           COALESCE(c.full_name, 'Candidate') as actor
         FROM employment_history eh
         LEFT JOIN candidates c ON c.id = eh.candidate_id
         WHERE eh.company_id = $1
         ORDER BY eh.created_at DESC
         LIMIT 4`,
        [companyId]
      ),
    ]);

    // ── Compute KPIs ──────────────────────────────────────────────────
    const jobStats = jobStatsRes.rows[0];
    const kpiApps = kpiAppsRes.rows[0];
    const kpiViews = kpiViewsRes.rows[0];
    const kpiReview = kpiReviewRes.rows[0];
    const verifRange = verificationRangeRes.rows[0];

    const verificationCounts = { pending: 0, verified: 0, rejected: 0 };
    for (const row of verificationRes.rows) {
      if (verificationCounts[row.verification_status] !== undefined) {
        verificationCounts[row.verification_status] = row.count;
      }
    }

    const conversionCurrent = kpiViews.current > 0 ? (kpiApps.current / kpiViews.current) * 100 : 0;
    const conversionPrev = kpiViews.prev > 0 ? (kpiApps.prev / kpiViews.prev) * 100 : 0;

    const kpis = {
      activeJobs: {
        value: jobStats.active_jobs,
        prevValue: Math.max(0, jobStats.active_jobs - jobStats.new_jobs + jobStats.prev_new_jobs),
        delta: pctDelta(jobStats.new_jobs, jobStats.prev_new_jobs),
      },
      totalApplications: {
        value: kpiApps.current,
        prevValue: kpiApps.prev,
        delta: pctDelta(kpiApps.current, kpiApps.prev),
      },
      avgTimeToReview: {
        hours: kpiReview.current_hours ? Math.round(kpiReview.current_hours * 10) / 10 : 0,
        prevHours: kpiReview.prev_hours ? Math.round(kpiReview.prev_hours * 10) / 10 : 0,
        delta: pctDelta(kpiReview.current_hours || 0, kpiReview.prev_hours || 0),
      },
      verificationsPending: {
        value: verificationCounts.pending,
        prevValue: verifRange.prev_pending,
        delta: pctDelta(verifRange.current_pending, verifRange.prev_pending),
      },
      profileViews: {
        value: kpiViews.current,
        prevValue: kpiViews.prev,
        delta: pctDelta(kpiViews.current, kpiViews.prev),
      },
      conversionRate: {
        value: Math.round(conversionCurrent * 10) / 10,
        prevValue: Math.round(conversionPrev * 10) / 10,
        delta: pctDelta(conversionCurrent, conversionPrev),
      },
    };

    // ── Funnel ────────────────────────────────────────────────────────
    const funnelMap = {};
    for (const row of funnelRes.rows) funnelMap[row.status] = row.count;
    const topOfFunnel = FUNNEL_STAGES.reduce((sum, s) => sum + (funnelMap[s] || 0), 0);
    const funnel = FUNNEL_STAGES.map((stage) => {
      const count = funnelMap[stage] || 0;
      return {
        stage,
        count,
        percentage: topOfFunnel > 0 ? Math.round((count / topOfFunnel) * 100) : 0,
        color: STATUS_COLORS[stage],
      };
    });

    // ── Status breakdown (all 7 statuses) ─────────────────────────────
    const allStatuses = ['pending', 'reviewing', 'shortlisted', 'interviewing', 'offered', 'rejected', 'withdrawn'];
    const statusBreakdown = allStatuses.map((status) => ({
      status,
      count: funnelMap[status] || 0,
      color: STATUS_COLORS[status],
    }));

    // ── Trends (fill missing days with 0) ─────────────────────────────
    const fillDailySeries = (rows) => {
      const map = {};
      for (const r of rows) {
        const key = new Date(r.date).toISOString().slice(0, 10);
        map[key] = r.count;
      }
      const series = [];
      for (let i = range - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        const key = d.toISOString().slice(0, 10);
        series.push({ date: key, count: map[key] || 0 });
      }
      return series;
    };

    const trends = {
      applicationsPerDay: fillDailySeries(appsTrendRes.rows),
      viewsPerDay: fillDailySeries(viewsTrendRes.rows),
    };

    // ── Top jobs ──────────────────────────────────────────────────────
    const topJobs = topJobsRes.rows.map((j) => ({
      id: j.id,
      title: j.title,
      location: j.location,
      isActive: j.is_active,
      applications: j.applications,
      views: j.views,
      conversionRate: j.views > 0 ? Math.round((j.applications / j.views) * 1000) / 10 : 0,
    }));

    // ── Recent activity (merge applications + verifications, sort, slice 10) ──
    const activityItems = [
      ...recentAppsRes.rows.map((r) => ({
        type: 'application',
        actor: r.actor,
        jobTitle: r.job_title,
        status: r.status,
        timestamp: r.timestamp,
        link: `/applicants/${r.id}`,
      })),
      ...recentVerifRes.rows.map((r) => ({
        type: 'verification',
        actor: r.actor,
        jobTitle: r.job_title,
        status: r.status,
        timestamp: r.timestamp,
        link: '/company/verification-requests',
      })),
    ]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 10);

    res.json({
      success: true,
      range,
      companyName,
      kpis,
      funnel,
      statusBreakdown,
      trends,
      topJobs,
      verification: {
        pending: verificationCounts.pending,
        verified: verificationCounts.verified,
        rejected: verificationCounts.rejected,
        requestsInRange: verifRange.current_requests,
        prevRequestsInRange: verifRange.prev_requests,
      },
      recentActivity: activityItems,
      actionItems: {
        awaitingReview: kpiApps.awaiting_review,
        interviewsPending: kpiApps.interviews_pending,
        verificationsPending: verificationCounts.pending,
      },
    });
  } catch (error) {
    console.error('Error fetching company dashboard:', error);
    res.status(500).json({ success: false, message: 'Error fetching dashboard data' });
  }
});

export default router;
