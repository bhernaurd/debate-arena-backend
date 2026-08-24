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
      `.pill.bad { border-color:#63343a;color:#ff9ca4;background:#261216; }`,
      `.pill.bad { border-color:#63343a;color:#ff9ca4;background:#261216; }\n    .pill.paid { border-color:#8b6d2b;color:#ffe19a;background:#2a210d;font-weight:800;letter-spacing:.03em; }`
    )
    .replace(
      `(r.is_trial?' <span class="pill warn">Trial</span>':'')`,
      `(r.is_trial?' <span class="pill warn">Trial</span>':(r.has_pro_access && r.is_recurring_pro && r.status==='active'?' <span class="pill good">Paid</span>':''))`
    )
    .replace(
      `'<td><strong>'+esc(titleCase(r.event_type))+'</strong><div class="muted">'`,
      `'<td><strong>'+esc(titleCase(r.event_type))+'</strong>'+((!r.is_trial && r.status_after==='active' && ['SUBSCRIBED','DID_RENEW'].includes(String(r.event_type||'').toUpperCase()))?' <span class="pill paid">PAID</span>':'')+'<div class="muted">'`
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
