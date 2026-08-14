import crypto from 'crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';

import {
  createAffiliateProgramService,
} from './lib/affiliateProgramService.js';

function jsonError(res, error) {
  const statusCode = Number(error?.statusCode) || 500;
  const code = error?.code || 'affiliate_internal_error';

  if (statusCode >= 500) {
    console.error('[affiliate]', error);
  }

  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message: statusCode >= 500
        ? 'Affiliate service request failed.'
        : error.message,
    },
  });
}

function requireAdminKey(adminKey) {
  const expected = typeof adminKey === 'string' ? adminKey.trim() : '';

  return (req, res, next) => {
    // This key is a temporary server/CLI control-plane credential. Do not put
    // it in browser JavaScript. The eventual admin.theagora.app UI should use
    // an authenticated owner session instead.
    if (expected.length < 32) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'affiliate_admin_not_configured',
          message: 'Affiliate admin authentication is not configured.',
        },
      });
    }

    const supplied = String(req.get('x-admin-key') || '');
    const left = Buffer.from(supplied, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    const matches = left.length === right.length && crypto.timingSafeEqual(left, right);

    if (!matches) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'affiliate_admin_unauthorized',
          message: 'Unauthorized.',
        },
      });
    }

    return next();
  };
}

function partnerSecurityHeaders(_req, res, next) {
  // Global CORS exists for the app API. Private dashboard bearer URLs should
  // not become readable by arbitrary third-party origins.
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Credentials');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  // The page is self-contained. Inline styles/scripts are currently required;
  // no remote script, object, frame, or base URL is permitted.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  );
  return next();
}

function readJsonBoolean(value, fieldName, defaultValue = false) {
  if (value == null) return defaultValue;
  if (value === true || value === false) return value;
  const error = new Error(`${fieldName} must be a JSON boolean.`);
  error.statusCode = 400;
  error.code = 'invalid_boolean';
  throw error;
}

