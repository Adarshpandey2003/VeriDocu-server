import express from 'express';
import crypto from 'crypto';
import razorpay from '../config/razorpay.js';
import pool from '../config/database.js';
import { protect } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

const PLAN_AMOUNT = 49900; // 499 INR in paise
const PLAN_CURRENCY = 'INR';

function requireRazorpay(req, res, next) {
  if (!razorpay) {
    return res.status(503).json({ success: false, message: 'Payment service not configured.' });
  }
  next();
}

// Ensure Razorpay plan exists, create if not
async function ensurePlan() {
  if (process.env.RAZORPAY_PLAN_ID) return process.env.RAZORPAY_PLAN_ID;
  try {
    const plan = await razorpay.plans.create({
      period: 'monthly',
      interval: 1,
      item: {
        name: 'VeriBoard Pro',
        amount: PLAN_AMOUNT,
        currency: PLAN_CURRENCY,
        description: 'Unlimited AI resume & cover letter generations',
      },
    });
    process.env.RAZORPAY_PLAN_ID = plan.id;
    console.log('[Razorpay] Created plan:', plan.id);
    return plan.id;
  } catch (err) {
    console.error('[Razorpay] Plan creation failed:', err.message);
    throw new AppError('Payment service unavailable', 503);
  }
}

// POST /api/subscriptions/create — create a new subscription for the user
router.post('/create', protect, requireRazorpay, async (req, res, next) => {
  try {
    // Check for existing active/authenticated subscription (not 'created' — those are abandoned checkouts)
    const existing = await pool.query(
      "SELECT id FROM subscriptions WHERE user_id = $1 AND status IN ('authenticated','active','pending') LIMIT 1",
      [req.user.id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'You already have an active subscription.' });
    }

    // Clean up abandoned 'created' subscriptions so a new one can be made
    await pool.query(
      "DELETE FROM subscriptions WHERE user_id = $1 AND status = 'created'",
      [req.user.id]
    );

    const planId = await ensurePlan();

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 120, // max billing cycles (10 years)
      customer_notify: 0,
      notes: { user_id: req.user.id, email: req.user.email },
    });

    await pool.query(
      `INSERT INTO subscriptions (user_id, razorpay_subscription_id, razorpay_plan_id, status)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, subscription.id, planId, subscription.status]
    );

    res.json({
      success: true,
      subscriptionId: subscription.id,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/subscriptions/status — get user's subscription info
router.get('/status', protect, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT s.*, u.is_pro FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC LIMIT 1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, subscription: null, isPro: false });
    }

    const sub = result.rows[0];
    res.json({
      success: true,
      isPro: !!sub.is_pro,
      subscription: {
        id: sub.razorpay_subscription_id,
        status: sub.status,
        currentStart: sub.current_start,
        currentEnd: sub.current_end,
        createdAt: sub.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/subscriptions/cancel — cancel at end of billing cycle
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

// POST /api/subscriptions/verify — verify payment after checkout (client-side callback)
router.post('/verify', protect, async (req, res, next) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

    const generated = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');

    if (generated !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Payment verification failed.' });
    }

    // Activate pro
    await pool.query('UPDATE users SET is_pro = true WHERE id = $1', [req.user.id]);
    await pool.query(
      "UPDATE subscriptions SET status = 'active' WHERE razorpay_subscription_id = $1",
      [razorpay_subscription_id]
    );

    res.json({ success: true, message: 'Payment verified. Pro activated!' });
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

    // req.body is a raw Buffer because we register express.raw() for this route
    const rawBody = typeof req.body === 'string' ? req.body : req.body.toString('utf8');

    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (expected !== signature) {
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

    // Find the subscription in our DB
    const subResult = await pool.query(
      'SELECT id, user_id FROM subscriptions WHERE razorpay_subscription_id = $1',
      [rzpSubId]
    );

    if (subResult.rows.length === 0) {
      console.warn('[Webhook] Unknown subscription:', rzpSubId);
      return res.json({ status: 'ok' });
    }

    const { id: subDbId, user_id: userId } = subResult.rows[0];

    switch (eventType) {
      case 'subscription.activated':
      case 'subscription.charged': {
        await pool.query(
          `UPDATE subscriptions SET status = 'active',
           current_start = to_timestamp($1), current_end = to_timestamp($2)
           WHERE id = $3`,
          [payload.current_start, payload.current_end, subDbId]
        );
        await pool.query('UPDATE users SET is_pro = true WHERE id = $1', [userId]);

        // Record payment if present
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
        await pool.query('UPDATE users SET is_pro = false WHERE id = $1', [userId]);
        break;
      }

      case 'subscription.paused':
      case 'subscription.pending':
      case 'subscription.halted': {
        await pool.query('UPDATE subscriptions SET status = $1 WHERE id = $2', [
          eventType.replace('subscription.', ''), subDbId
        ]);
        await pool.query('UPDATE users SET is_pro = false WHERE id = $1', [userId]);
        break;
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    res.status(500).json({ status: 'error' });
  }
});

export default router;
