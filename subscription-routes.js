'use strict';

const {
  getSubscription,
  setSubscription,
  PLAN_IDS,
  normalizePlan
} = require('./subscription-manager');

const { getPlan } = require('./api-plan-manager');

function registerSubscriptionRoutes(app, options = {}) {
  const adminKey = options.adminKey || process.env.ADMIN_API_KEY || process.env.BIG_ODD_ADMIN_KEY;

  function getUserId(req) {
    return req.headers['x-user-id'] || req.body?.userId || req.query?.userId || null;
  }

  function requireAdmin(req, res, next) {
    const supplied = req.headers['x-admin-key'] || req.headers['x-api-admin-key'];
    if (!adminKey || supplied !== adminKey) {
      return res.status(401).json({ success: false, error: 'ADMIN_AUTH_REQUIRED' });
    }
    next();
  }

  app.get('/api/v1/subscription/plans', (req, res) => {
    return res.json({
      success: true,
      type: 'subscription-plans',
      data: PLAN_IDS.map(id => {
        const plan = getPlan(id);
        return {
          id,
          name: plan.name,
          features: plan.features,
          rateLimitPerMinute: plan.rateLimitPerMinute
        };
      })
    });
  });

  app.get('/api/v1/subscription/me', (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, error: 'USER_ID_REQUIRED' });
    }

    const subscription = getSubscription(userId);
    return res.json({ success: true, userId, subscription });
  });

  // Admin/internal endpoint. Payment verification will use this later.
  app.post('/api/v1/subscription/upgrade', requireAdmin, (req, res) => {
    const { userId, plan, paymentReference = null, expiresAt = null } = req.body || {};
    if (!userId || !plan) {
      return res.status(400).json({ success: false, error: 'USER_ID_AND_PLAN_REQUIRED' });
    }

    const normalized = normalizePlan(plan);
    if (!PLAN_IDS.includes(normalized)) {
      return res.status(400).json({ success: false, error: 'INVALID_PLAN', allowedPlans: PLAN_IDS });
    }

    const subscription = setSubscription(userId, {
      plan: normalized,
      status: 'active',
      paymentReference,
      expiresAt
    });

    return res.json({ success: true, message: 'Subscription updated.', userId, subscription });
  });
}

module.exports = { registerSubscriptionRoutes };
