import express from 'express';

import {
  createSubscriptionAdminDashboardRouter as createBaseSubscriptionAdminDashboardRouter,
} from './subscriptionAdminDashboardBaseRoutes.js';

function enhanceDashboardHtml(html) {
  return String(html)
    .replace(
      'Auto-renew off but access remains',
      'Paid subscriptions ending this month'
    )
    .replace(
      `(r.is_trial?' <span class="pill warn">Trial</span>':'')`,
      `(r.is_trial?' <span class="pill warn">Trial</span>':(r.has_pro_access && r.is_recurring_pro && r.status==='active'?' <span class="pill good">Paid</span>':''))`
    );
}

export function createSubscriptionAdminDashboardRouter(options = {}) {
  const router = express.Router();

  router.use((_req, res, next) => {
    const originalSend = res.send.bind(res);

    res.send = (body) => {
      const enhancedBody =
        typeof body === 'string'
          ? enhanceDashboardHtml(body)
          : body;

      return originalSend(enhancedBody);
    };

    next();
  });

  router.use(
    createBaseSubscriptionAdminDashboardRouter(options)
  );

  return router;
}
