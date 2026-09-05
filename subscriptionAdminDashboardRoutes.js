import './appleProceedsSyncWorker.js';

import express from 'express';
import pg from 'pg';

import {
  createSubscriptionAdminDashboardRouter as createBaseSubscriptionAdminDashboardRouter,
} from './subscriptionAdminDashboardBaseRoutes.js';
import {
  loadSubscriptionAdminHistory,
} from './lib/subscriptionAdminHistoryService.js';
import {
  enhanceSubscriptionAdminHistoryHtml,
} from './lib/subscriptionAdminHistoryUi.js';
import {
  enhanceSubscriptionAdminPayoutHtml,
} from './lib/subscriptionAdminPayoutUi.js';
import {
  enhanceSubscriptionAdminOverviewHtml,
} from './lib/subscriptionAdminOverviewUi.js';
import {
  enhanceSubscriptionAdminRevenueHtml,
} from './lib/subscriptionAdminRevenueUi.js';
import {
  enhanceSubscriptionAdminLifetimeHtml,
} from './lib/subscriptionAdminLifetimeUi.js';
import {
  enhanceSubscriptionAdminAccountsHtml,
} from './lib/subscriptionAdminAccountsUi.js';
import {
  enhanceSubscriptionAdminAutoRenewHtml,
} from './lib/subscriptionAdminAutoRenewUi.js';
import {
  enhanceSubscriptionAdminSubscribersHtml,
} from './lib/subscriptionAdminSubscribersUi.js';
import {
  enhanceSubscriptionAdminMobileHtml,
} from './lib/subscriptionAdminMobileUi.js';
import {
  getAppleSubscriptionVerificationState,
} from './lib/appleSubscriptionVerificationState.js';

const { Pool } = pg;