function privateApiHeaders(_req, res, next) {
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Credentials');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return next();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderPartnerDashboardPage(token) {
  const safeToken = escapeHtml(token);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow,noarchive" />
  <title>The Agora Partners</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09080d;
      --panel: #121019;
      --panel-2: #17141f;
      --border: rgba(216, 171, 82, 0.18);
      --border-strong: rgba(216, 171, 82, 0.42);
      --gold: #d8ab52;
      --gold-soft: #f0d89f;
      --text: #f7f2e8;
      --muted: #9d97aa;
      --positive: #8fd0ae;
      --warning: #e4be78;
      --danger: #df8f92;
      --shadow: 0 20px 70px rgba(0, 0, 0, 0.32);
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
    body {
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 50% -10%, rgba(111, 74, 151, 0.15), transparent 36rem),
        var(--bg);
    }
    button, input { font: inherit; }
    .shell { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0 70px; }
    .eyebrow { color: var(--gold); letter-spacing: .17em; font-size: 11px; font-weight: 700; }
    .header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin: 18px 0 26px; }
    h1 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(34px, 6vw, 54px); font-weight: 500; }
    .code { margin-top: 7px; color: var(--muted); font-size: 14px; letter-spacing: .08em; }
    .copy-button {
      border: 1px solid var(--border-strong);
      background: rgba(216, 171, 82, .08);
      color: var(--gold-soft);
      padding: 11px 15px;
      border-radius: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .copy-button:hover { background: rgba(216, 171, 82, .13); }
    .tabs {
      display: inline-flex;
      gap: 5px;
      padding: 5px;
      border: 1px solid rgba(255,255,255,.07);
      background: rgba(255,255,255,.025);
      border-radius: 14px;
      margin-bottom: 24px;
    }
    .tab {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--muted);
      padding: 10px 18px;
      border-radius: 10px;
      cursor: pointer;
      font-weight: 650;
    }
    .tab.active { background: var(--panel-2); color: var(--text); box-shadow: inset 0 0 0 1px var(--border); }
    .notice {
      display: none;
      border: 1px solid rgba(228,190,120,.24);
      background: rgba(228,190,120,.07);
      color: #dccaa7;
      padding: 12px 14px;
      border-radius: 12px;
      margin-bottom: 18px;
      font-size: 13px;
      line-height: 1.45;
    }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .financial-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .card {
      position: relative;
      overflow: hidden;
      background: linear-gradient(180deg, rgba(23,20,31,.98), rgba(16,14,22,.98));
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 18px;
      padding: 20px;
      box-shadow: var(--shadow);
    }
    .card.primary { border-color: var(--border); }
    .card.owed { border-color: var(--border-strong); }
    .label { color: var(--muted); font-size: 12px; font-weight: 650; letter-spacing: .02em; }
    .value { margin-top: 9px; font-size: 31px; font-weight: 720; letter-spacing: -.04em; }
    .subvalue { margin-top: 5px; color: var(--muted); font-size: 12px; line-height: 1.4; }
    .money { color: var(--gold-soft); }
    .section { margin-top: 28px; }
    .section-title { display: flex; align-items: baseline; justify-content: space-between; gap: 18px; margin-bottom: 13px; }
    .section-title h2 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: 22px; font-weight: 500; }
    .section-title span { color: var(--muted); font-size: 12px; }
    .mini-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .mini { border: 1px solid rgba(255,255,255,.06); background: rgba(255,255,255,.025); border-radius: 14px; padding: 15px; }
    .mini .value { font-size: 22px; margin-top: 5px; }
    .split { display: grid; grid-template-columns: 1.15fr .85fr; gap: 14px; }
    .rows { display: grid; gap: 0; }
    .row { display: flex; justify-content: space-between; gap: 20px; padding: 13px 0; border-bottom: 1px solid rgba(255,255,255,.055); }
    .row:last-child { border-bottom: 0; }
    .row .name { color: #d7d1df; }
    .row .number { font-variant-numeric: tabular-nums; font-weight: 650; text-align: right; }
    .range-bar { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 14px; }
    .range {
      border: 1px solid rgba(255,255,255,.07);
      background: rgba(255,255,255,.02);
      color: var(--muted);
      padding: 8px 11px;
      border-radius: 999px;
      cursor: pointer;
      font-size: 12px;
    }
    .range.active { border-color: var(--border-strong); color: var(--gold-soft); background: rgba(216,171,82,.08); }
    .payout { padding: 16px 0; border-bottom: 1px solid rgba(255,255,255,.055); }
    .payout:last-child { border-bottom: 0; }
    .payout-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .payout-month { font-weight: 700; }
    .status { color: var(--muted); font-size: 12px; text-transform: capitalize; }
    .payout-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 12px; }
    .payout-metric strong { display: block; margin-top: 4px; font-size: 15px; }
    .payout-metric span { color: var(--muted); font-size: 11px; }
    .activity-wrap { overflow-x: auto; border-radius: 12px; }
    .activity-table { width: 100%; border-collapse: collapse; min-width: 760px; }
    .activity-table th {
      color: var(--muted);
      font-size: 11px;
      text-align: left;
      font-weight: 650;
      padding: 0 12px 10px;
      border-bottom: 1px solid rgba(255,255,255,.075);
    }
    .activity-table td {
      padding: 13px 12px;
      border-bottom: 1px solid rgba(255,255,255,.05);
      font-size: 13px;
      color: #ddd7e5;
      white-space: nowrap;
    }
    .activity-table tr:last-child td { border-bottom: 0; }
    .alias { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--gold-soft); font-size: 12px; }
    .badge {
      display: inline-flex;
      align-items: center;
      border: 1px solid rgba(255,255,255,.08);
      background: rgba(255,255,255,.035);
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 11px;
      color: #d8d1df;
    }
    .badge.positive { color: var(--positive); border-color: rgba(143,208,174,.22); background: rgba(143,208,174,.06); }
    .badge.warning { color: var(--warning); border-color: rgba(228,190,120,.22); background: rgba(228,190,120,.06); }
    .badge.danger { color: var(--danger); border-color: rgba(223,143,146,.22); background: rgba(223,143,146,.06); }
    .empty { color: var(--muted); font-size: 14px; padding: 16px 0; }
    .fine-print { color: var(--muted); font-size: 11px; line-height: 1.55; margin-top: 20px; }
    .hidden { display: none !important; }

    @media (max-width: 820px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .mini-grid, .financial-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .split { grid-template-columns: 1fr; }
    }
    @media (max-width: 520px) {
      .shell { width: min(100% - 22px, 1120px); padding-top: 24px; }
      .header { align-items: flex-start; flex-direction: column; }
      .copy-button { width: 100%; }
      .grid { gap: 9px; }
      .card { border-radius: 15px; padding: 16px; }
      .value { font-size: 27px; }
      .mini-grid, .financial-grid { grid-template-columns: 1fr 1fr; gap: 8px; }
      .tabs { width: 100%; }
      .tab { flex: 1; }
      .payout-grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="eyebrow">THE AGORA PARTNERS</div>
    <div class="header">
      <div>
        <h1 id="partnerName">Partner Dashboard</h1>
        <div class="code" id="partnerCode">Loading...</div>
      </div>
      <button class="copy-button" id="copyReferral" type="button">Copy Referral Link</button>
    </div>

    <div class="tabs" role="tablist" aria-label="Partner dashboard tabs">
      <button class="tab active" data-tab="overview" type="button">Overview</button>
      <button class="tab" data-tab="breakdown" type="button">Breakdown</button>
    </div>

    <div id="dataNotice" class="notice">
      No verified affiliate subscription activity yet. Subscriber metrics will populate as verified Apple transactions arrive; financial totals appear after payout data is calculated and reconciled.
    </div>

    <section id="overviewTab">
      <div class="grid">
        <article class="card primary">
          <div class="label">Total Referrals</div>
          <div class="value" id="totalReferrals">—</div>
          <div class="subvalue">Verified from Apple offer-code and subscription data</div>
        </article>
        <article class="card primary">
          <div class="label">Active Subscribers</div>
          <div class="value" id="activeSubscribers">—</div>
          <div class="subvalue">Active promo and commission-earning subscriptions</div>
        </article>
        <article class="card primary">
          <div class="label">Estimated This Month</div>
          <div class="value money" id="estimatedThisMonth">—</div>
          <div class="subvalue">Current month, not yet finalized</div>
        </article>
        <article class="card owed">
          <div class="label">Currently Owed</div>
          <div class="value money" id="currentlyOwed">—</div>
          <div class="subvalue">Finalized unpaid commission</div>
        </article>
      </div>

      <div class="section">
        <div class="section-title"><h2>Subscriber Snapshot</h2><span id="freshness"></span></div>
        <div class="mini-grid">
          <div class="mini"><div class="label">$0.99 Promo Subscribers</div><div class="value" id="promoSubscribers">—</div></div>
          <div class="mini"><div class="label">Commission-Earning Subscribers</div><div class="value" id="commissionEarningSubscribers">—</div></div>
          <div class="mini"><div class="label">Canceling</div><div class="value" id="canceling">—</div></div>
          <div class="mini"><div class="label">Promo Non-Renewals</div><div class="value" id="promoNonRenewals">—</div></div>
          <div class="mini"><div class="label">Expired</div><div class="value" id="expired">—</div></div>
          <div class="mini"><div class="label">Billing Retry</div><div class="value" id="billingRetry">—</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title"><h2>Financial Snapshot</h2></div>
        <div class="financial-grid">
          <div class="mini"><div class="label">Eligible Revenue Generated</div><div class="value money" id="lifetimeEligibleRevenue">—</div></div>
          <div class="mini"><div class="label">Lifetime Commission Earned</div><div class="value money" id="lifetimeCommissionEarned">—</div></div>
          <div class="mini"><div class="label">Lifetime Paid</div><div class="value money" id="lifetimePaid">—</div></div>
        </div>
      </div>

      <div class="section split">
        <article class="card">
          <div class="section-title"><h2>Performance</h2></div>
          <div class="rows">
            <div class="row"><span class="name">Promo Renewal Rate</span><span class="number" id="promoRenewalRate">—</span></div>
            <div class="row"><span class="name">Paid Conversion Rate</span><span class="number" id="paidConversionRate">—</span></div>
            <div class="row"><span class="name">Active Retention</span><span class="number" id="activeRetention">—</span></div>
            <div class="row"><span class="name">Cancellation Rate</span><span class="number" id="cancellationRate">—</span></div>
            <div class="row"><span class="name">Last Payment</span><span class="number" id="lastPayment">—</span></div>
          </div>
        </article>
        <article class="card">
          <div class="section-title"><h2>Commission Plan</h2></div>
          <div class="rows">
            <div class="row"><span class="name">Commission</span><span class="number" id="commissionRate">—</span></div>
            <div class="row"><span class="name">Basis</span><span class="number" id="commissionBasis">—</span></div>
            <div class="row"><span class="name">$0.99 Promo</span><span class="number">Excluded</span></div>
          </div>
        </article>
      </div>
    </section>

    <section id="breakdownTab" class="hidden">
      <div class="range-bar">
        <button class="range active" data-range="this_month" type="button">This Month</button>
        <button class="range" data-range="last_month" type="button">Last Month</button>
        <button class="range" data-range="last_3_months" type="button">Last 3 Months</button>
        <button class="range" data-range="ytd" type="button">YTD</button>
        <button class="range" data-range="lifetime" type="button">Lifetime</button>
      </div>

      <div class="split">
        <article class="card">
          <div class="section-title"><h2>Subscriber Breakdown</h2></div>
          <div class="rows" id="subscriberBreakdown"></div>
        </article>
        <article class="card">
          <div class="section-title"><h2>Performance Breakdown</h2></div>
          <div class="rows" id="performanceBreakdown"></div>
        </article>
      </div>

      <div class="section">
        <article class="card">
          <div class="section-title"><h2>Anonymous Subscriber Activity</h2><span>Up to 100 referrals in the selected period</span></div>
          <div id="subscriberActivity" class="empty">No verified subscriber activity yet.</div>
        </article>
      </div>

      <div class="section">
        <article class="card">
          <div class="section-title">
            <h2>Commission Breakdown</h2>
            <span id="commissionDataStatus"></span>
          </div>
          <div id="commissionBreakdown" class="empty">Awaiting a calculated monthly payout.</div>
        </article>
      </div>

      <div class="section">
        <article class="card">
          <div class="section-title"><h2>Payout History</h2></div>
          <div id="payoutHistory" class="empty">No payout history yet.</div>
        </article>
      </div>

      <div class="fine-print">
        Apple provides the underlying verified subscription and offer-code data. The Agora applies the affiliate's agreed commission terms and payout accounting. Promotional $0.99 payments are excluded from commission. Subscriber activity is anonymous and does not expose customer identity or Apple transaction identifiers.
      </div>
    </section>
  </main>

  <script>
    const partnerToken = ${JSON.stringify(safeToken)};
    let currentRange = 'this_month';
    let currentData = null;

    function text(id, value) {
      document.getElementById(id).textContent = value;
    }

    function number(value) {
      return value == null ? '—' : Number(value).toLocaleString();
    }

    function currencyCode() {
      const raw = String(currentData?.affiliate?.payoutCurrency || 'USD').toUpperCase();
      return /^[A-Z]{3}$/.test(raw) ? raw : 'USD';
    }

    function money(value) {
      if (value == null || value === '') return '—';
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return '—';
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currencyCode(),
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(numeric);
    }

    function percent(value) {
      if (value == null || !Number.isFinite(Number(value))) return '—';
      return Number(value).toFixed(1) + '%';
    }

    function readableBasis(value) {
      if (value === 'base_price') return 'Base Price';
      if (value === 'net_proceeds') return 'Apple Net Proceeds';
      return '—';
    }

    function monthLabel(value) {
      if (!value) return '';
      const date = new Date(value + 'T12:00:00Z');
      return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }

    function dateLabel(value, withTime = false) {
      if (!value) return '—';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '—';
      return date.toLocaleDateString(undefined, withTime
        ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
        : { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function planLabel(value) {
      if (value === 'agora_pro_yearly') return 'Yearly';
      if (value === 'agora_pro_monthly') return 'Monthly';
      return value ? 'Pro' : '—';
    }

    function statusLabel(item) {
      if (!item) return 'Unknown';
      if (
        ['active', 'trial', 'grace_period'].includes(item.status) &&
        item.autoRenewEnabled === false
      ) return 'Canceling';
      const labels = {
        active: 'Active',
        trial: 'Trial',
        grace_period: 'Grace Period',
        billing_retry: 'Billing Retry',
        expired: 'Expired',
        revoked: 'Refunded / Revoked',
        unknown: 'Unknown'
      };
      return labels[item.status] || String(item.status || 'Unknown').replaceAll('_', ' ');
    }

    function statusBadge(item) {
      const label = statusLabel(item);
      let klass = 'badge';
      if (['Active', 'Trial', 'Grace Period'].includes(label)) klass += ' positive';
      if (['Canceling', 'Billing Retry'].includes(label)) klass += ' warning';
      if (['Expired', 'Refunded / Revoked'].includes(label)) klass += ' danger';
      return '<span class="' + klass + '">' + html(label) + '</span>';
    }

    function stageBadge(stage) {
      if (stage === 'commission_earning') {
        return '<span class="badge positive">Commission-Earning</span>';
      }
      return '<span class="badge warning">$0.99 Promo</span>';
    }

    function html(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    function row(name, value) {
      return '<div class="row"><span class="name">' + html(name) + '</span><span class="number">' + html(value) + '</span></div>';
    }

    function renderSubscriberActivity(items) {
      if (!Array.isArray(items) || items.length === 0) {
        return '<div class="empty">No verified subscriber activity in this range.</div>';
      }

      const rows = items.map(item =>
        '<tr>' +
          '<td><span class="alias">' + html(item.subscriberAlias || '—') + '</span></td>' +
          '<td>' + html(dateLabel(item.joinedAt)) + '</td>' +
          '<td>' + html(planLabel(item.plan)) + '</td>' +
          '<td>' + stageBadge(item.stage) + '</td>' +
          '<td>' + statusBadge(item) + '</td>' +
          '<td>' + html(dateLabel(item.lastActivityAt, true)) + '</td>' +
        '</tr>'
      ).join('');

      return '<div class="activity-wrap"><table class="activity-table">' +
        '<thead><tr>' +
          '<th>Subscriber</th><th>Joined</th><th>Plan</th><th>Stage</th><th>Status</th><th>Last Activity</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    function render(data) {
      currentData = data;
      const o = data.overview || {};
      const b = data.breakdown || {};
      const s = b.subscriberMetrics || {};
      const p = b.performance || {};
      const payouts = b.payouts || {};

      text('partnerName', data.affiliate.displayName);
      text('partnerCode', data.affiliate.customCode);
      text('totalReferrals', number(o.totalReferrals));
      text('activeSubscribers', number(o.activeSubscribers));
      text('estimatedThisMonth', money(o.estimatedThisMonth));
      text('currentlyOwed', money(o.currentlyOwed));
      text('promoSubscribers', number(o.promoSubscribers));
      text('commissionEarningSubscribers', number(o.commissionEarningSubscribers));
      text('canceling', number(o.canceling));
      text('promoNonRenewals', number(o.promoNonRenewals));
      text('expired', number(o.expired));
      text('billingRetry', number(o.billingRetry));
      text('promoRenewalRate', percent(o.promoRenewalRate));
      text('paidConversionRate', percent(o.paidConversionRate));
      text('activeRetention', percent(o.activeRetention));
      text('cancellationRate', percent(o.cancellationRate));
      text('lastPayment', o.lastPayment ? money(o.lastPayment.amount) : '—');
      text('lifetimeEligibleRevenue', money(o.lifetimeEligibleRevenue));
      text('lifetimeCommissionEarned', money(o.lifetimeCommissionEarned));
      text('lifetimePaid', money(o.lifetimePaid));
      text('commissionRate', data.compensation ? percent(Number(data.compensation.rate) * 100) : '—');
      text('commissionBasis', readableBasis(data.compensation?.basis));

      const freshnessValue = data.dataFreshness?.latestVerifiedSubscriptionAt || data.dataFreshness?.latestAppleStateDate;
      text('freshness', freshnessValue ? 'Apple data through ' + dateLabel(freshnessValue, true) : 'Awaiting Apple data');
      document.getElementById('dataNotice').style.display = data.dataFreshness?.status === 'awaiting_apple_data' ? 'block' : 'none';

      document.getElementById('subscriberBreakdown').innerHTML = [
        row('Total Referrals', number(s.totalReferrals)),
        row('Referrals Acquired in Selected Period', number(s.newReferrals)),
        row('Active Now from Selected Period', number(s.activeSubscribers)),
        row('$0.99 Promo Now from Selected Period', number(s.promoSubscribers)),
        row('Commission-Earning Now from Selected Period', number(s.commissionEarningSubscribers)),
        row('Promo Non-Renewals', number(s.promoNonRenewals)),
        row('Canceling Now from Selected Period', number(s.canceling)),
        row('Expired', number(s.expired)),
        row('Billing Retry Now from Selected Period', number(s.billingRetry)),
      ].join('');

      document.getElementById('performanceBreakdown').innerHTML = [
        row('Promo Renewal Rate', percent(p.promoRenewalRate)),
        row('Promo Non-Renewal Rate', percent(p.promoNonRenewalRate)),
        row('Selected Cohort Paid Conversion', percent(p.paidConversionRate)),
        row('Selected Cohort Active Retention', percent(p.activeRetention)),
        row('Cancellation Rate', percent(p.cancellationRate)),
        row('Eligible Revenue Generated', money(payouts.lifetimeEligibleRevenue)),
        row('Lifetime Commission Earned', money(payouts.lifetimeCommissionEarned)),
        row('Lifetime Paid', money(payouts.lifetimePaid)),
      ].join('');

      document.getElementById('subscriberActivity').className = '';
      document.getElementById('subscriberActivity').innerHTML = renderSubscriberActivity(b.anonymousSubscriberActivity);

      const history = Array.isArray(payouts.history) ? payouts.history : [];
      const rangeStart = String(data.range?.start || '2000-01-01').slice(0, 10);
      const rangeEnd = String(data.range?.endExclusive || '2999-01-01').slice(0, 10);
      const rangeHistory = history.filter(item => {
        const period = String(item.payout_period || '').slice(0, 10);
        return period >= rangeStart && period < rangeEnd;
      });

      if (rangeHistory.length === 1) {
        text('commissionDataStatus', String(rangeHistory[0].data_status || '').replaceAll('_', ' '));
      } else if (rangeHistory.length > 1) {
        text('commissionDataStatus', rangeHistory.length + ' payout periods');
      } else {
        text('commissionDataStatus', '');
      }

      const commissionSections = rangeHistory
        .filter(item => item?.calculation_details && Object.keys(item.calculation_details).length)
        .map(item => {
          const details = item.calculation_details;
          const lines = Array.isArray(details.lines) ? details.lines : [];
          const adjustment = Number(item.adjustments_total || 0);
          const issueCount = Array.isArray(details.issues) ? details.issues.length : 0;
          const rows = [
            ...lines.map(line => row(
              (line.label || 'Subscription') + ' · ' + number(line.count) + ' × ' + money(line.unitPrice),
              money(line.revenue)
            )),
            row('Eligible Revenue', money(item.eligible_revenue)),
            row('Commission Basis', readableBasis(item.commission_basis)),
            row('Commission Rate', percent(Number(item.commission_rate) * 100)),
          ];
          if (adjustment !== 0) rows.push(row('Adjustments', money(adjustment)));
          rows.push(row(item.status === 'open' ? 'Estimated Commission' : 'Final Commission', money(item.amount_due)));
          if (issueCount > 0) rows.push(row('Held / Review Items', number(issueCount)));

          return '<div class="payout">' +
            '<div class="payout-head"><div class="payout-month">' + html(monthLabel(item.payout_period)) + '</div>' +
            '<div class="status">' + html(String(item.data_status || '').replaceAll('_', ' ')) + '</div></div>' +
            '<div class="rows">' + rows.join('') + '</div>' +
          '</div>';
        });

      if (commissionSections.length) {
        document.getElementById('commissionBreakdown').className = '';
        document.getElementById('commissionBreakdown').innerHTML = commissionSections.join('');
      } else {
        document.getElementById('commissionBreakdown').className = 'empty';
        document.getElementById('commissionBreakdown').textContent = 'Awaiting a calculated monthly payout for this range.';
      }

      if (!history.length) {
        document.getElementById('payoutHistory').className = 'empty';
        document.getElementById('payoutHistory').textContent = 'No payout history yet.';
      } else {
        document.getElementById('payoutHistory').className = '';
        document.getElementById('payoutHistory').innerHTML = history.map(item =>
          '<div class="payout">' +
            '<div class="payout-head">' +
              '<div class="payout-month">' + html(monthLabel(item.payout_period)) + '</div>' +
              '<div class="status">' + html(String(item.status || '').replaceAll('_', ' ')) + '</div>' +
            '</div>' +
            '<div class="payout-grid">' +
              '<div class="payout-metric"><span>Commission</span><strong>' + html(money(item.amount_due)) + '</strong></div>' +
              '<div class="payout-metric"><span>Paid</span><strong>' + html(money(item.amount_paid)) + '</strong></div>' +
              '<div class="payout-metric"><span>Remaining</span><strong>' + html(money(item.outstanding)) + '</strong></div>' +
              '<div class="payout-metric"><span>Data</span><strong>' + html(String(item.data_status || '').replaceAll('_', ' ')) + '</strong></div>' +
            '</div>' +
          '</div>'
        ).join('');
      }
    }

    async function load(range = currentRange) {
      const response = await fetch('/api/partner/' + encodeURIComponent(partnerToken) + '/dashboard?range=' + encodeURIComponent(range), {
        cache: 'no-store',
        credentials: 'omit'
      });

      if (!response.ok) {
        document.body.innerHTML = '<main class="shell"><div class="eyebrow">THE AGORA PARTNERS</div><h1 style="margin-top:18px">Dashboard unavailable</h1><p style="color:var(--muted)">This private dashboard link is no longer active.</p></main>';
        return;
      }

      const payload = await response.json();
      render(payload.data);
    }

    document.querySelectorAll('.tab').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === button));
        const overview = button.dataset.tab === 'overview';
        document.getElementById('overviewTab').classList.toggle('hidden', !overview);
        document.getElementById('breakdownTab').classList.toggle('hidden', overview);
      });
    });

    document.querySelectorAll('.range').forEach(button => {
      button.addEventListener('click', async () => {
        currentRange = button.dataset.range;
        document.querySelectorAll('.range').forEach(item => item.classList.toggle('active', item === button));
        await load(currentRange);
      });
    });

    document.getElementById('copyReferral').addEventListener('click', async () => {
      if (!currentData?.affiliate?.referralUrl) return;
      await navigator.clipboard.writeText(currentData.affiliate.referralUrl);
      const button = document.getElementById('copyReferral');
      const old = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = old; }, 1200);
    });

    load();
  </script>
