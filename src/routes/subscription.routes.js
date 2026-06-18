import express from 'express';
import crypto from 'crypto';
import razorpay from '../config/razorpay.js';
import pool from '../config/database.js';
import { protect } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

const PLANS = {
  candidate: {
    pro:   { monthly: { amount: 29900,  name: 'VeriBoard Pro' },
             yearly:  { amount: 249900, name: 'VeriBoard Pro Yearly' } },
    elite: { monthly: { amount: 69900,  name: 'VeriBoard Elite' },
             yearly:  { amount: 599900, name: 'VeriBoard Elite Yearly' } },
  },
  company: {
    growth:     { monthly: { amount: 199900,  name: 'VeriBoard Growth' },
                  yearly:  { amount: 1799900, name: 'VeriBoard Growth Yearly' } },
    enterprise: { monthly: { amount: 699900,  name: 'VeriBoard Enterprise' },
                  yearly:  { amount: 5999900, name: 'VeriBoard Enterprise Yearly' } },
  },
};

const VALID_TIERS = {
  candidate: ['pro', 'elite'],
  company: ['growth', 'enterprise'],
};

function requireRazorpay(req, res, next) {
  if (!razorpay) {
    return res.status(503).json({ success: false, message: 'Payment service not configured.' });
  }
  next();
}

async function ensurePlan(tier, billing) {
  const cached = await pool.query(
    'SELECT rzp_plan_id FROM razorpay_plans WHERE tier = $1 AND billing = $2',
    [tier, billing]
  );
  if (cached.rows.length > 0) return cached.rows[0].rzp_plan_id;

  const accountType = PLANS.candidate[tier] ? 'candidate' : 'company';
  const planConfig = PLANS[accountType]?.[tier]?.[billing];
  if (!planConfig) throw new AppError(`Invalid plan: ${tier}/${billing}`, 400);

  const period = billing === 'yearly' ? 'yearly' : 'monthly';
  const interval = 1;

  const plan = await razorpay.plans.create({
    period,
    interval,
    item: {
      name: planConfig.name,
      amount: planConfig.amount,
      currency: 'INR',
      description: `${planConfig.name} Subscription`,
    },
  });

  await pool.query(
    `INSERT INTO razorpay_plans (tier, billing, rzp_plan_id, amount)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tier, billing) DO UPDATE SET rzp_plan_id = EXCLUDED.rzp_plan_id`,
    [tier, billing, plan.id, planConfig.amount]
  );

  console.log(`[Razorpay] Created plan ${tier}/${billing}: ${plan.id}`);
  return plan.id;
}