function enhanceDashboardHtml(html) {
  return String(html)
    .replace(
      'Auto-renew off but access remains',
      'Paid subscriptions ending this month'
    )
    .replace(
      `metric('Estimated MRR',money(m.estimated_mrr_usd||0),'Recurring only. Lifetime excluded')`,
      `metric('Sales this month',money(m.net_sales_this_month_usd||0),'Customer billings this month · before Apple fees/tax')`
    )
    .replace(
      `<div class="section"><div class="sectionhead"><h2>Subscription events</h2><span>Newest first</span></div><div class="tablewrap" id="eventTable"><div class="loading">Loading events...</div></div></div>`,
      `<div class="section"><div class="sectionhead"><h2>Subscription customers</h2><span>Current state · click a customer for full history</span></div><div class="tablewrap" id="eventTable"><div class="loading">Loading customers...</div></div></div>`
    )
    .replace(
      `placeholder="Event type, e.g. RENEWAL"`,
      `placeholder="Filter history event, e.g. DID_RENEW"`
    )
    .replace(
      `.pill.bad { border-color:#63343a;color:#ff9ca4;background:#261216; }`,
      `.pill.bad { border-color:#63343a;color:#ff9ca4;background:#261216; }\n    .pill.paid { border-color:#8b6d2b;color:#ffe19a;background:#2a210d;font-weight:800;letter-spacing:.03em; }\n    .next-action { display:flex;flex-direction:column;gap:3px;line-height:1.2; }\n    .next-action strong { font-size:12px;font-weight:700;color:#e8e5dc;white-space:nowrap; }\n    .next-action span { color:#8d95a3;font-size:11px;white-space:nowrap; }\n    .event-summary { cursor:pointer; }\n    .event-summary:hover { background:#171a20; }\n    .event-customer-toggle { border:0;background:transparent;color:#f3f1eb;padding:0;display:flex;align-items:center;gap:8px;font:inherit;font-weight:720;text-align:left; }\n    .event-caret { display:inline-block;color:#8d95a3;font-size:16px;line-height:1;transition:transform .14s ease; }\n    .event-summary.open .event-caret { transform:rotate(90deg); }\n    .event-history-row td { padding:0;border-bottom:1px solid #242832;background:#0c0e12; }\n    .event-history { padding:14px 18px 18px 42px; }\n    .event-history table { min-width:680px;background:#0f1116;border:1px solid #20242c;border-radius:10px;overflow:hidden; }\n    .event-history th { font-size:10px;padding:9px 12px; }\n    .event-history td { font-size:12px;padding:10px 12px;background:#0f1116; }\n    .event-history .loading { padding:16px;text-align:left; }`
    )
    .replace(
      `function customerName(r){ return r.account_display_name || r.account_email || (r.account_id ? shortId(r.account_id) : shortId(r.original_transaction_id)); }`,
      `function formatDateOnly(v){ if(!v)return 'N/A'; const d=new Date(v); if(Number.isNaN(d.getTime()))return 'N/A'; return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:d.getFullYear()===new Date().getFullYear()?undefined:'numeric'}); }\n  function daysUntil(v){ if(!v)return null; const end=new Date(v); if(Number.isNaN(end.getTime()))return null; return Math.max(0,Math.ceil((end.getTime()-Date.now())/86400000)); }\n  function nextActionHtml(r,endValue){\n    if(r.is_lifetime_pro) return '<div class="next-action"><strong>Permanent</strong><span>Never expires</span></div>';\n    const end=endValue||r.access_ends_at||r.expires_date;\n    if(!end) return '<div class="next-action"><strong>N/A</strong></div>';\n    const date=formatDateOnly(end); const days=daysUntil(end); const countdown=days==null?'':(days===0?'Today':(days===1?'1 day left':days+' days left'));\n    if(r.is_trial || r.status==='trial' || r.status_after==='trial'){ const label=r.auto_renew_enabled===false?'Ends ':'Bills '; return '<div class="next-action"><strong>'+esc(label+date)+'</strong><span>'+esc(countdown)+'</span></div>'; }\n    if(r.status==='active' || r.status_after==='active' || r.has_pro_access){ const label=r.auto_renew_enabled===false?'Ends ':'Renews '; return '<div class="next-action"><strong>'+esc(label+date)+'</strong></div>'; }\n    return '<div class="next-action"><strong>'+esc('Ends '+date)+'</strong></div>';\n  }\n  function customerName(r){ return r.account_display_name || r.account_email || (r.account_id ? shortId(r.account_id) : shortId(r.original_transaction_id)); }`
    )
    .replace(
      `function customerTable(rows){\n    if(!rows?.length) return '<div class="empty">No customers found.</div>';\n    return '<table><thead><tr><th>Customer</th><th>Access</th><th>Status</th><th>Renewal</th><th>Price</th><th>Environment</th><th>Updated</th></tr></thead><tbody>'+rows.map(r=>'<tr class="clickable" data-customer="'+esc(r.customer_key)+'"><td><strong>'+esc(customerName(r))+'</strong><div class="muted mono">'+esc(shortId(r.original_transaction_id))+'</div></td><td>'+esc(titleCase(r.pro_access_source))+(r.is_trial?' <span class="pill warn">Trial</span>':'')+'</td><td>'+statusPill(r)+'</td><td>'+esc(r.is_lifetime_pro?'Permanent':(r.auto_renew_enabled===false?'Off':(r.auto_renew_enabled===true?'On':'N/A')))+'</td><td>'+esc(priceMilli(r.price_milliunits,r.currency))+'</td><td><span class="pill">'+esc(r.environment)+'</span></td><td>'+esc(fmtDate(r.latest_transaction_signed_date||r.updated_at))+'</td></tr>').join('')+'</tbody></table>';\n  }`,
      `function customerTable(rows){\n    if(!rows?.length) return '<div class="empty">No customers found.</div>';\n    return '<table><thead><tr><th>Customer</th><th>Access</th><th>Status</th><th>Next</th><th>Price</th><th>Environment</th><th>Updated</th></tr></thead><tbody>'+rows.map(r=>'<tr class="clickable" data-customer="'+esc(r.customer_key)+'"><td><strong>'+esc(customerName(r))+'</strong><div class="muted mono">'+esc(shortId(r.original_transaction_id))+'</div></td><td>'+esc(titleCase(r.pro_access_source))+(r.is_trial?' <span class="pill warn">Trial</span>':(r.has_pro_access && r.is_recurring_pro && r.status==='active'?' <span class="pill good">Paid</span>':''))+'</td><td>'+statusPill(r)+'</td><td>'+nextActionHtml(r,r.access_ends_at||r.expires_date)+'</td><td>'+esc(priceMilli(r.price_milliunits,r.currency))+'</td><td><span class="pill">'+esc(r.environment)+'</span></td><td>'+esc(fmtDate(r.latest_transaction_signed_date||r.updated_at))+'</td></tr>').join('')+'</tbody></table>';\n  }`
    )
    .replace(
      `const statusPill = (row) => {\n    const status=String(row.status||row.status_after||'unknown');\n    const cls = row.has_pro_access || ['active','trial','grace_period'].includes(status) ? 'good' : (status==='billing_retry' ? 'warn' : (['revoked','expired'].includes(status) ? 'bad' : ''));\n    return '<span class="pill '+cls+'">'+esc(titleCase(status))+'</span>';\n  };`,
      `const statusPill = (row) => {\n    const status=String(row.status||row.status_after||'unknown');\n    const eventType=String(row.event_type||'').toUpperCase();\n    const isPaidEvent=row.status_after==='active' && row.is_trial===false && ['SUBSCRIBED','DID_RENEW'].includes(eventType);\n    if(isPaidEvent) return '<span class="pill paid">PAID</span>';\n    const isIssue=['billing_retry','grace_period','revoked','expired'].includes(status);\n    const cls = isIssue ? 'bad' : (row.has_pro_access || ['active','trial'].includes(status) ? 'good' : '');\n    return '<span class="pill '+cls+'">'+esc(titleCase(status))+'</span>';\n  };`
    )
    .replace(
      `async function loadEvents(){\n    const el=qs('#eventTable'); el.innerHTML='<div class="loading">Loading events...</div>';\n    try{ const d=await api('/events?'+eventParams().toString()); const rows=d.events||[]; el.innerHTML=rows.length?'<table><thead><tr><th>Event</th><th>Customer</th><th>Product</th><th>Status after</th><th>Environment</th><th>Time</th></tr></thead><tbody>'+rows.map(r=>'<tr '+(r.customer_key?'class="clickable" data-customer="'+esc(r.customer_key)+'"':'')+'><td><strong>'+esc(titleCase(r.event_type))+'</strong><div class="muted">'+esc(r.subtype||r.source||'')+'</div></td><td>'+esc(r.account_email||r.account_display_name||shortId(r.original_transaction_id))+'</td><td>'+esc(titleCase(r.pro_access_source||r.product_id))+'</td><td>'+statusPill(r)+'</td><td><span class="pill">'+esc(r.environment)+'</span></td><td>'+esc(fmtDate(r.event_at))+'</td></tr>').join('')+'</tbody></table>':'<div class="empty">No events found.</div>'; bindCustomerRows(el); }catch(e){ showError(el,e); }\n  }`,
      `function eventCustomerName(r){ return r.account_display_name || r.account_email || shortId(r.original_transaction_id); }\n  function eventGroupKey(r){ return String(r.customer_key || r.original_transaction_id || r.transaction_id || r.event_key || 'unknown'); }\n  function currentStatePill(r){\n    const status=String(r.status_after||'unknown');\n    if(status==='active' && r.is_trial===false) return '<span class="pill paid">PAID</span>';\n    const isIssue=['billing_retry','grace_period','revoked','expired'].includes(status);\n    const cls=isIssue?'bad':(['active','trial'].includes(status)?'good':'');\n    return '<span class="pill '+cls+'">'+esc(titleCase(status))+'</span>';\n  }\n  function eventHistoryTable(rows){\n    if(!rows?.length) return '<div class="empty">No history found.</div>';\n    return '<table><thead><tr><th>Event</th><th>Status after</th><th>Product</th><th>Time</th></tr></thead><tbody>'+rows.map(r=>'<tr><td><strong>'+esc(titleCase(r.event_type))+'</strong><div class="muted">'+esc(r.subtype||r.source||'')+'</div></td><td>'+statusPill(r)+'</td><td>'+esc(titleCase(r.pro_access_source||r.product_id))+'</td><td>'+esc(fmtDate(r.event_at))+'</td></tr>').join('')+'</tbody></table>';\n  }\n  async function loadEventHistory(panel,customerKey,fallbackRows){\n    if(panel.dataset.loaded==='true') return;\n    panel.dataset.loaded='true';\n    panel.innerHTML='<div class="loading">Loading full history...</div>';\n    try{\n      if(customerKey){ const d=await api('/customers/'+encodeURIComponent(customerKey)); panel.innerHTML=eventHistoryTable(d.events||fallbackRows||[]); }\n      else { panel.innerHTML=eventHistoryTable(fallbackRows||[]); }\n    }catch(e){ panel.dataset.loaded='false'; showError(panel,e); }\n  }\n  function bindEventGroups(root,groups){\n    root.querySelectorAll?.('[data-event-toggle]').forEach(row=>row.addEventListener('click',()=>{\n      const id=row.dataset.eventToggle; const history=qs('#'+id); if(!history)return;\n      const opening=history.classList.contains('hidden'); history.classList.toggle('hidden'); row.classList.toggle('open',opening);\n      const button=row.querySelector('.event-customer-toggle'); if(button)button.setAttribute('aria-expanded',opening?'true':'false');\n      if(opening){ const group=groups.get(row.dataset.groupKey)||[]; const panel=history.querySelector('.event-history'); loadEventHistory(panel,row.dataset.customerKey||'',group); }\n    }));\n  }\n  function groupedEventTable(rows){\n    if(!rows?.length) return {html:'<div class="empty">No customers found.</div>',groups:new Map()};\n    const groups=new Map();\n    rows.forEach(r=>{ const key=eventGroupKey(r); if(!groups.has(key))groups.set(key,[]); groups.get(key).push(r); });\n    const entries=[...groups.entries()];\n    const html='<table><thead><tr><th>Customer</th><th>Product</th><th>Current state</th><th>Next</th><th>Last activity</th></tr></thead><tbody>'+entries.map(([key,events],index)=>{\n      const r=events[0]; const historyId='event-history-'+index; const customerKey=r.customer_key||key;\n      return '<tr class="event-summary" data-event-toggle="'+historyId+'" data-group-key="'+esc(key)+'" data-customer-key="'+esc(customerKey)+'"><td><button class="event-customer-toggle" type="button" aria-expanded="false"><span class="event-caret">›</span><span>'+esc(eventCustomerName(r))+'</span></button><div class="muted mono">'+esc(shortId(r.original_transaction_id))+'</div></td><td>'+esc(titleCase(r.pro_access_source||r.product_id))+'</td><td>'+currentStatePill(r)+'</td><td>'+nextActionHtml(r,r.expires_date)+'</td><td>'+esc(fmtDate(r.event_at))+'</td></tr><tr id="'+historyId+'" class="event-history-row hidden"><td colspan="5"><div class="event-history"></div></td></tr>';\n    }).join('')+'</tbody></table>';\n    return {html,groups};\n  }\n  async function loadEvents(){\n    const el=qs('#eventTable'); el.innerHTML='<div class="loading">Loading customers...</div>';\n    try{ const d=await api('/events?'+eventParams().toString()); const grouped=groupedEventTable(d.events||[]); el.innerHTML=grouped.html; bindEventGroups(el,grouped.groups); }catch(e){ showError(el,e); }\n  }`
    );
}

