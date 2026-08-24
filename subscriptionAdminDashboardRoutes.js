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
      `const statusPill = (row) => {\n    const status=String(row.status||row.status_after||'unknown');\n    const cls = row.has_pro_access || ['active','trial','grace_period'].includes(status) ? 'good' : (status==='billing_retry' ? 'warn' : (['revoked','expired'].includes(status) ? 'bad' : ''));\n    return '<span class="pill '+cls+'">'+esc(titleCase(status))+'</span>';\n  };`,
      `const statusPill = (row) => {\n    const status=String(row.status||row.status_after||'unknown');\n    const eventType=String(row.event_type||'').toUpperCase();\n    const isPaidEvent=row.status_after==='active' && row.is_trial===false && ['SUBSCRIBED','DID_RENEW'].includes(eventType);\n    if(isPaidEvent) return '<span class="pill paid">PAID</span>';\n    const cls = row.has_pro_access || ['active','trial','grace_period'].includes(status) ? 'good' : (status==='billing_retry' ? 'warn' : (['revoked','expired'].includes(status) ? 'bad' : ''));\n    return '<span class="pill '+cls+'">'+esc(titleCase(status))+'</span>';\n  };`
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