// POST /api/subscriptions/create
router.post('/create', protect, requireRazorpay, async (req, res, next) => {
  try {
    const { tier, billing = 'monthly' } = req.body;
    const accountType = req.user.account_type;

    if (!tier || !VALID_TIERS[accountType]?.includes(tier)) {
      return res.status(400).json({ success: false, message: `Invalid plan tier for ${accountType}.` });
    }
    if (!['monthly', 'yearly'].includes(billing)) {
      return res.status(400).json({ success: false, message: 'Billing must be monthly or yearly.' });
    }

    const existing = await pool.query(
      "SELECT id FROM subscriptions WHERE user_id = $1 AND status IN ('authenticated','active','pending') LIMIT 1",
      [req.user.id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'You already have an active subscription. Cancel first to switch plans.' });
    }

    await pool.query(
      "DELETE FROM subscriptions WHERE user_id = $1 AND status = 'created'",
      [req.user.id]
    );

    const planId = await ensurePlan(tier, billing);
    const totalCount = billing === 'yearly' ? 10 : 120;

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: totalCount,
      customer_notify: 0,
      notes: { user_id: req.user.id, email: req.user.email, tier, billing },
    });

    await pool.query(
      `INSERT INTO subscriptions (user_id, razorpay_subscription_id, razorpay_plan_id, status, plan_tier, billing_cycle)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user.id, subscription.id, planId, subscription.status, tier, billing]
    );

    const planConfig = PLANS[accountType][tier][billing];

    res.json({
      success: true,
      subscriptionId: subscription.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      planName: planConfig.name,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/subscriptions/status
router.get('/status', protect, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT s.*, u.is_pro, u.plan_tier, u.plan_billing FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC LIMIT 1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, subscription: null, isPro: false, planTier: 'free' });
    }

    const sub = result.rows[0];
    res.json({
      success: true,
      isPro: sub.plan_tier !== 'free',
      planTier: sub.plan_tier || 'free',
      planBilling: sub.plan_billing || null,
      subscription: {
        id: sub.razorpay_subscription_id,
        status: sub.status,
        tier: sub.plan_tier,
        billing: sub.billing_cycle,
        currentStart: sub.current_start,
        currentEnd: sub.current_end,
        createdAt: sub.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/subscriptions/cancel
router.post('/cancel', protect, requireRazorpay, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT razorpay_subscription_id FROM subscriptions WHERE user_id = $1 AND status = 'active' LIMIT 1",
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No active subscription found.' });
    }

    const rzpSubId = result.rows[0].razorpay_subscription_id;
    await razorpay.subscriptions.cancel(rzpSubId, { cancel_at_cycle_end: true });

    await pool.query(
      "UPDATE subscriptions SET status = 'cancelled' WHERE razorpay_subscription_id = $1",
      [rzpSubId]
    );

    res.json({ success: true, message: 'Subscription will cancel at end of current billing period.' });
  } catch (err) {
    next(err);
  }
});

// POST /api/subscriptions/verify
router.post('/verify', protect, async (req, res, next) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

    const generated = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');

    // Constant-time comparison to prevent timing-based signature recovery.
    const sigOk = typeof razorpay_signature === 'string'
      && razorpay_signature.length === generated.length
      && crypto.timingSafeEqual(
        Buffer.from(generated, 'hex'),
        Buffer.from(razorpay_signature, 'hex')
      );
    if (!sigOk) {
      return res.status(400).json({ success: false, message: 'Payment verification failed.' });
    }

    const subResult = await pool.query(
      'SELECT plan_tier, billing_cycle FROM subscriptions WHERE razorpay_subscription_id = $1',
      [razorpay_subscription_id]
    );
    const tier = subResult.rows[0]?.plan_tier || 'pro';
    const billing = subResult.rows[0]?.billing_cycle || 'monthly';

    await pool.query(
      "UPDATE users SET is_pro = true, plan_tier = $1, plan_billing = $2 WHERE id = $3",
      [tier, billing, req.user.id]
    );
    await pool.query(
      "UPDATE subscriptions SET status = 'active' WHERE razorpay_subscription_id = $1",
      [razorpay_subscription_id]
    );

    res.json({ success: true, message: 'Payment verified. Plan activated!', planTier: tier });
  } catch (err) {
    next(err);
  }
});

// POST /api/subscriptions/webhook — Razorpay webhook handler (PUBLIC)
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('[Webhook] RAZORPAY_WEBHOOK_SECRET not set');
      return res.status(500).json({ status: 'error' });
    }

    const rawBody = typeof req.body === 'string' ? req.body : req.body.toString('utf8');

    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    const sigOk = typeof signature === 'string'
      && signature.length === expected.length
      && crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(signature, 'hex')
      );
    if (!sigOk) {
      console.error('[Webhook] Invalid signature');
      return res.status(400).json({ status: 'invalid_signature' });
    }

    const event = JSON.parse(rawBody);
    const eventType = event.event;
    const payload = event.payload?.subscription?.entity;

    if (!payload) {
      return res.json({ status: 'ok' });
    }

    const rzpSubId = payload.id;
    console.log(`[Webhook] ${eventType} for subscription ${rzpSubId}`);

    const subResult = await pool.query(
      'SELECT id, user_id, plan_tier, billing_cycle FROM subscriptions WHERE razorpay_subscription_id = $1',
      [rzpSubId]
    );

    if (subResult.rows.length === 0) {
      console.warn('[Webhook] Unknown subscription:', rzpSubId);
      return res.json({ status: 'ok' });
    }

    const { id: subDbId, user_id: userId, plan_tier: tier, billing_cycle: billing } = subResult.rows[0];

    switch (eventType) {
      case 'subscription.activated':
      case 'subscription.charged': {
        await pool.query(
          `UPDATE subscriptions SET status = 'active',
           current_start = to_timestamp($1), current_end = to_timestamp($2)
           WHERE id = $3`,
          [payload.current_start, payload.current_end, subDbId]
        );
        await pool.query(
          "UPDATE users SET is_pro = true, plan_tier = $1, plan_billing = $2 WHERE id = $3",
          [tier, billing, userId]
        );

        const paymentEntity = event.payload?.payment?.entity;
        if (paymentEntity) {
          await pool.query(
            `INSERT INTO subscription_payments (subscription_id, razorpay_payment_id, amount, currency, status, paid_at)
             VALUES ($1, $2, $3, $4, $5, to_timestamp($6))
             ON CONFLICT (razorpay_payment_id) DO NOTHING`,
            [subDbId, paymentEntity.id, paymentEntity.amount, paymentEntity.currency, paymentEntity.status, paymentEntity.created_at]
          );
        }
        break;
      }

      case 'subscription.cancelled':
      case 'subscription.completed':
      case 'subscription.expired': {
        await pool.query('UPDATE subscriptions SET status = $1 WHERE id = $2', [
          eventType.replace('subscription.', ''), subDbId
        ]);
        await pool.query(
          "UPDATE users SET is_pro = false, plan_tier = 'free', plan_billing = NULL WHERE id = $1",
          [userId]
        );
        break;
      }

      case 'subscription.paused':
      case 'subscription.pending':
      case 'subscription.halted': {
        await pool.query('UPDATE subscriptions SET status = $1 WHERE id = $2', [
          eventType.replace('subscription.', ''), subDbId
        ]);
        await pool.query(
          "UPDATE users SET is_pro = false, plan_tier = 'free', plan_billing = NULL WHERE id = $1",
          [userId]
        );
        break;
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    res.status(500).json({ status: 'error' });
  }
});

// GET /api/subscriptions/plans — public plan info
router.get('/plans', async (req, res) => {
  res.json({
    success: true,
    plans: {
      candidate: {
        free: {
          name: 'Starter', price: 0, features: [
            'Apply to verified jobs', 'Basic profile visibility', 'Limited job recommendations',
            '10 resume generations/month', '2 cover letters/month',
          ],
        },
        pro: {
          name: 'Pro', monthly: 299, yearly: 2499, features: [
            'Top priority in job recommendations', 'Highly relevant job matching',
            '300 resume generations/month', '300 cover letters/month',
            'Priority visibility to recruiters', 'Basic profile insights',
          ],
        },
        elite: {
          name: 'Elite', monthly: 699, yearly: 5999, features: [
            'All Pro features', 'See who viewed your profile',
            'Unlimited resume generations', 'Unlimited cover letters',
            'AI resume & profile optimization', 'Instant alerts for high-match jobs',
            '"Verified Pro Candidate" badge',
          ],
        },
      },
      company: {
        free: {
          name: 'Basic', price: 0, features: [
            'Post 1 active job', 'Access limited candidate profiles',
            'Basic verification status', 'Standard listing visibility',
          ],
        },
        growth: {
          name: 'Growth', monthly: 1999, yearly: 17999, features: [
            'Up to 5 active job postings', 'Access to verified candidate pool',
            'Higher job visibility', 'Basic analytics',
            'Limited candidate messaging', 'Company verification badge',
          ],
        },
        enterprise: {
          name: 'Enterprise', monthly: 6999, yearly: 59999, contactSales: true, features: [
            'Unlimited job postings', 'Priority placement in job feeds',
            'Full access to verified candidate database', 'Unlimited candidate messaging',
            'Advanced analytics', 'Fast-track verification requests',
            '"Top Verified Company" badge', 'Dedicated support',
          ],
        },
      },
    },
  });
});

export default router;