</body>
</html>`;
}

export function createAffiliateRouter(pool, options = {}) {
  const router = express.Router();
  const adminKey = options.adminKey || process.env.AFFILIATE_ADMIN_KEY;
  const appAppleId = options.appAppleId || process.env.AFFILIATE_APPLE_APP_ID;
  const tokenEncryptionKey = options.tokenEncryptionKey || process.env.AFFILIATE_TOKEN_ENCRYPTION_KEY;

  const service = options.service || createAffiliateProgramService({
    pool,
    appAppleId,
    tokenEncryptionKey,
    partnerBaseUrl: options.partnerBaseUrl || process.env.AFFILIATE_PARTNER_BASE_URL,
    referralBaseUrl: options.referralBaseUrl || process.env.AFFILIATE_REFERRAL_BASE_URL,
  });

  const adminOnly = requireAdminKey(adminKey);
  const referralLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many referral requests. Please try again shortly.',
  });
  const partnerLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { code: 'partner_rate_limited', message: 'Too many dashboard requests.' } },
  });
  const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { code: 'affiliate_admin_rate_limited', message: 'Too many admin requests.' } },
  });

  router.use('/api/partner', partnerLimiter, privateApiHeaders);
  router.use('/api/admin', adminLimiter, privateApiHeaders);

  router.get('/r/:code', referralLimiter, async (req, res) => {
    try {
      const referrerHost = (() => {
        try {
          return req.get('referer') ? new URL(req.get('referer')).hostname : null;
        } catch {
          return null;
        }
      })();

      const result = await service.recordReferralClick({
        code: req.params.code,
        referrerHost,
      });

      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, result.redirectUrl);
    } catch (error) {
      if (error?.statusCode === 404) {
        return res.status(404).type('text/plain').send('This referral link is not active.');
      }
      console.error('[affiliate] referral redirect:', error);
      return res.status(500).type('text/plain').send('Unable to open this referral link.');
    }
  });

  router.get('/partners/:token', partnerLimiter, partnerSecurityHeaders, async (req, res) => {
    try {
      await service.resolvePartnerToken(req.params.token, { touch: false });
      return res.type('html').send(renderPartnerDashboardPage(req.params.token));
    } catch (error) {
      return res.status(404).type('text/plain').send('This private dashboard link is no longer active.');
    }
  });

  // Supports the final partners.theagora.app/<token> URL without claiming
  // arbitrary root paths on the main backend hostname.
  router.get('/:token', partnerLimiter, partnerSecurityHeaders, async (req, res, next) => {
    const host = String(req.hostname || '').toLowerCase();
    if (!host.startsWith('partners.')) {
      return next();
    }

    try {
      await service.resolvePartnerToken(req.params.token, { touch: false });
      return res.type('html').send(renderPartnerDashboardPage(req.params.token));
    } catch {
      return res.status(404).type('text/plain').send('This private dashboard link is no longer active.');
    }
  });

  router.get('/api/partner/:token/dashboard', async (req, res) => {
    try {
      const data = await service.getDashboardData(req.params.token, req.query.range);
      return res.json({ success: true, data });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.get('/api/admin/affiliates', adminOnly, async (_req, res) => {
    try {
      const affiliates = await service.listAffiliates();
      return res.json({ success: true, affiliates });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.post('/api/admin/affiliates', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const created = await service.createAffiliate(req.body || {}, actor);
      return res.status(201).json({ success: true, ...created });
    } catch (error) {
      if (error?.code === '23505') {
        const constraint = String(error?.constraint || '');
        error.statusCode = 409;

        if (constraint === 'affiliates_offer_identifier_unique_idx') {
          error.code = 'affiliate_offer_identifier_already_exists';
          error.message =
            'That App Store Connect offer reference is already assigned to another affiliate.';
        } else if (
          constraint === 'affiliates_normalized_code_unique' ||
          constraint === 'affiliates_normalized_code_unique_idx' ||
          constraint === 'affiliates_custom_code_ci_uidx'
        ) {
          error.code = 'affiliate_code_already_exists';
          error.message = 'That affiliate code already exists.';
        } else {
          error.code = 'affiliate_unique_conflict';
          error.message =
            'That affiliate conflicts with an existing unique affiliate record.';
        }
      }
      return jsonError(res, error);
    }
  });

  router.post('/api/admin/affiliates/:id/regenerate-dashboard-token', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const result = await service.regeneratePartnerToken(req.params.id, actor);
      return res.json({ success: true, ...result });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.get('/api/admin/affiliates/:id/dashboard-link', adminOnly, async (req, res) => {
    try {
      const result = await service.getPartnerDashboardLink(req.params.id);
      return res.json({ success: true, ...result });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  // Temporary normalized ingestion boundary. The Apple Analytics Reports API
  // collector will feed this exact service after we inspect a real State/Event
  // report from The Agora. Until then, this endpoint lets us test dashboard and
  // payout behavior without inventing Apple's raw CSV schema.
  router.post('/api/admin/affiliate-apple-metrics/import', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const result = await service.importNormalizedAppleMetrics({
        rows: req.body?.rows,
        source: req.body?.source,
        actor,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.post('/api/admin/affiliate-payouts/refresh', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const result = await service.refreshMonthlyPayout({
        affiliateId: req.body?.affiliateId,
        payoutPeriod: req.body?.payoutPeriod,
        finalize: readJsonBoolean(req.body?.finalize, 'finalize', false),
        markReconciled: readJsonBoolean(req.body?.markReconciled, 'markReconciled', false),
        actor,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.post('/api/admin/affiliate-payouts/finalize-period', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const result = await service.finalizeAffiliatePayoutsForPeriod({
        payoutPeriod: req.body?.payoutPeriod,
        markReconciled: readJsonBoolean(req.body?.markReconciled, 'markReconciled', false),
        includeTest: readJsonBoolean(req.body?.includeTest, 'includeTest', false),
        actor,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.post('/api/admin/affiliate-adjustments', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const result = await service.createManualAdjustment({
        affiliateId: req.body?.affiliateId,
        amount: req.body?.amount,
        targetPeriod: req.body?.targetPeriod,
        sourcePeriod: req.body?.sourcePeriod,
        adjustmentType: req.body?.adjustmentType,
        reason: req.body?.reason,
        idempotencyKey: req.get('idempotency-key'),
        actor,
      });
      return res.status(201).json({ success: true, ...result });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.post('/api/admin/affiliate-payouts/:id/payments', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const result = await service.recordPayoutPayment({
        payoutId: req.params.id,
        amount: req.body?.amount,
        paymentDate: req.body?.paymentDate,
        paymentMethod: req.body?.paymentMethod,
        paymentReference: req.body?.paymentReference,
        note: req.body?.note,
        idempotencyKey: req.get('idempotency-key'),
        actor,
      });
      return res.status(201).json({ success: true, ...result });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.post('/api/admin/affiliate-payouts/:payoutId/payments/:paymentId/corrections', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const result = await service.recordPayoutPaymentCorrection({
        payoutId: req.params.payoutId,
        paymentId: req.params.paymentId,
        amount: req.body?.amount,
        paymentDate: req.body?.paymentDate,
        reason: req.body?.reason,
        idempotencyKey: req.get('idempotency-key'),
        actor,
      });
      return res.status(201).json({ success: true, ...result });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  return router;
}

export { renderPartnerDashboardPage };