export function createSubscriptionAdminDashboardRouter(options = {}) {
  const router = express.Router();
  const historyPool = options.historyPool || new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway')
      ? { rejectUnauthorized: false }
      : false,
    max: 2,
  });

  if (!options.historyPool) {
    historyPool.on('error', (error) => {
      console.error(
        '[SubscriptionDashboardHistory] Postgres pool error:',
        error?.message || error
      );
    });
  }

  router.use((_req, res, next) => {
    const originalSend = res.send.bind(res);

    res.send = (body) => {
      const enhancedBody =
        typeof body === 'string'
          ? enhanceSubscriptionAdminMobileHtml(
              enhanceSubscriptionAdminSubscribersHtml(
              enhanceSubscriptionAdminAutoRenewHtml(
              enhanceSubscriptionAdminAccountsHtml(
              enhanceSubscriptionAdminLifetimeHtml(
                enhanceSubscriptionAdminRevenueHtml(
                enhanceSubscriptionAdminOverviewHtml(
                  enhanceSubscriptionAdminPayoutHtml(
                    enhanceSubscriptionAdminHistoryHtml(
                      enhanceDashboardHtml(body)
                    )
                  )
                )
              )
              )
              )
              )
            )
            )
          : body;

      return originalSend(enhancedBody);
    };

    next();
  });

  router.use(
    createBaseSubscriptionAdminDashboardRouter(options)
  );

  // These private data routes intentionally come after the base dashboard router.
  // Requests therefore pass through the base dashboard's secure session middleware.
  router.get('/data/auto-renew-verification', (_req, res) => {
    return res.json({
      success: true,
      ...getAppleSubscriptionVerificationState(),
    });
  });

  router.get('/data/accounts-activity', async (req, res) => {
    try {
      const allowedSorts = new Set(['newest', 'oldest', 'last_sign_in', 'most_events']);
      const allowedPeriods = new Set(['all', 'today', '7d']);
      const allowedAccess = new Set(['all', 'pro', 'free']);
      const sort = allowedSorts.has(String(req.query.sort || '')) ? String(req.query.sort) : 'newest';
      const period = allowedPeriods.has(String(req.query.period || '')) ? String(req.query.period) : 'all';
      const access = allowedAccess.has(String(req.query.access || '')) ? String(req.query.access) : 'all';
      const q = String(req.query.q || '').trim().slice(0, 160);
      const params = [];
      const where = [];
      if (q) {
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        where.push(`(
          a.id::text ILIKE ${p}
          OR COALESCE(a.display_name, '') ILIKE ${p}
          OR COALESCE(ai.email, '') ILIKE ${p}
          OR COALESCE(gi.email, '') ILIKE ${p}
          OR COALESCE(ar.creator_code, '') ILIKE ${p}
          OR COALESCE(aff.display_name, '') ILIKE ${p}
        )`);
      }
      if (period === 'today') {
        where.push(`(a.created_at AT TIME ZONE 'America/Chicago')::date = (NOW() AT TIME ZONE 'America/Chicago')::date`);
      } else if (period === '7d') {
        where.push(`(a.created_at AT TIME ZONE 'America/Chicago')::date >= (NOW() AT TIME ZONE 'America/Chicago')::date - 6`);
      }
      if (access === 'pro') where.push(`COALESCE(sub.has_pro_access, FALSE) = TRUE`);
      if (access === 'free') where.push(`COALESCE(sub.has_pro_access, FALSE) = FALSE`);
      const orderBy = {
        newest: 'a.created_at DESC, a.id DESC',
        oldest: 'a.created_at ASC, a.id ASC',
        last_sign_in: 'COALESCE(GREATEST(a.last_authenticated_at, ai.last_authenticated_at, gi.last_authenticated_at), a.created_at) DESC, a.created_at DESC',
        most_events: 'COALESCE(usage.total_events, 0) DESC, a.created_at DESC',
      }[sort];
      const result = await historyPool.query(`
        WITH latest_apple_identity AS (
          SELECT DISTINCT ON (account_id)
            account_id,
            email,
            is_private_email,
            last_authenticated_at
          FROM account_apple_identities
          ORDER BY account_id, last_authenticated_at DESC NULLS LAST, created_at DESC
        ),
        latest_google_identity AS (
          SELECT DISTINCT ON (account_id)
            account_id,
            email,
            display_name,
            last_authenticated_at
          FROM account_google_identities
          ORDER BY account_id, last_authenticated_at DESC NULLS LAST, created_at DESC
        )
        SELECT
          a.id,
          a.status,
          COALESCE(NULLIF(BTRIM(a.display_name), ''), NULLIF(BTRIM(gi.display_name), '')) AS display_name,
          COALESCE(ai.email, gi.email) AS email,
          ai.is_private_email,
          CASE
            WHEN ai.account_id IS NOT NULL THEN 'Apple'
            WHEN gi.account_id IS NOT NULL THEN 'Google'
            ELSE 'Account'
          END AS identity_source,
          a.created_at,
          a.updated_at,
          GREATEST(a.last_authenticated_at, ai.last_authenticated_at, gi.last_authenticated_at) AS last_authenticated_at,
          COALESCE(sub.has_pro_access, FALSE) AS has_pro_access,
          CASE
            WHEN COALESCE(sub.lifetime_active, FALSE) THEN 'Lifetime'
            WHEN COALESCE(sub.trial_active, FALSE) THEN 'Trial'
            WHEN COALESCE(sub.paid_active, FALSE) THEN 'Paid'
            WHEN COALESCE(sub.has_pro_access, FALSE) THEN 'Pro'
            ELSE 'Free'
          END AS access_label,
          ar.creator_code AS referral_code,
          aff.display_name AS affiliate_display_name,
          ar.claim_source AS referral_source,
          ar.claimed_at AS referral_claimed_at,
          COALESCE(usage.total_events, 0)::int AS total_events,
          usage.last_event_at
        FROM accounts a
        LEFT JOIN latest_apple_identity ai ON ai.account_id = a.id
        LEFT JOIN latest_google_identity gi ON gi.account_id = a.id
        LEFT JOIN affiliate_account_referrals ar ON ar.account_id = a.id
        LEFT JOIN affiliates aff ON aff.id = ar.affiliate_id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS total_events,
            MAX(e.created_at) AS last_event_at
          FROM user_events e
          WHERE e.user_id IN (
            SELECT DISTINCT installation_id
            FROM account_installations account_install
            WHERE account_install.account_id = a.id
          )
            AND NOT EXISTS (
              SELECT 1
              FROM excluded_analytics_users excluded
              WHERE excluded.user_id = e.user_id
            )
        ) usage ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            BOOL_OR(has_pro_access) AS has_pro_access,
            BOOL_OR(trial_active) AS trial_active,
            BOOL_OR(recurring_revenue_active) AS paid_active,
            BOOL_OR(is_lifetime_pro AND has_pro_access) AS lifetime_active
          FROM subscription_admin_current_customers_v1
          WHERE account_id = a.id
            AND environment = 'Production'
        ) sub ON TRUE
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${orderBy}
        LIMIT 200
      `, params);
      res.json({
        sort,
        period,
        access,
        query: q,
        accounts: result.rows.map((row) => ({
          id: row.id,
          status: row.status,
          displayName: row.display_name,
          email: row.email,
          isPrivateEmail: row.is_private_email,
          identitySource: row.identity_source,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastAuthenticatedAt: row.last_authenticated_at,
          hasProAccess: Boolean(row.has_pro_access),
          accessLabel: row.access_label,
          referralCode: row.referral_code,
          affiliateDisplayName: row.affiliate_display_name,
          referralSource: row.referral_source,
          referralClaimedAt: row.referral_claimed_at,
          totalEvents: Number(row.total_events || 0),
          lastEventAt: row.last_event_at,
        })),
      });
    } catch (error) {
      console.error('[subscription-admin] account activity failed', error);
      res.status(500).json({ error: 'Failed to load account activity' });
    }
  });

  router.get('/data/accounts-geography', async (req, res) => {
    try {
      const allowedPeriods = new Set(['7d', '30d', 'all']);
      const period = allowedPeriods.has(String(req.query.period || ''))
        ? String(req.query.period)
        : '30d';
      const agoraAppleId = String(process.env.AFFILIATE_APPLE_APP_ID || '6762416967').trim();
      const params = [agoraAppleId];
      const where = [
        `apple_identifier = $1`,
        `product_type_identifier IN ('1', '1F', '1T')`,
        `COALESCE(units, 0) > 0`,
      ];
      if (period === '7d') {
        where.push(`report_date >= (NOW() AT TIME ZONE 'America/Chicago')::date - 6`);
      } else if (period === '30d') {
        where.push(`report_date >= (NOW() AT TIME ZONE 'America/Chicago')::date - 29`);
      }

      const result = await historyPool.query(`
        SELECT
          CASE
            WHEN UPPER(COALESCE(country_code, '')) ~ '^[A-Z]{3}$'
              THEN UPPER(country_code)
            ELSE NULL
          END AS country_code,
          ROUND(COALESCE(SUM(units), 0), 0)::int AS downloads,
          MAX(report_date) AS data_through_date
        FROM app_store_sales_report_rows
        WHERE ${where.join(' AND ')}
        GROUP BY 1
        ORDER BY downloads DESC, country_code ASC NULLS LAST
      `, params);

      const rows = result.rows || [];
      const totalDownloads = rows.reduce((sum, row) => sum + Number(row.downloads || 0), 0);
      const knownDownloads = rows
        .filter((row) => row.country_code)
        .reduce((sum, row) => sum + Number(row.downloads || 0), 0);
      const countries = rows
        .filter((row) => row.country_code)
        .map((row) => ({
          countryCode: row.country_code,
          downloads: Number(row.downloads || 0),
        }));
      const dataThroughDate = rows.reduce((latest, row) => {
        const value = row.data_through_date ? String(row.data_through_date).slice(0, 10) : null;
        return value && (!latest || value > latest) ? value : latest;
      }, null);

      res.json({
        period,
        source: 'app_store_connect_sales_trends',
        totalDownloads,
        knownDownloads,
        unknownDownloads: Math.max(0, totalDownloads - knownDownloads),
        dataThroughDate,
        countries,
      });
    } catch (error) {
      console.error('[subscription-admin] aggregate download geography failed', error);
      res.status(500).json({ error: 'Failed to load geographic interest' });
    }
  });

  router.get('/data/accounts-summary', async (_req, res) => {
  try {
    const [summaryResult, monthlyResult, dailyResult] = await Promise.all([
      historyPool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status <> 'deleted')::int AS total_accounts,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_accounts,
          COUNT(*)::int AS all_time_created,
          COUNT(*) FILTER (
            WHERE to_char(created_at AT TIME ZONE 'America/Chicago', 'YYYY-MM') =
                  to_char(NOW() AT TIME ZONE 'America/Chicago', 'YYYY-MM')
          )::int AS created_this_month,
          COUNT(*) FILTER (
            WHERE (created_at AT TIME ZONE 'America/Chicago')::date =
                  (NOW() AT TIME ZONE 'America/Chicago')::date
          )::int AS created_today,
          COUNT(*) FILTER (
            WHERE (created_at AT TIME ZONE 'America/Chicago')::date >=
                  (NOW() AT TIME ZONE 'America/Chicago')::date - 6
          )::int AS created_last_7_days,
          COUNT(*) FILTER (
            WHERE (created_at AT TIME ZONE 'America/Chicago')::date >=
                  (NOW() AT TIME ZONE 'America/Chicago')::date - 13
              AND (created_at AT TIME ZONE 'America/Chicago')::date <
                  (NOW() AT TIME ZONE 'America/Chicago')::date - 6
          )::int AS created_previous_7_days
        FROM accounts
      `),
      historyPool.query(`
        SELECT
          to_char(created_at AT TIME ZONE 'America/Chicago', 'YYYY-MM') AS month,
          COUNT(*)::int AS created_accounts
        FROM accounts
        GROUP BY 1
        ORDER BY 1
      `),
      historyPool.query(`
        WITH days AS (
          SELECT generate_series(
            (NOW() AT TIME ZONE 'America/Chicago')::date - 89,
            (NOW() AT TIME ZONE 'America/Chicago')::date,
            INTERVAL '1 day'
          )::date AS day
        ), counts AS (
          SELECT
            (created_at AT TIME ZONE 'America/Chicago')::date AS day,
            COUNT(*)::int AS created_accounts
          FROM accounts
          WHERE (created_at AT TIME ZONE 'America/Chicago')::date >=
                (NOW() AT TIME ZONE 'America/Chicago')::date - 89
          GROUP BY 1
        )
        SELECT
          to_char(days.day, 'YYYY-MM-DD') AS day,
          COALESCE(counts.created_accounts, 0)::int AS created_accounts
        FROM days
        LEFT JOIN counts USING (day)
        ORDER BY days.day
      `),
    ]);
    return res.json({
      success: true,
      totalAccounts: Number(summaryResult.rows[0]?.total_accounts || 0),
      activeAccounts: Number(summaryResult.rows[0]?.active_accounts || 0),
      allTimeCreated: Number(summaryResult.rows[0]?.all_time_created || 0),
      createdThisMonth: Number(summaryResult.rows[0]?.created_this_month || 0),
      createdToday: Number(summaryResult.rows[0]?.created_today || 0),
      createdLast7Days: Number(summaryResult.rows[0]?.created_last_7_days || 0),
      createdPrevious7Days: Number(summaryResult.rows[0]?.created_previous_7_days || 0),
      currentDate: dailyResult.rows.at(-1)?.day || null,
      currentMonth: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: '2-digit',
      }).format(new Date()).replace('/', '-'),
      days: dailyResult.rows.map((row) => ({
        day: row.day,
        createdAccounts: Number(row.created_accounts || 0),
      })),
      months: monthlyResult.rows.map((row) => ({
        month: row.month,
        createdAccounts: Number(row.created_accounts || 0),
      })),
    });
  } catch (error) {
    console.error('[SubscriptionDashboardAccounts] Failed:', error?.message || error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'subscription_accounts_summary_failed',
        message: 'Account summary is temporarily unavailable.',
      },
    });
  }
});

router.get('/data/history', async (_req, res) => {
    try {
      const history = await loadSubscriptionAdminHistory(historyPool);
      return res.json({
        success: true,
        ...history,
      });
    } catch (error) {
      console.error(
        '[SubscriptionDashboardHistory] Failed:',
        error?.message || error
      );
      return res.status(500).json({
        success: false,
        error: {
          code: 'subscription_history_failed',
          message: 'Subscription history is temporarily unavailable.',
        },
      });
    }
  });

  return router;
}
