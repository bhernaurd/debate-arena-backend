import crypto from 'crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';

import {
  createAffiliateProgramService,
} from './lib/affiliateProgramService.js';
import {
  createAppStoreConnectAffiliateService,
} from './lib/appStoreConnectAffiliateService.js';
import {
  createAffiliateAppleImportPreferencesService,
} from './lib/affiliateAppleImportPreferencesService.js';

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

function renderInfoButton(label, description) {
  const safeLabel = escapeHtml(label);
  const safeDescription = escapeHtml(description);

  return `<button
    class="info-button"
    type="button"
    aria-label="About ${safeLabel}"
    aria-expanded="false"
    aria-describedby="infoTooltip"
    data-info-title="${safeLabel}"
    data-info-text="${safeDescription}"
  >i</button>`;
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
    .section-note { color: var(--muted); font-size: 12px; line-height: 1.45; margin: -4px 0 12px; }
    .mini-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .mini { position: relative; border: 1px solid rgba(255,255,255,.06); background: rgba(255,255,255,.025); border-radius: 14px; padding: 15px; }
    .mini .value { font-size: 22px; margin-top: 5px; }
    .metric-heading {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }
    .metric-heading .label { min-width: 0; }
    .name-with-info,
    .title-with-info {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .info-button {
      appearance: none;
      width: 18px;
      height: 18px;
      min-width: 18px;
      padding: 0;
      border: 1px solid rgba(216,171,82,.34);
      border-radius: 999px;
      background: rgba(216,171,82,.055);
      color: var(--gold-soft);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      opacity: .72;
      transition: opacity .15s ease, background .15s ease, border-color .15s ease, transform .15s ease;
      flex: 0 0 auto;
    }
    .info-button:hover,
    .info-button:focus-visible,
    .info-button[aria-expanded="true"] {
      opacity: 1;
      border-color: rgba(216,171,82,.66);
      background: rgba(216,171,82,.12);
      outline: none;
    }
    .info-button:active { transform: scale(.96); }
    .info-tooltip {
      position: fixed;
      z-index: 1000;
      display: none;
      width: min(300px, calc(100vw - 24px));
      padding: 13px 14px;
      border: 1px solid rgba(216,171,82,.34);
      border-radius: 12px;
      background: rgba(22,18,28,.985);
      box-shadow: 0 18px 55px rgba(0,0,0,.52);
      color: #ddd5e2;
      pointer-events: none;
    }
    .info-tooltip.open { display: block; }
    .info-tooltip-title {
      color: var(--gold-soft);
      font-size: 12px;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 5px;
    }
    .info-tooltip-text {
      color: #c8c0ce;
      font-size: 12px;
      line-height: 1.48;
    }
    .split { display: grid; grid-template-columns: 1.15fr .85fr; gap: 14px; }
    .rows { display: grid; gap: 0; }
    .row { display: flex; justify-content: space-between; gap: 20px; padding: 13px 0; border-bottom: 1px solid rgba(255,255,255,.055); }
    .row:last-child { border-bottom: 0; }
    .row .name { color: #d7d1df; }
    .row .number { font-variant-numeric: tabular-nums; font-weight: 650; text-align: right; }
    .period-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 14px;
    }
    .month-navigator {
      display: grid;
      grid-template-columns: 38px minmax(188px, auto) 38px;
      align-items: stretch;
      border: 1px solid rgba(255,255,255,.075);
      border-radius: 13px;
      background: rgba(255,255,255,.018);
      overflow: hidden;
    }
    .month-navigator.aggregate-mode { opacity: .56; }
    .month-arrow {
      border: 0;
      background: transparent;
      color: #d9d2df;
      cursor: pointer;
      font-size: 19px;
      line-height: 1;
      transition: background .15s ease, color .15s ease, opacity .15s ease;
    }
    .month-arrow:hover:not(:disabled),
    .month-arrow:focus-visible:not(:disabled) {
      background: rgba(216,171,82,.08);
      color: var(--gold-soft);
      outline: none;
    }
    .month-arrow:disabled { opacity: .22; cursor: default; }
    .month-selector {
      position: relative;
      min-width: 188px;
      padding: 8px 18px;
      border-left: 1px solid rgba(255,255,255,.06);
      border-right: 1px solid rgba(255,255,255,.06);
      text-align: center;
      cursor: pointer;
    }
    .month-title {
      color: #f0ebf2;
      font-weight: 700;
      font-size: 14px;
      line-height: 1.25;
    }
    .month-status {
      margin-top: 2px;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.2;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .month-input {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      cursor: pointer;
    }
    .range-bar { display: flex; flex-wrap: wrap; gap: 7px; }
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
      .period-controls { align-items: stretch; }
      .month-navigator { width: 100%; grid-template-columns: 40px minmax(0, 1fr) 40px; }
      .month-selector { min-width: 0; }
      .range-bar { width: 100%; }
      .range { flex: 1; text-align: center; }
      .info-button { width: 20px; height: 20px; min-width: 20px; }
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
          <div class="metric-heading">
            <div class="label">Total Referrals</div>
            ${renderInfoButton(
              'Total Referrals',
              'The total number of verified Apple subscription chains attributed to your creator code. Each subscription chain is counted once, even when it renews.'
            )}
          </div>
          <div class="value" id="totalReferrals">—</div>
          <div class="subvalue">Verified from Apple offer-code and subscription data</div>
        </article>
        <article class="card primary">
          <div class="metric-heading">
            <div class="label">Current Subscribers</div>
            ${renderInfoButton(
              'Current Subscribers',
              'The number of referred subscribers who currently still have subscription access. This is one overall total, not an additional subscriber state.'
            )}
          </div>
          <div class="value" id="currentSubscribers">—</div>
          <div class="subvalue">Referred subscribers with access right now</div>
        </article>
        <article class="card primary">
          <div class="metric-heading">
            <div class="label">Estimated This Month</div>
            ${renderInfoButton(
              'Estimated This Month',
              'Your current-month commission estimate based on data available so far. It can change before the month is finalized and reconciled.'
            )}
          </div>
          <div class="value money" id="estimatedThisMonth">—</div>
          <div class="subvalue">Current month, not yet finalized</div>
        </article>
        <article class="card owed">
          <div class="metric-heading">
            <div class="label">Currently Owed</div>
            ${renderInfoButton(
              'Currently Owed',
              'Finalized commission that has not yet been paid. Open monthly estimates are not included here until they are finalized.'
            )}
          </div>
          <div class="value money" id="currentlyOwed">—</div>
          <div class="subvalue">Finalized unpaid commission</div>
        </article>
      </div>

      <div class="section">
        <div class="section-title"><h2>Subscriber Snapshot</h2><span id="freshness"></span></div>
        <div class="section-note">Each referred subscriber appears in one current state only.</div>
        <div class="mini-grid">
          <div class="mini">
            <div class="metric-heading">
              <div class="label">Promo Active</div>
              ${renderInfoButton(
                'Promo Active',
                'Subscribers currently in the $0.99 first-month promotional period. Each subscriber appears in only one current-state box. If auto-renew is turned off during the promo, the subscriber remains Promo Active until that access period ends.'
              )}
            </div>
            <div class="value" id="promoActiveSubscribers">—</div>
          </div>
          <div class="mini">
            <div class="metric-heading">
              <div class="label">Paid + Renewing</div>
              ${renderInfoButton(
                'Paid + Renewing',
                'Commission-earning paid subscribers who currently have access and still have auto-renew enabled.'
              )}
            </div>
            <div class="value" id="paidRenewingSubscribers">—</div>
          </div>
          <div class="mini">
            <div class="metric-heading">
              <div class="label">Paid + Canceling</div>
              ${renderInfoButton(
                'Paid + Canceling',
                'Commission-earning paid subscribers who turned off auto-renew but still have access until the end of their current paid period.'
              )}
            </div>
            <div class="value" id="paidCancelingSubscribers">—</div>
          </div>
          <div class="mini">
            <div class="metric-heading">
              <div class="label">Billing Retry</div>
              ${renderInfoButton(
                'Billing Retry',
                'Subscribers whose renewal payment failed and for whom Apple is attempting billing recovery. They are kept in this separate current-state bucket while recovery is pending.'
              )}
            </div>
            <div class="value" id="billingRetry">—</div>
          </div>
          <div class="mini">
            <div class="metric-heading">
              <div class="label">Expired</div>
              ${renderInfoButton(
                'Expired',
                'Referred subscriptions whose access has ended. Revoked or refunded entitlements with no current access are also treated as ended for this current-state view.'
              )}
            </div>
            <div class="value" id="expired">—</div>
          </div>
          <div class="mini hidden" id="pendingStateBox">
            <div class="metric-heading">
              <div class="label">Pending Apple State</div>
              ${renderInfoButton(
                'Pending Apple State',
                'A verified referral exists, but the latest entitlement state has not arrived yet. This temporary safeguard prevents the subscriber from being silently omitted or double-counted while Apple data is still syncing.'
              )}
            </div>
            <div class="value" id="pendingStateSubscribers">—</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title"><h2>Financial Snapshot</h2></div>
        <div class="financial-grid">
          <div class="mini">
            <div class="metric-heading">
              <div class="label">Eligible Revenue Generated</div>
              ${renderInfoButton(
                'Eligible Revenue Generated',
                'The total revenue that has been accepted as commission eligible under your compensation agreement. Promotional $0.99 payments are excluded.'
              )}
            </div>
            <div class="value money" id="lifetimeEligibleRevenue">—</div>
          </div>
          <div class="mini">
            <div class="metric-heading">
              <div class="label">Lifetime Commission Earned</div>
              ${renderInfoButton(
                'Lifetime Commission Earned',
                'The total commission credited to you across finalized payout periods, including finalized adjustments.'
              )}
            </div>
            <div class="value money" id="lifetimeCommissionEarned">—</div>
          </div>
          <div class="mini">
            <div class="metric-heading">
              <div class="label">Lifetime Paid</div>
              ${renderInfoButton(
                'Lifetime Paid',
                'The total amount of commission payments recorded as paid to you over the life of your affiliate account.'
              )}
            </div>
            <div class="value money" id="lifetimePaid">—</div>
          </div>
        </div>
      </div>

      <div class="section split">
        <article class="card">
          <div class="section-title"><h2>Performance</h2></div>
          <div class="rows">
            <div class="row"><span class="name name-with-info">Promo Renewal Rate ${renderInfoButton(
              'Promo Renewal Rate',
              'The percentage of attributed $0.99 promo subscribers who later produced a verified commission-eligible paid renewal.'
            )}</span><span class="number" id="promoRenewalRate">—</span></div>
            <div class="row"><span class="name name-with-info">Promo Non-Renewals ${renderInfoButton(
              'Promo Non-Renewals',
              'The number of referred subscribers whose $0.99 promotional period ended without a later commission-eligible paid renewal being verified.'
            )}</span><span class="number" id="promoNonRenewals">—</span></div>
            <div class="row"><span class="name name-with-info">Paid Conversion Rate ${renderInfoButton(
              'Paid Conversion Rate',
              'The percentage of your attributed referrals that have ever reached a commission-earning paid subscription. A subscriber still counts as converted even if they later cancel or expire.'
            )}</span><span class="number" id="paidConversionRate">—</span></div>
            <div class="row"><span class="name name-with-info">Active Retention ${renderInfoButton(
              'Active Retention',
              'The percentage of your attributed referrals that still have subscription access right now. This measures current retention, so subscribers who previously converted but later expired are not counted as active.'
            )}</span><span class="number" id="activeRetention">—</span></div>
            <div class="row"><span class="name name-with-info">Cancellation Rate ${renderInfoButton(
              'Cancellation Rate',
              'The percentage of attributed active subscribers who have turned off auto-renew and are currently scheduled to end.'
            )}</span><span class="number" id="cancellationRate">—</span></div>
            <div class="row"><span class="name name-with-info">Last Payment ${renderInfoButton(
              'Last Payment',
              'The most recent commission payment recorded as paid to you.'
            )}</span><span class="number" id="lastPayment">—</span></div>
          </div>
        </article>
        <article class="card">
          <div class="section-title"><h2>Commission Plan</h2></div>
          <div class="rows">
            <div class="row"><span class="name name-with-info">Commission ${renderInfoButton(
              'Commission',
              'Your agreed commission percentage. The current early-affiliate rate is 50%.'
            )}</span><span class="number" id="commissionRate">—</span></div>
            <div class="row"><span class="name name-with-info">Basis ${renderInfoButton(
              'Commission Basis',
              'Base Price means commission is calculated from the approved revenue basis. Apple Net Proceeds means commission is calculated from Apple\'s actual reported proceeds rather than estimated fees, taxes, or currency deductions.'
            )}</span><span class="number" id="commissionBasis">—</span></div>
            <div class="row"><span class="name name-with-info">$0.99 Promo ${renderInfoButton(
              '$0.99 Promo',
              'The promotional $0.99 payment is excluded from commission. Commission begins only when a transaction becomes commission eligible under your plan.'
            )}</span><span class="number">Excluded</span></div>
          </div>
        </article>
      </div>
    </section>

    <section id="breakdownTab" class="hidden">
      <div class="period-controls">
        <div class="month-navigator" aria-label="Affiliate payout month">
          <button class="month-arrow" id="previousMonth" type="button" aria-label="Previous month">‹</button>
          <div class="month-selector" title="Choose a month">
            <div class="month-title" id="selectedMonthLabel">Loading month…</div>
            <div class="month-status" id="selectedMonthStatus">In Progress</div>
            <input class="month-input" id="monthPicker" type="month" aria-label="Choose dashboard month">
          </div>
          <button class="month-arrow" id="nextMonth" type="button" aria-label="Next month">›</button>
        </div>

        <div class="range-bar" aria-label="Broader dashboard ranges">
          <button class="range" data-range="ytd" type="button">YTD</button>
          <button class="range" data-range="lifetime" type="button">Lifetime</button>
        </div>
      </div>

      <div class="split">
        <article class="card">
          <div class="section-title"><div class="title-with-info"><h2>Subscriber Breakdown</h2>${renderInfoButton(
            'Subscriber Breakdown',
            'Shows referrals acquired in the selected period and places each one into exactly one current subscription state. Historical ranges describe that cohort\'s state now, not a reconstructed historical snapshot.'
          )}</div></div>
          <div class="rows" id="subscriberBreakdown"></div>
        </article>
        <article class="card">
          <div class="section-title"><div class="title-with-info"><h2>Performance Breakdown</h2>${renderInfoButton(
            'Performance Breakdown',
            'Shows promo outcomes, paid conversion, current retention, and cancellation for referrals acquired in the selected range. Paid conversion means ever converted to a commission-earning subscription; active retention means still active now.'
          )}</div></div>
          <div class="rows" id="performanceBreakdown"></div>
        </article>
      </div>

      <div class="section">
        <article class="card">
          <div class="section-title"><div class="title-with-info"><h2>Anonymous Subscriber Activity</h2>${renderInfoButton(
            'Anonymous Subscriber Activity',
            'A privacy-safe activity view of attributed subscriptions. It intentionally does not expose customer identity, Agora account IDs, Apple transaction IDs, or other personal identifiers.'
          )}</div><span>Up to 100 referrals in the selected period</span></div>
          <div id="subscriberActivity" class="empty">No verified subscriber activity yet.</div>
        </article>
      </div>

      <div class="section">
        <article class="card">
          <div class="section-title">
            <div class="title-with-info"><h2>Commission Breakdown</h2>${renderInfoButton(
              'Commission Breakdown',
              'Shows how commission was calculated for the selected payout period, including eligible revenue, commission basis, commission rate, adjustments, and any items held for review.'
            )}</div>
            <span id="commissionDataStatus"></span>
          </div>
          <div id="commissionBreakdown" class="empty">Awaiting a calculated monthly payout.</div>
        </article>
      </div>

      <div class="section">
        <article class="card">
          <div class="section-title"><div class="title-with-info"><h2>Payout History</h2>${renderInfoButton(
            'Payout History',
            'A record of finalized affiliate payout periods and payments recorded as sent, including any remaining unpaid balance.'
          )}</div></div>
          <div id="payoutHistory" class="empty">No payout history yet.</div>
        </article>
      </div>

      <div class="fine-print">
        Apple provides the underlying verified subscription and offer-code data. The Agora applies the affiliate's agreed commission terms and payout accounting. Promotional $0.99 payments are excluded from commission. Subscriber activity is anonymous and does not expose customer identity or Apple transaction identifiers.
      </div>
    </section>
  </main>

  <div id="infoTooltip" class="info-tooltip" role="tooltip" aria-hidden="true">
    <div id="infoTooltipTitle" class="info-tooltip-title"></div>
    <div id="infoTooltipText" class="info-tooltip-text"></div>
  </div>

  <script>
    const partnerToken = ${JSON.stringify(safeToken)};
    let currentRange = 'this_month';
    let currentMonthKey = null;
    let currentData = null;
    const infoTooltip = document.getElementById('infoTooltip');
    const infoTooltipTitle = document.getElementById('infoTooltipTitle');
    const infoTooltipText = document.getElementById('infoTooltipText');
    let activeInfoButton = null;
    let infoTooltipPinned = false;

    function positionInfoTooltip(button) {
      if (!button || !infoTooltip.classList.contains('open')) return;

      const margin = 12;
      const gap = 8;
      const buttonRect = button.getBoundingClientRect();
      const tooltipRect = infoTooltip.getBoundingClientRect();

      let left = buttonRect.right - tooltipRect.width;
      left = Math.max(margin, Math.min(left, window.innerWidth - tooltipRect.width - margin));

      let top = buttonRect.bottom + gap;
      if (top + tooltipRect.height > window.innerHeight - margin) {
        top = buttonRect.top - tooltipRect.height - gap;
      }
      top = Math.max(margin, Math.min(top, window.innerHeight - tooltipRect.height - margin));

      infoTooltip.style.left = Math.round(left) + 'px';
      infoTooltip.style.top = Math.round(top) + 'px';
    }

    function showInfoTooltip(button, pinned = false) {
      if (!button) return;

      if (activeInfoButton && activeInfoButton !== button) {
        activeInfoButton.setAttribute('aria-expanded', 'false');
      }

      activeInfoButton = button;
      infoTooltipPinned = pinned;
      infoTooltipTitle.textContent = button.dataset.infoTitle || 'About this metric';
      infoTooltipText.textContent = button.dataset.infoText || '';
      button.setAttribute('aria-expanded', 'true');
      infoTooltip.setAttribute('aria-hidden', 'false');
      infoTooltip.classList.add('open');
      positionInfoTooltip(button);
    }

    function hideInfoTooltip() {
      if (activeInfoButton) {
        activeInfoButton.setAttribute('aria-expanded', 'false');
      }
      activeInfoButton = null;
      infoTooltipPinned = false;
      infoTooltip.classList.remove('open');
      infoTooltip.setAttribute('aria-hidden', 'true');
    }

    document.querySelectorAll('.info-button').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();

        if (activeInfoButton === button && infoTooltipPinned) {
          hideInfoTooltip();
          return;
        }

        showInfoTooltip(button, true);
      });

      button.addEventListener('mouseenter', () => {
        if (!infoTooltipPinned) showInfoTooltip(button, false);
      });

      button.addEventListener('mouseleave', () => {
        if (!infoTooltipPinned && activeInfoButton === button) {
          hideInfoTooltip();
        }
      });

      button.addEventListener('focus', () => {
        if (!infoTooltipPinned) showInfoTooltip(button, false);
      });

      button.addEventListener('blur', () => {
        if (!infoTooltipPinned && activeInfoButton === button) {
          hideInfoTooltip();
        }
      });
    });

    document.addEventListener('click', event => {
      if (!activeInfoButton) return;
      if (activeInfoButton.contains(event.target)) return;
      hideInfoTooltip();
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') hideInfoTooltip();
    });

    window.addEventListener('resize', () => {
      if (activeInfoButton) positionInfoTooltip(activeInfoButton);
    });

    window.addEventListener('scroll', () => {
      if (activeInfoButton) positionInfoTooltip(activeInfoButton);
    }, true);

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

    function validMonthKey(value) {
      return /^\d{4}-\d{2}$/.test(String(value || ''));
    }

    function monthKeyLabel(value) {
      if (!validMonthKey(value)) return '';
      const [year, month] = value.split('-').map(Number);
      const date = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
      return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    }

    function shiftMonthKey(value, delta) {
      if (!validMonthKey(value)) return null;
      const [year, month] = value.split('-').map(Number);
      const date = new Date(Date.UTC(year, month - 1 + delta, 1, 12, 0, 0));
      return String(date.getUTCFullYear()).padStart(4, '0') + '-' + String(date.getUTCMonth() + 1).padStart(2, '0');
    }

    function selectedMonthStatus(data) {
      const range = data?.range || {};
      if (range.kind !== 'month') return 'Monthly View';
      if (range.isCurrentMonth) return 'In Progress';

      const monthKey = range.monthKey;
      const history = Array.isArray(data?.breakdown?.payouts?.history)
        ? data.breakdown.payouts.history
        : [];
      const payout = history.find(item => String(item?.payout_period || '').slice(0, 7) === monthKey);

      if (!payout) {
        const referrals = Number(data?.breakdown?.subscriberMetrics?.newReferrals || 0);
        return referrals === 0 ? 'No Activity' : 'Awaiting Finalization';
      }
      if (payout.status === 'paid') {
        return Number(payout.amount_due || 0) > 0 ? 'Paid' : 'Finalized';
      }
      if (payout.status === 'partially_paid') return 'Partially Paid';
      if (payout.status === 'ready_to_pay') return 'Finalized';
      if (payout.status === 'open') return 'In Review';
      return String(payout.status || 'Awaiting Finalization').replaceAll('_', ' ');
    }

    function updatePeriodControls(data) {
      const range = data?.range || {};
      const navigator = document.querySelector('.month-navigator');
      const picker = document.getElementById('monthPicker');
      const previous = document.getElementById('previousMonth');
      const next = document.getElementById('nextMonth');
      const monthly = range.kind === 'month';

      if (monthly && validMonthKey(range.monthKey)) {
        currentMonthKey = range.monthKey;
      } else if (!currentMonthKey && validMonthKey(range.currentMonthKey)) {
        currentMonthKey = range.currentMonthKey;
      }

      const maxMonth = validMonthKey(range.currentMonthKey)
        ? range.currentMonthKey
        : currentMonthKey;
      // Allow partners to inspect earlier calendar months as explicit zero/no-activity
      // periods. This keeps monthly accounting navigation predictable even before
      // the affiliate's first attributed subscriber or payout record exists.
      const minMonth = '2000-01';

      picker.min = minMonth;
      picker.max = maxMonth || '';
      picker.value = currentMonthKey || maxMonth || '';

      text('selectedMonthLabel', monthly
        ? (range.label || monthKeyLabel(currentMonthKey))
        : monthKeyLabel(currentMonthKey));
      text('selectedMonthStatus', selectedMonthStatus(data));

      navigator.classList.toggle('aggregate-mode', !monthly);
      previous.disabled = !currentMonthKey || currentMonthKey <= minMonth;
      next.disabled = !currentMonthKey || !maxMonth || currentMonthKey >= maxMonth;

      document.querySelectorAll('.range').forEach(button => {
        button.classList.toggle('active', button.dataset.range === range.key);
      });
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

    function currentStateLabel(value) {
      const labels = {
        promo_active: 'Promo Active',
        paid_renewing: 'Paid + Renewing',
        paid_canceling: 'Paid + Canceling',
        billing_retry: 'Billing Retry',
        expired: 'Expired',
        pending: 'Pending Apple State'
      };
      return labels[value] || 'Pending Apple State';
    }

    function currentStateBadge(value) {
      const label = currentStateLabel(value);
      let klass = 'badge';
      if (label === 'Paid + Renewing') klass += ' positive';
      if (['Promo Active', 'Paid + Canceling', 'Billing Retry'].includes(label)) klass += ' warning';
      if (label === 'Expired') klass += ' danger';
      return '<span class="' + klass + '">' + html(label) + '</span>';
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
          '<td>' + currentStateBadge(item.currentState) + '</td>' +
          '<td>' + html(dateLabel(item.lastActivityAt, true)) + '</td>' +
        '</tr>'
      ).join('');

      return '<div class="activity-wrap"><table class="activity-table">' +
        '<thead><tr>' +
          '<th>Subscriber</th><th>Joined</th><th>Plan</th><th>Current State</th><th>Last Activity</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    function render(data) {
      currentData = data;
      const o = data.overview || {};
      const b = data.breakdown || {};
      const s = b.subscriberMetrics || {};
      const p = b.performance || {};
      const payouts = b.payouts || {};

      currentRange = data.range?.key || currentRange;
      updatePeriodControls(data);

      text('partnerName', data.affiliate.displayName);
      text('partnerCode', data.affiliate.customCode);
      text('totalReferrals', number(o.totalReferrals));
      text('currentSubscribers', number(o.currentSubscribers ?? o.activeSubscribers));
      text('estimatedThisMonth', money(o.estimatedThisMonth));
      text('currentlyOwed', money(o.currentlyOwed));

      text('promoActiveSubscribers', number(o.promoActiveSubscribers ?? o.promoSubscribers));
      text('paidRenewingSubscribers', number(o.paidRenewingSubscribers));
      text('paidCancelingSubscribers', number(o.paidCancelingSubscribers));
      text('billingRetry', number(o.billingRetry));
      text('expired', number(o.expired));
      text('pendingStateSubscribers', number(o.pendingStateSubscribers));

      const pendingStateBox = document.getElementById('pendingStateBox');
      const pendingStateCount = Number(o.pendingStateSubscribers || 0);
      pendingStateBox.classList.toggle(
        'hidden',
        o.pendingStateSubscribers == null || pendingStateCount === 0
      );

      text('promoNonRenewals', number(o.promoNonRenewals));
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

      const subscriberRows = [
        row('Referrals Acquired in Selected Period', number(s.newReferrals)),
        row('Promo Active', number(s.promoActiveSubscribers ?? s.promoSubscribers)),
        row('Paid + Renewing', number(s.paidRenewingSubscribers)),
        row('Paid + Canceling', number(s.paidCancelingSubscribers)),
        row('Billing Retry', number(s.billingRetry)),
        row('Expired', number(s.expired)),
      ];
      if (Number(s.pendingStateSubscribers || 0) > 0) {
        subscriberRows.push(
          row('Pending Apple State', number(s.pendingStateSubscribers))
        );
      }
      document.getElementById('subscriberBreakdown').innerHTML = subscriberRows.join('');

      document.getElementById('performanceBreakdown').innerHTML = [
        row('Promo Renewal Rate', percent(p.promoRenewalRate)),
        row('Promo Non-Renewals', number(s.promoNonRenewals)),
        row('Promo Non-Renewal Rate', percent(p.promoNonRenewalRate)),
        row('Paid Conversion Rate', percent(p.paidConversionRate)),
        row('Active Retention', percent(p.activeRetention)),
        row('Cancellation Rate', percent(p.cancellationRate)),
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

    async function loadMonth(monthKey) {
      if (!validMonthKey(monthKey)) return;
      currentMonthKey = monthKey;
      currentRange = 'month:' + monthKey;
      document.querySelectorAll('.range').forEach(item => item.classList.remove('active'));
      await load(currentRange);
    }

    document.getElementById('previousMonth').addEventListener('click', async () => {
      const target = shiftMonthKey(currentMonthKey, -1);
      if (target) await loadMonth(target);
    });

    document.getElementById('nextMonth').addEventListener('click', async () => {
      const target = shiftMonthKey(currentMonthKey, 1);
      const maxMonth = currentData?.range?.currentMonthKey;
      if (target && (!validMonthKey(maxMonth) || target <= maxMonth)) {
        await loadMonth(target);
      }
    });

    document.getElementById('monthPicker').addEventListener('change', async event => {
      const target = String(event.target.value || '');
      if (validMonthKey(target)) await loadMonth(target);
    });

    document.querySelectorAll('.range').forEach(button => {
      button.addEventListener('click', async () => {
        currentRange = button.dataset.range;
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

function adminPageSecurityHeaders(_req, res, next) {
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Credentials');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
  return next();
}

function renderAffiliateAdminDashboardPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow,noarchive" />
  <title>The Agora · Affiliate Admin</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09080d;
      --panel: #121019;
      --panel-2: #17141f;
      --panel-3: #1c1824;
      --border: rgba(216,171,82,.18);
      --border-strong: rgba(216,171,82,.42);
      --gold: #d8ab52;
      --gold-soft: #f0d89f;
      --text: #f7f2e8;
      --muted: #9d97aa;
      --positive: #8fd0ae;
      --warning: #e4be78;
      --danger: #df8f92;
      --info: #9ab9df;
      --shadow: 0 20px 70px rgba(0,0,0,.34);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
    body {
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at 50% -10%, rgba(111,74,151,.16), transparent 38rem), var(--bg);
    }
    button, input, select, textarea { font: inherit; }
    button { color: inherit; }
    .shell { width: min(1260px, calc(100% - 32px)); margin: 0 auto; padding: 30px 0 70px; }
    .topbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
    .eyebrow { color: var(--gold); letter-spacing: .17em; font-size: 11px; font-weight: 750; }
    h1 { margin: 8px 0 0; font: 500 clamp(32px,5vw,48px)/1.05 Georgia,"Times New Roman",serif; }
    .top-actions { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .button {
      border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.035); color: #ddd6e2;
      padding: 10px 13px; border-radius: 11px; cursor: pointer; font-weight: 650; font-size: 13px;
    }
    .button:hover { background: rgba(255,255,255,.065); }
    .button.gold { border-color: var(--border-strong); background: rgba(216,171,82,.10); color: var(--gold-soft); }
    .button.gold:hover { background: rgba(216,171,82,.16); }
    .button.danger { border-color: rgba(223,143,146,.28); color: #efb8ba; background: rgba(223,143,146,.07); }
    .button.small { padding: 7px 9px; font-size: 11px; border-radius: 9px; }
    .button:disabled { opacity: .38; cursor: not-allowed; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; margin-right: 6px; }
    .status-dot.live { background: var(--positive); box-shadow: 0 0 0 4px rgba(143,208,174,.08); }
    .session { color: var(--muted); font-size: 12px; display: flex; align-items: center; }
    .tabs { display: inline-flex; gap: 5px; padding: 5px; border: 1px solid rgba(255,255,255,.07); background: rgba(255,255,255,.025); border-radius: 14px; margin-bottom: 22px; }
    .tab { border: 0; background: transparent; color: var(--muted); padding: 10px 18px; border-radius: 10px; cursor: pointer; font-weight: 700; }
    .tab.active { background: var(--panel-2); color: var(--text); box-shadow: inset 0 0 0 1px var(--border); }
    .hidden { display: none !important; }
    .summary-grid { display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); gap: 10px; }
    .card { background: linear-gradient(180deg, rgba(23,20,31,.98), rgba(16,14,22,.98)); border: 1px solid rgba(255,255,255,.07); border-radius: 17px; box-shadow: var(--shadow); }
    .summary { padding: 16px; min-width: 0; }
    .summary .label { color: var(--muted); font-size: 11px; font-weight: 700; line-height: 1.3; }
    .summary .value { margin-top: 7px; font-size: 25px; font-weight: 760; letter-spacing: -.035em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .summary .sub { margin-top: 4px; color: #777181; font-size: 10px; }
    .money { color: var(--gold-soft); }
    .section { margin-top: 24px; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 11px; flex-wrap: wrap; }
    .section-head h2 { margin: 0; font: 500 23px Georgia,"Times New Roman",serif; }
    .muted { color: var(--muted); }
    .tiny { font-size: 11px; }
    .table-card { overflow: hidden; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 1020px; }
    th { text-align: left; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .07em; font-weight: 750; padding: 13px 14px; border-bottom: 1px solid rgba(255,255,255,.075); }
    td { padding: 13px 14px; border-bottom: 1px solid rgba(255,255,255,.05); font-size: 12px; vertical-align: middle; }
    tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: rgba(255,255,255,.018); }
    .partner-name { font-weight: 750; color: #eee8f1; }
    .code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; color: var(--gold-soft); font-size: 11px; }
    .badge { display: inline-flex; align-items: center; gap: 5px; border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.035); border-radius: 999px; padding: 4px 7px; font-size: 10px; color: #d7d0dc; white-space: nowrap; }
    .badge.positive { color: var(--positive); border-color: rgba(143,208,174,.22); background: rgba(143,208,174,.06); }
    .badge.warning { color: var(--warning); border-color: rgba(228,190,120,.22); background: rgba(228,190,120,.06); }
    .badge.danger { color: var(--danger); border-color: rgba(223,143,146,.22); background: rgba(223,143,146,.06); }
    .badge.info { color: var(--info); border-color: rgba(154,185,223,.22); background: rgba(154,185,223,.06); }
    .actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .field, .select, textarea {
      width: 100%; border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.035); color: var(--text);
      border-radius: 10px; padding: 10px 11px; outline: none;
    }
    .field:focus, .select:focus, textarea:focus { border-color: var(--border-strong); box-shadow: 0 0 0 3px rgba(216,171,82,.07); }
    .toolbar .field, .toolbar .select { width: auto; min-width: 150px; }
    input[type="month"], input[type="date"] { color-scheme: dark; }
    .empty { padding: 28px 20px; text-align: center; color: var(--muted); font-size: 13px; }
    .notice { border: 1px solid rgba(228,190,120,.22); background: rgba(228,190,120,.06); color: #d8c7a4; padding: 11px 13px; border-radius: 11px; font-size: 12px; line-height: 1.5; margin-bottom: 14px; }
    .notice.danger { border-color: rgba(223,143,146,.24); background: rgba(223,143,146,.06); color: #e9b2b5; }
    .alert-list { display: grid; gap: 9px; }
    .alert-item { padding: 15px 16px; }
    .alert-top { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .alert-title { font-weight: 750; }
    .alert-message { color: #c5bdca; font-size: 12px; line-height: 1.5; margin-top: 6px; }
    .alert-meta { color: var(--muted); font-size: 10px; margin-top: 8px; }
    .modal-backdrop, .login-backdrop { position: fixed; inset: 0; z-index: 2000; background: rgba(4,3,7,.79); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 18px; }
    .modal { width: min(640px,100%); max-height: min(760px,calc(100vh - 36px)); overflow-y: auto; background: #131019; border: 1px solid var(--border-strong); border-radius: 20px; box-shadow: 0 35px 100px rgba(0,0,0,.55); padding: 21px; }
    .modal h2 { margin: 0; font: 500 27px Georgia,"Times New Roman",serif; }
    .modal-sub { color: var(--muted); font-size: 12px; line-height: 1.5; margin-top: 6px; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 18px; }
    .form-group { min-width: 0; }
    .form-group.full { grid-column: 1/-1; }
    .form-group label { display: block; color: var(--muted); font-size: 10px; font-weight: 750; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
    .check-row { display: flex; gap: 8px; align-items: flex-start; color: #d5ceda; font-size: 12px; line-height: 1.4; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    .result-box { margin-top: 16px; border: 1px solid rgba(143,208,174,.22); background: rgba(143,208,174,.055); border-radius: 12px; padding: 13px; }
    .result-line { margin-top: 8px; display: grid; grid-template-columns: 110px 1fr auto; align-items: center; gap: 8px; }
    .result-line:first-child { margin-top: 0; }
    .result-label { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
    .result-value { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 10px; color: #ddd6e2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .login-card { width: min(440px,100%); background: #131019; border: 1px solid var(--border-strong); border-radius: 20px; box-shadow: 0 35px 100px rgba(0,0,0,.55); padding: 24px; }
    .login-card h2 { margin: 8px 0 0; font: 500 30px Georgia,"Times New Roman",serif; }
    .login-card p { color: var(--muted); font-size: 12px; line-height: 1.55; }
    .login-error { color: #efb8ba; font-size: 11px; margin-top: 8px; min-height: 15px; }
    .login-actions { margin-top: 12px; display: flex; justify-content: flex-end; }
    .toast { position: fixed; z-index: 3000; right: 18px; bottom: 18px; max-width: min(420px,calc(100vw - 36px)); background: #17131d; border: 1px solid var(--border-strong); border-radius: 12px; padding: 11px 13px; box-shadow: 0 18px 60px rgba(0,0,0,.45); font-size: 12px; color: #e8e1eb; }
    .toast.error { border-color: rgba(223,143,146,.4); color: #efb8ba; }
    @media (max-width: 1120px) { .summary-grid { grid-template-columns: repeat(3,minmax(0,1fr)); } }
    @media (max-width: 700px) {
      .shell { width: min(100% - 20px,1260px); padding-top: 20px; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .top-actions { justify-content: flex-start; }
      .tabs { width: 100%; }
      .tab { flex: 1; padding: 9px 8px; }
      .summary-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
      .form-grid { grid-template-columns: 1fr; }
      .form-group.full { grid-column: auto; }
      .result-line { grid-template-columns: 1fr; }
      .toolbar .field, .toolbar .select { width: 100%; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div>
        <div class="eyebrow">THE AGORA · OWNER CONTROL CENTER</div>
        <h1>Affiliate Admin</h1>
      </div>
      <div class="top-actions">
        <div class="session"><span id="sessionDot" class="status-dot"></span><span id="sessionLabel">Locked</span></div>
        <button id="refreshAll" class="button" type="button">Refresh</button>
        <button id="createAffiliate" class="button gold" type="button">+ New Affiliate</button>
        <button id="signOut" class="button" type="button">Lock</button>
      </div>
    </div>

    <div class="tabs" role="tablist">
      <button class="tab active" data-tab="overview" type="button">Overview</button>
      <button class="tab" data-tab="payouts" type="button">Payouts</button>
      <button class="tab" data-tab="alerts" type="button">Alerts <span id="alertTabCount"></span></button>
    </div>

    <section id="overviewTab">
      <div class="summary-grid">
        <div class="card summary"><div class="label">Active Affiliates</div><div id="sumAffiliates" class="value">—</div><div class="sub">Production only</div></div>
        <div class="card summary"><div class="label">Total Referrals</div><div id="sumReferrals" class="value">—</div><div class="sub">Verified chains</div></div>
        <div class="card summary"><div class="label">Current Subscribers</div><div id="sumSubscribers" class="value">—</div><div class="sub">Active access now</div></div>
        <div class="card summary"><div class="label">Estimated This Month</div><div id="sumEstimated" class="value money">—</div><div id="sumEstimatedSub" class="sub">Open estimate</div></div>
        <div class="card summary"><div class="label">Currently Owed</div><div id="sumOwed" class="value money">—</div><div id="sumOwedSub" class="sub">Finalized unpaid</div></div>
        <div class="card summary"><div class="label">Open Partner Alerts</div><div id="sumAlerts" class="value">—</div><div class="sub">Production only</div></div>
      </div>

      <div class="section">
        <div class="section-head">
          <div><h2>App Store Connect Imports</h2><div class="muted tiny">Offers created in App Store Connect appear here automatically after sync. Complete setup to turn them into Agora affiliates.</div></div>
          <div class="toolbar">
            <div id="appleSyncStatus" class="muted tiny">Not synced yet</div>
            <button id="toggleIgnoredAppleImports" class="button hidden" type="button">Show Ignored</button>
            <button id="syncAppleOffers" class="button" type="button">Sync App Store Connect</button>
          </div>
        </div>
        <div class="card table-card">
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th>Apple Offer</th><th>Creator Code</th><th>Apple Status</th><th>Eligibility</th><th>Linked</th><th>Action</th>
              </tr></thead>
              <tbody id="appleImportRows"><tr><td colspan="6" class="empty">Unlock the admin dashboard to load App Store Connect imports.</td></tr></tbody>
            </table>
          </div>
        </div>
        <div id="appleImportWarnings" class="muted tiny" style="margin-top:10px"></div>
      </div>

      <div class="section">
        <div class="section-head">
          <div><h2>Affiliates</h2><div class="muted tiny">Production and Sandbox partners. Money summary above excludes test affiliates.</div></div>
          <div class="toolbar">
            <input id="affiliateSearch" class="field" type="search" placeholder="Search partner or code" />
            <select id="affiliateFilter" class="select">
              <option value="all">All</option>
              <option value="production">Production</option>
              <option value="test">Sandbox</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </select>
          </div>
        </div>
        <div class="card table-card">
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th>Partner</th><th>Code</th><th>Env</th><th>Status</th><th>Referrals</th><th>Subscribers</th><th>This Month</th><th>Owed</th><th>Commission</th><th>Alerts</th><th>Actions</th>
              </tr></thead>
              <tbody id="affiliateRows"><tr><td colspan="11" class="empty">Unlock the admin dashboard to load affiliates.</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <section id="payoutsTab" class="hidden">
      <div class="section-head">
        <div><h2>Monthly Payouts</h2><div class="muted tiny">Refresh estimates, finalize completed calendar months, and record actual payments.</div></div>
        <div class="toolbar">
          <input id="payoutMonth" class="field" type="month" />
          <label class="check-row"><input id="includeTestPayouts" type="checkbox" checked /> Include Sandbox</label>
          <button id="loadPayouts" class="button" type="button">Load Month</button>
          <button id="refreshMonth" class="button" type="button">Refresh Month</button>
          <button id="finalizeMonth" class="button gold" type="button">Finalize Month</button>
        </div>
      </div>
      <div id="payoutNotice" class="notice">Finalization is allowed only for completed prior calendar months. Production finalization remains subject to the server's Apple-data safety rules.</div>
      <div class="card table-card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Partner</th><th>Month</th><th>Env</th><th>Eligible Revenue</th><th>Due</th><th>Paid</th><th>Remaining</th><th>Data</th><th>Status</th><th>Adjustments</th><th>Actions</th></tr></thead>
            <tbody id="payoutRows"><tr><td colspan="11" class="empty">Choose a month to load payout records.</td></tr></tbody>
          </table>
        </div>
      </div>
    </section>

    <section id="alertsTab" class="hidden">
      <div class="section-head">
        <div><h2>Affiliate Alerts</h2><div class="muted tiny">Attribution conflicts, Apple-data issues, and commission-processing warnings.</div></div>
        <div class="toolbar">
          <select id="alertFilter" class="select"><option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option></select>
          <button id="loadAlerts" class="button" type="button">Refresh Alerts</button>
        </div>
      </div>
      <div id="alertList" class="alert-list"><div class="card empty">Unlock the admin dashboard to load alerts.</div></div>
    </section>
  </main>

  <div id="loginBackdrop" class="login-backdrop">
    <div class="login-card">
      <div class="eyebrow">OWNER AUTHENTICATION</div>
      <h2>Unlock Affiliate Admin</h2>
      <p>Enter the existing <strong>AFFILIATE_ADMIN_KEY</strong>. It is sent only to this backend over HTTPS and kept in this browser tab's session storage. It is never embedded in the page source.</p>
      <input id="adminKey" class="field" type="password" autocomplete="off" placeholder="Affiliate admin key" />
      <div id="loginError" class="login-error"></div>
      <div class="login-actions"><button id="unlockAdmin" class="button gold" type="button">Unlock</button></div>
    </div>
  </div>

  <div id="modalBackdrop" class="modal-backdrop hidden"><div id="modal" class="modal"></div></div>
  <div id="toast" class="toast hidden"></div>

  <script>
    let adminKey = sessionStorage.getItem('agoraAffiliateAdminKey') || '';
    let affiliates = [];
    let appleImports = [];
    let appleLinked = [];
    let appleIgnored = [];
    let appleSync = null;
    let showIgnoredAppleImports = false;
    let payouts = [];
    let alerts = [];
    let activeTab = 'overview';

    const $ = id => document.getElementById(id);
    const html = value => String(value == null ? '' : value)
      .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
    const number = value => Number(value || 0).toLocaleString();
    const numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0;
    const currencyCode = value => /^[A-Z]{3}$/.test(String(value || '').toUpperCase()) ? String(value).toUpperCase() : 'USD';
    const money = (value, currency) => new Intl.NumberFormat(undefined,{style:'currency',currency:currencyCode(currency),minimumFractionDigits:2,maximumFractionDigits:2}).format(numeric(value));
    const groupedMoney = (rows, field) => {
      const groups = new Map();
      rows.forEach(row => {
        const code = currencyCode(row.payout_currency);
        groups.set(code, (groups.get(code) || 0) + numeric(row[field]));
      });
      const entries = Array.from(groups.entries());
      if (!entries.length) return { text:'—', sub:'' };
      if (entries.length === 1) return { text:money(entries[0][1], entries[0][0]), sub:'' };
      return {
        text:'Mixed',
        sub:entries.map(entry => money(entry[1], entry[0])).join(' · ')
      };
    };
    const percent = value => value == null ? '—' : (Number(value) * 100).toFixed(0) + '%';
    const monthName = value => {
      if (!value) return '—';
      const raw = String(value).slice(0,7);
      const parts = raw.split('-');
      if (parts.length !== 2) return raw;
      return new Date(Number(parts[0]), Number(parts[1]) - 1, 1).toLocaleDateString(undefined,{month:'short',year:'numeric'});
    };
    const dateTime = value => {
      if (!value) return '—';
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
    };
    const currentMonthKey = () => {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0');
    };
    const basisLabel = value => value === 'base_price' ? 'Base Price' : value === 'net_proceeds' ? 'Apple Net' : '—';

    function toast(message, error) {
      const el = $('toast');
      el.textContent = message;
      el.className = 'toast' + (error ? ' error' : '');
      clearTimeout(toast.timer);
      toast.timer = setTimeout(() => { el.className = 'toast hidden'; }, 3500);
    }

    function badge(text, kind) {
      return '<span class="badge ' + (kind || '') + '">' + html(text) + '</span>';
    }

    function statusBadge(row) {
      if (row.status === 'terminated_for_cause' || row.status === 'archived') return badge(String(row.status).replaceAll('_',' '),'danger');
      if (row.status === 'inactive') return badge('Paused','warning');
      if (row.status === 'active' && row.code_status === 'active') return badge('Active','positive');
      if (row.status === 'active' && row.code_status === 'disabled') return badge('Code Disabled','warning');
      return badge(String(row.code_status || row.status || 'Unknown').replaceAll('_',' '),'warning');
    }

    function payoutStatusBadge(row) {
      const value = String(row.status || 'open');
      if (value === 'paid') return badge('Paid','positive');
      if (value === 'partially_paid') return badge('Partially Paid','warning');
      if (value === 'ready_to_pay') return badge('Ready to Pay','info');
      return badge('Open','');
    }

    function dataStatusBadge(value) {
      if (value === 'reconciled') return badge('Reconciled','positive');
      if (value === 'needs_review') return badge('Needs Review','danger');
      if (value === 'provisional') return badge('Provisional','warning');
      return badge('Awaiting Apple','');
    }

    async function adminFetch(path, options) {
      if (!adminKey) throw new Error('Admin key required.');
      const opts = Object.assign({}, options || {});
      opts.headers = Object.assign({}, opts.headers || {}, {
        'x-admin-key': adminKey,
        'x-admin-actor': 'owner_admin'
      });
      if (opts.body && typeof opts.body !== 'string') {
        opts.headers['content-type'] = 'application/json';
        opts.body = JSON.stringify(opts.body);
      }
      const response = await fetch(path, opts);
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) {
        if (response.status === 401) {
          lockAdmin();
        }
        const err = new Error(payload?.error?.message || ('Request failed (' + response.status + ')'));
        err.code = payload?.error?.code || null;
        err.status = response.status;
        throw err;
      }
      return payload || {};
    }

    function unlockUi() {
      $('loginBackdrop').classList.add('hidden');
      $('sessionDot').classList.add('live');
      $('sessionLabel').textContent = 'Owner session unlocked';
    }

    function lockAdmin() {
      adminKey = '';
      sessionStorage.removeItem('agoraAffiliateAdminKey');
      $('sessionDot').classList.remove('live');
      $('sessionLabel').textContent = 'Locked';
      $('loginBackdrop').classList.remove('hidden');
      $('adminKey').value = '';
    }

    async function verifyAndLoad() {
      try {
        const payload = await adminFetch('/api/admin/affiliates');
        affiliates = Array.isArray(payload.affiliates) ? payload.affiliates : [];
        unlockUi();
        renderOverview();
        await Promise.all([loadAppleImports(false), loadAlerts(false), loadPayouts(false)]);
      } catch (error) {
        $('loginError').textContent = error.message;
        if (error.status !== 401) toast(error.message, true);
      }
    }

    async function loadAffiliates(showToast) {
      try {
        const payload = await adminFetch('/api/admin/affiliates');
        affiliates = Array.isArray(payload.affiliates) ? payload.affiliates : [];
        renderOverview();
        if (showToast) toast('Affiliate data refreshed.');
      } catch (error) { toast(error.message, true); }
    }

    async function loadAppleImports(showToast) {
      if (!adminKey) return;
      try {
        const payload = await adminFetch('/api/admin/app-store-connect/imports');
        appleImports = Array.isArray(payload.imports) ? payload.imports : [];
        appleLinked = Array.isArray(payload.linked) ? payload.linked : [];
        appleIgnored = Array.isArray(payload.ignored) ? payload.ignored : [];
        appleSync = {
          configured: payload.configured !== false,
          syncedAt: payload.syncedAt || null,
          warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
          errorMessage: payload.errorMessage || null,
        };
        renderAppleImports();
        if (showToast) toast(payload.configured === false ? 'App Store Connect sync is not configured yet.' : 'App Store Connect sync complete.');
      } catch (error) {
        appleImports = [];
        appleLinked = [];
        appleIgnored = [];
        appleSync = { configured: false, syncedAt: null, warnings: [], errorMessage: error.message };
        renderAppleImports();
        toast(error.message, true);
      }
    }

    function productionAffiliates() { return affiliates.filter(a => !a.is_test); }

    function renderOverview() {
      renderAppleImports();
      const prod = productionAffiliates();
      $('sumAffiliates').textContent = number(prod.filter(a => a.status === 'active').length);
      $('sumReferrals').textContent = number(prod.reduce((sum,a) => sum + numeric(a.total_referrals),0));
      $('sumSubscribers').textContent = number(prod.reduce((sum,a) => sum + numeric(a.current_subscribers),0));
      const knownEstimates = prod.filter(a => a.estimated_this_month != null);
      const awaitingEstimates = prod.length - knownEstimates.length;
      const estimateGroup = groupedMoney(knownEstimates, 'estimated_this_month');
      $('sumEstimated').textContent = estimateGroup.text;
      $('sumEstimatedSub').textContent = [
        estimateGroup.sub,
        awaitingEstimates ? (number(awaitingEstimates) + ' affiliate' + (awaitingEstimates === 1 ? '' : 's') + ' awaiting data') : 'Open estimate'
      ].filter(Boolean).join(' · ');
      const owedGroup = groupedMoney(prod, 'currently_owed');
      $('sumOwed').textContent = owedGroup.text;
      $('sumOwedSub').textContent = owedGroup.sub || 'Finalized unpaid';
      $('sumAlerts').textContent = number(prod.reduce((sum,a) => sum + numeric(a.open_alerts),0));
      renderAffiliateRows();
    }

    function renderAffiliateRows() {
      const query = $('affiliateSearch').value.trim().toLowerCase();
      const filter = $('affiliateFilter').value;
      const filtered = affiliates.filter(a => {
        if (query && !String(a.display_name || '').toLowerCase().includes(query) && !String(a.normalized_code || '').toLowerCase().includes(query)) return false;
        if (filter === 'production' && a.is_test) return false;
        if (filter === 'test' && !a.is_test) return false;
        if (filter === 'active' && a.status !== 'active') return false;
        if (filter === 'paused' && a.status === 'active') return false;
        return true;
      });

      if (!filtered.length) {
        $('affiliateRows').innerHTML = '<tr><td colspan="11" class="empty">No affiliates match this view.</td></tr>';
        return;
      }

      $('affiliateRows').innerHTML = filtered.map(a => {
        const alertKind = numeric(a.critical_alerts) > 0 ? 'danger' : numeric(a.open_alerts) > 0 ? 'warning' : 'positive';
        const operationalActive = a.status === 'active';
        const canToggle = ['active','inactive'].includes(a.status);
        return '<tr>' +
          '<td><div class="partner-name">' + html(a.display_name) + '</div><div class="muted tiny">Since ' + html(String(a.affiliate_since || '').slice(0,10)) + '</div></td>' +
          '<td><span class="code">' + html(a.normalized_code) + '</span></td>' +
          '<td>' + badge(a.is_test ? 'Sandbox' : 'Production', a.is_test ? 'warning' : 'info') + '</td>' +
          '<td>' + statusBadge(a) + '</td>' +
          '<td>' + number(a.total_referrals) + '</td>' +
          '<td>' + number(a.current_subscribers) + '</td>' +
          '<td class="money">' + (a.estimated_this_month == null ? '—' : money(a.estimated_this_month, a.payout_currency)) + '<div style="margin-top:5px">' + (a.current_month_data_status ? dataStatusBadge(a.current_month_data_status) : badge('Awaiting payout data','')) + '</div></td>' +
          '<td class="money">' + money(a.currently_owed, a.payout_currency) + '</td>' +
          '<td>' + percent(a.commission_rate) + '<div class="muted tiny">' + html(basisLabel(a.commission_basis)) + '</div></td>' +
          '<td>' + badge(number(a.open_alerts), alertKind) + '</td>' +
          '<td><div class="actions">' +
            '<button class="button small" data-action="details" data-id="' + html(a.id) + '">Details</button>' +
            '<button class="button small" data-action="dashboard" data-id="' + html(a.id) + '">Dashboard</button>' +
            (canToggle ? '<button class="button small ' + (operationalActive ? 'danger' : 'gold') + '" data-action="toggle" data-id="' + html(a.id) + '" data-active="' + (operationalActive ? 'false' : 'true') + '">' + (operationalActive ? 'Pause' : 'Activate') + '</button>' : '') +
          '</div></td>' +
        '</tr>';
      }).join('');
    }

    function appleBooleanBadge(value, trueLabel = 'Active', falseLabel = 'Inactive') {
      if (value === true) return badge(trueLabel, 'positive');
      if (value === false) return badge(falseLabel, 'warning');
      return badge('Unknown', '');
    }

    function appleCodeCountLabel(item) {
      if (item?.numberOfCodes == null) return 'Code count unavailable';
      return number(item.numberOfCodes) + ' code' + (Number(item.numberOfCodes) === 1 ? '' : 's');
    }

    function canonicalConfigurationLabel(item) {
      if (!item?.canonical) return item?.configurationCount > 1 ? 'Choose current configuration' : 'No current configuration';
      const bits = [appleCodeCountLabel(item.canonical)];
      if (item.canonical.createdDate) bits.push('created ' + dateTime(item.canonical.createdDate));
      return bits.join(' · ');
    }

    function renderAppleImportRow(item, mode) {
      const canonical = item.canonical || null;
      const offerName = canonical?.offerName || item.configurations?.[0]?.offerName || '—';
      const eligibility = canonical?.customerEligibilities || item.configurations?.[0]?.customerEligibilities || [];
      const versions = Number(item.configurationCount || 0);
      const versionText = versions > 1 ? (versions + ' Apple configurations') : canonicalConfigurationLabel(item);
      const sharedOffer = canonical?.distinctCustomCodesOnOffer > 1;
      const statusHtml = canonical
        ? appleBooleanBadge(canonical.customCodeActive, 'Active', 'Inactive') + '<div style="margin-top:5px">' + appleBooleanBadge(canonical.offerActive, 'Offer Active', 'Offer Inactive') + '</div>'
        : badge('Selection Required', 'warning');

      let linkedHtml = '';
      let actionsHtml = '';

      if (mode === 'ignored') {
        linkedHtml = badge('Ignored', '');
        actionsHtml = '<button class="button small" data-apple-import-restore="' + html(item.customCode) + '">Restore</button>';
      } else if (item.linkedAffiliate) {
        linkedHtml = badge(item.linkedAffiliate.displayName || 'Linked', 'positive');
        actionsHtml = '<span class="muted tiny">Already linked</span>';
        if (versions > 1) actionsHtml += '<button class="button small" data-apple-import-choose="' + html(item.customCode) + '">Configurations</button>';
      } else {
        if (sharedOffer) {
          linkedHtml = badge('Attribution Blocked', 'danger');
          actionsHtml = '<button class="button small danger" data-apple-import-blocked="' + html(item.customCode) + '">Fix Apple Setup</button>';
        } else if (item.needsCanonicalChoice || !canonical) {
          linkedHtml = badge('Choose Current', 'warning');
          actionsHtml = '<button class="button small gold" data-apple-import-choose="' + html(item.customCode) + '">Choose Current</button>';
        } else {
          linkedHtml = badge('Needs Setup', 'warning');
          actionsHtml = '<button class="button small gold" data-apple-import-setup="' + html(item.customCode) + '">Complete Setup</button>';
        }
        if (versions > 1 && canonical && !item.needsCanonicalChoice) {
          actionsHtml += '<button class="button small" data-apple-import-choose="' + html(item.customCode) + '">Change Current</button>';
        }
        actionsHtml += '<button class="button small" data-apple-import-ignore="' + html(item.customCode) + '">Ignore</button>';
      }

      const attributionNote = sharedOffer
        ? '<div class="muted tiny" style="margin-top:5px;color:#df8f92">Shared with ' + html(String(canonical.distinctCustomCodesOnOffer)) + ' creator codes. Exact chain attribution is not safe.</div>'
        : '';

      return '<tr>' +
        '<td><div class="partner-name">' + html(offerName) + '</div><div class="muted tiny">' + html(versionText) + '</div>' + attributionNote + '</td>' +
        '<td><span class="code">' + html(item.customCode || '—') + '</span></td>' +
        '<td>' + statusHtml + '</td>' +
        '<td>' + html(eligibility.join(', ') || '—') + '</td>' +
        '<td>' + linkedHtml + '</td>' +
        '<td><div class="actions">' + actionsHtml + '</div></td>' +
      '</tr>';
    }

    function renderAppleImports() {
      const rowsEl = $('appleImportRows');
      const statusEl = $('appleSyncStatus');
      const warningsEl = $('appleImportWarnings');
      const ignoredToggle = $('toggleIgnoredAppleImports');
      if (!rowsEl || !statusEl || !warningsEl || !ignoredToggle) return;

      if (!appleSync) {
        statusEl.textContent = 'Not synced yet';
        rowsEl.innerHTML = '<tr><td colspan="6" class="empty">Use “Sync App Store Connect” to discover Apple offers and custom codes.</td></tr>';
        warningsEl.textContent = '';
        ignoredToggle.classList.add('hidden');
        return;
      }

      if (appleSync.configured === false && !appleSync.syncedAt) {
        statusEl.textContent = appleSync.errorMessage || 'App Store Connect is not configured.';
        rowsEl.innerHTML = '<tr><td colspan="6" class="empty">App Store Connect sync is unavailable. Check the Railway credentials and backend logs for the exact error.</td></tr>';
        warningsEl.textContent = '';
        ignoredToggle.classList.add('hidden');
        return;
      }

      statusEl.textContent = appleSync.syncedAt ? ('Synced ' + dateTime(appleSync.syncedAt)) : 'Ready to sync';
      warningsEl.textContent = (appleSync.warnings || []).map(x => x.offerName + ': ' + x.message).join(' · ');
      ignoredToggle.classList.toggle('hidden', appleIgnored.length === 0);
      ignoredToggle.textContent = (showIgnoredAppleImports ? 'Hide Ignored' : 'Show Ignored') + (appleIgnored.length ? ' (' + appleIgnored.length + ')' : '');

      const importRows = appleImports.map(item => renderAppleImportRow(item, 'import'));
      const linkedRows = appleLinked.map(item => renderAppleImportRow(item, 'linked'));
      const ignoredRows = showIgnoredAppleImports ? appleIgnored.map(item => renderAppleImportRow(item, 'ignored')) : [];
      const combined = importRows.concat(linkedRows, ignoredRows);

      rowsEl.innerHTML = combined.length
        ? combined.join('')
        : '<tr><td colspan="6" class="empty">No Apple creator-code imports need attention right now.</td></tr>';
    }

    function appleImportByCode(code) {
      const normalized = String(code || '').trim().toUpperCase();
      return appleImports.concat(appleLinked, appleIgnored).find(item => item.customCode === normalized) || null;
    }

    function openAppleConfigurationPicker(code) {
      const item = appleImportByCode(code);
      if (!item) { toast('Apple import could not be found. Please sync again.', true); return; }
      const selectedKey = item.canonical?.externalKey || '';
      const options = (item.configurations || []).map((config, index) => {
        const key = config.externalKey;
        const checked = key === selectedKey ? ' checked' : '';
        const details = [
          config.customCodeActive === true ? 'Active' : 'Inactive',
          appleCodeCountLabel(config),
          config.createdDate ? ('Created ' + dateTime(config.createdDate)) : null,
          config.expirationDate ? ('Expires ' + dateTime(config.expirationDate)) : null,
          'Offer ID ' + config.offerId,
        ].filter(Boolean).join(' · ');
        return '<label class="card" style="display:block;padding:14px;margin-top:10px;cursor:pointer">' +
          '<div style="display:flex;gap:10px;align-items:flex-start"><input type="radio" name="appleCanonical" value="' + html(key) + '"' + checked + ' />' +
          '<div><div class="partner-name">' + html(config.offerName || item.customCode) + '</div><div class="muted tiny" style="margin-top:5px">' + html(details) + '</div></div></div>' +
        '</label>';
      }).join('');
      openModal(
        '<h2>Choose Current Apple Configuration</h2><div class="modal-sub">' + html(item.customCode) + ' has ' + number(item.configurationCount) + ' Apple configuration' + (item.configurationCount === 1 ? '' : 's') + '. Choose the one that should represent the current creator code. Older configurations stay preserved as history.</div>' +
        options +
        '<div id="applePreferenceError" class="login-error"></div>' +
        '<div class="modal-actions"><button class="button" data-modal-action="close">Cancel</button><button class="button gold" data-modal-action="save-apple-canonical" data-code="' + html(item.customCode) + '">Save Current</button></div>'
      );
    }

    async function saveAppleCanonical(code) {
      const item = appleImportByCode(code);
      const selected = document.querySelector('input[name="appleCanonical"]:checked');
      if (!item || !selected) { $('applePreferenceError').textContent = 'Choose one Apple configuration.'; return; }
      const config = (item.configurations || []).find(x => x.externalKey === selected.value);
      if (!config) { $('applePreferenceError').textContent = 'That Apple configuration is no longer available. Sync again.'; return; }
      try {
        await adminFetch('/api/admin/app-store-connect/imports/' + encodeURIComponent(item.customCode) + '/canonical', {
          method:'POST', body:{ offerId:config.offerId, customCodeId:config.customCodeId }
        });
        closeModal();
        toast('Current Apple configuration saved for ' + item.customCode + '.');
        await loadAppleImports(false);
      } catch (error) { $('applePreferenceError').textContent = error.message; }
    }

    async function ignoreAppleImport(code) {
      const item = appleImportByCode(code);
      if (!item) return;
      if (!confirm('Ignore ' + item.customCode + ' as an affiliate import? This only hides it in Affiliate Admin. Nothing is deleted from App Store Connect.')) return;
      try {
        await adminFetch('/api/admin/app-store-connect/imports/' + encodeURIComponent(item.customCode) + '/ignore', { method:'POST' });
        toast(item.customCode + ' moved to Ignored.');
        await loadAppleImports(false);
      } catch (error) { toast(error.message, true); }
    }

    async function restoreAppleImport(code) {
      try {
        await adminFetch('/api/admin/app-store-connect/imports/' + encodeURIComponent(code) + '/restore', { method:'POST' });
        toast(code + ' restored to App Store Connect Imports.');
        await loadAppleImports(false);
      } catch (error) { toast(error.message, true); }
    }

    function showAppleAttributionBlocker(code) {
      const item = appleImportByCode(code);
      if (!item) return;
      const canonical = item.canonical || item.configurations?.[0] || null;
      openModal(
        '<h2>Exact Attribution Blocked</h2>' +
        '<div class="modal-sub">' + html(item.customCode) + ' is inside an Apple offer that contains multiple custom creator codes.</div>' +
        '<div class="notice danger" style="margin-top:16px">For The Agora’s subscription-chain affiliate ownership, each affiliate must have its own Apple offer reference. A shared Apple offer cannot tell the verified StoreKit transaction whether AM99, LEVI99, MAXAGORA, or another custom code was used.</div>' +
        '<div class="card" style="margin-top:14px;padding:14px"><div class="muted tiny">CURRENT APPLE OFFER</div><div style="margin-top:6px">' + html(canonical?.offerName || '—') + '</div><div class="muted tiny" style="margin-top:5px">' + html(String(canonical?.distinctCustomCodesOnOffer || 'Multiple')) + ' distinct custom codes on this offer</div></div>' +
        '<div class="modal-sub" style="margin-top:14px">Create a separate Apple Offer Code campaign/reference for this affiliate, then place only this creator code under that offer. Sync again afterward. Old Apple configurations can remain historical.</div>' +
        '<div class="modal-actions"><button class="button gold" data-modal-action="close">Got It</button></div>'
      );
    }

    function affiliateById(id) { return affiliates.find(a => a.id === id); }

    function openDetails(id) {
      const a = affiliateById(id);
      if (!a) return;
      const rows = [
        ['Partner', a.display_name], ['Creator Code', a.normalized_code], ['Apple Offer Reference', a.apple_offer_identifier || 'Not configured'],
        ['Environment', a.is_test ? 'Sandbox' : 'Production'], ['Affiliate Since', String(a.affiliate_since || '').slice(0,10)],
        ['Status', String(a.status || '') + ' / ' + String(a.code_status || '')], ['Commission', percent(a.commission_rate) + ' · ' + basisLabel(a.commission_basis)],
        ['Total Referrals', number(a.total_referrals)], ['Current Subscribers', number(a.current_subscribers)], ['Estimated This Month', a.estimated_this_month == null ? 'Awaiting payout data' : money(a.estimated_this_month, a.payout_currency)],
        ['Currently Owed', money(a.currently_owed, a.payout_currency)], ['Lifetime Commission', money(a.lifetime_commission_earned, a.payout_currency)], ['Lifetime Paid', money(a.lifetime_paid, a.payout_currency)],
        ['Contact', a.contact_email || '—'], ['Payout Method', a.payout_method || '—']
      ];
      openModal(
        '<h2>' + html(a.display_name) + '</h2><div class="modal-sub">Owner-only affiliate record. Customer identity is never exposed here.</div>' +
        '<div class="section"><div class="card" style="padding:14px">' + rows.map(r => '<div style="display:flex;justify-content:space-between;gap:18px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05)"><span class="muted">' + html(r[0]) + '</span><span style="text-align:right">' + html(r[1]) + '</span></div>').join('') + '</div></div>' +
        (a.internal_notes ? '<div class="section"><div class="muted tiny">INTERNAL NOTES</div><div style="margin-top:7px;line-height:1.5">' + html(a.internal_notes) + '</div></div>' : '') +
        '<div class="modal-actions"><button class="button" data-modal-action="copy-referral">Copy Referral Link</button><button class="button" data-modal-action="regenerate">Regenerate Dashboard Link</button><button class="button gold" data-modal-action="open-dashboard">Open Dashboard</button><button class="button" data-modal-action="close">Close</button></div>',
        { affiliateId: id }
      );
    }

    async function openPartnerDashboard(id) {
      const popup = window.open('about:blank', '_blank');
      try {
        const payload = await adminFetch('/api/admin/affiliates/' + encodeURIComponent(id) + '/dashboard-link');
        if (!payload.dashboardUrl) throw new Error('Dashboard link is unavailable.');
        if (popup) {
          popup.opener = null;
          popup.location.replace(payload.dashboardUrl);
        } else {
          await navigator.clipboard.writeText(payload.dashboardUrl);
          toast('Popup was blocked, so the private dashboard link was copied instead.');
        }
      } catch (error) {
        if (popup) popup.close();
        if (error.code === 'affiliate_dashboard_token_not_recoverable') {
          toast('This older dashboard token must be regenerated once before it can be opened.', true);
        } else toast(error.message, true);
      }
    }

    async function toggleAffiliate(id, shouldActivate) {
      const a = affiliateById(id);
      if (!a) return;
      const verb = shouldActivate ? 'activate' : 'pause';
      if (!confirm((shouldActivate ? 'Activate ' : 'Pause ') + a.display_name + '?')) return;
      try {
        await adminFetch('/api/admin/affiliates/' + encodeURIComponent(id) + '/operational-status', { method:'POST', body:{ active: shouldActivate } });
        toast('Affiliate ' + verb + 'd.');
        await loadAffiliates(false);
      } catch (error) { toast(error.message, true); }
    }

    function openCreateAffiliate(prefill = null) {
      const today = new Date();
      const localDate = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
      const isImport = !!prefill;
      openModal(
        '<h2>' + (isImport ? 'Complete Apple Import' : 'Create Affiliate') + '</h2><div class="modal-sub">' +
        (isImport
          ? 'This Apple offer already exists in App Store Connect. Complete the Agora-only fields below to activate the affiliate dashboard, compensation term, and attribution mapping.'
          : 'This creates the Agora affiliate record only. The Apple Offer Code campaign itself must already exist in App Store Connect. Once an offer exists in Apple, it will automatically appear above under App Store Connect Imports after sync.') +
        '</div>' +
        '<div class="form-grid">' +
          '<div class="form-group"><label>Display Name</label><input id="newDisplayName" class="field" placeholder="Max Agora" value="" /></div>' +
          '<div class="form-group"><label>Creator Code</label><input id="newCode" class="field" placeholder="MAXAGORA" value="' + html(prefill?.customCode || '') + '" /></div>' +
          '<div class="form-group full"><label>Apple Offer Reference Name</label><input id="newOfferRef" class="field" placeholder="AGORA_AFFILIATE_MAX" value="' + html(prefill?.canonical?.offerName || '') + '" /><div class="muted tiny" style="margin-top:5px">Required for Production attribution. Sandbox-only test records may omit it.</div></div>' +
          '<div class="form-group"><label>Affiliate Since</label><input id="newSince" class="field" type="date" value="' + localDate + '" /></div>' +
          '<div class="form-group"><label>Commission</label><input id="newRate" class="field" type="number" min="0" max="100" step="0.1" value="50" /></div>' +
          '<div class="form-group"><label>Commission Basis</label><select id="newBasis" class="select"><option value="base_price">Base Price</option><option value="net_proceeds">Apple Net Proceeds</option></select></div>' +
          '<div class="form-group"><label>Payout Currency</label><input id="newCurrency" class="field" value="USD" maxlength="3" /></div>' +
          '<div class="form-group full"><label>Contact Email (optional)</label><input id="newEmail" class="field" type="email" /></div>' +
          '<div class="form-group full"><label>Internal Notes (optional)</label><textarea id="newNotes" rows="3">' + html(prefill ? ('Imported from App Store Connect offer ' + (prefill.canonical?.offerName || '') + ' · creator code ' + (prefill.customCode || '') + '.') : '') + '</textarea></div>' +
          '<div class="form-group full"><label class="check-row"><input id="newIsTest" type="checkbox" ' + (prefill ? '' : '') + '/> Sandbox / test affiliate. Excluded from production summary and payouts.</label></div>' +
        '</div>' +
        '<div id="createAffiliateError" class="login-error"></div>' +
        '<div class="modal-actions"><button class="button" data-modal-action="close">Cancel</button><button class="button gold" data-modal-action="create-affiliate">Create Affiliate</button></div>'
      );
    }

    function openAppleImportSetup(code) {
      const item = appleImportByCode(code);
      if (!item) {
        toast('Apple import could not be found. Please sync again.', true);
        return;
      }
      if (!item.canonical) {
        openAppleConfigurationPicker(code);
        return;
      }
      if (!item.exactAttributionReady) {
        showAppleAttributionBlocker(code);
        return;
      }
      openCreateAffiliate(item);
    }

    async function createAffiliateFromModal() {
      const name = $('newDisplayName').value.trim();
      const code = $('newCode').value.trim().toUpperCase();
      const ratePct = Number($('newRate').value);
      const isTest = $('newIsTest').checked;
      const offerRef = $('newOfferRef').value.trim();
      if (!name || !code || !Number.isFinite(ratePct) || ratePct < 0 || ratePct > 100) {
        $('createAffiliateError').textContent = 'Name, creator code, and a valid commission percentage are required.';
        return;
      }
      if (!isTest && !offerRef) {
        $('createAffiliateError').textContent = 'Production affiliates require the App Store Connect offer reference name.';
        return;
      }
      try {
        const payload = await adminFetch('/api/admin/affiliates', {
          method:'POST',
          body:{
            internalName:name, displayName:name, customCode:code, appleOfferIdentifier:offerRef || null,
            affiliateSince:$('newSince').value, commissionRate:String(ratePct / 100), commissionBasis:$('newBasis').value,
            codeStatus:'active', payoutCurrency:$('newCurrency').value.trim().toUpperCase() || 'USD', isTest,
            contactEmail:$('newEmail').value.trim() || null, internalNotes:$('newNotes').value.trim() || null
          }
        });
        $('modal').innerHTML = '<h2>Affiliate Created</h2><div class="modal-sub">Copy these links now. The private dashboard link can also be recovered later from this admin dashboard when encrypted token storage is configured.</div>' +
          '<div class="result-box">' + resultLine('Referral Link', payload.referralUrl) + resultLine('Private Dashboard', payload.dashboardUrl) + resultLine('Apple Redemption', payload.appleRedemptionUrl) + '</div>' +
          '<div class="modal-actions"><button class="button gold" data-modal-action="close-refresh">Done</button></div>';
        await Promise.all([loadAffiliates(false), loadAppleImports(false)]);
      } catch (error) { $('createAffiliateError').textContent = error.message; }
    }

    function resultLine(label, value) {
      return '<div class="result-line"><span class="result-label">' + html(label) + '</span><span class="result-value">' + html(value || '—') + '</span><button class="button small" data-copy-value="' + html(value || '') + '">Copy</button></div>';
    }

    async function loadAlerts(showToast) {
      if (!adminKey) return;
      try {
        const status = $('alertFilter')?.value || 'open';
        const payload = await adminFetch('/api/admin/affiliate-alerts?status=' + encodeURIComponent(status));
        alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
        renderAlerts();
        const openCount = affiliates.reduce((sum,a) => sum + numeric(a.open_alerts),0);
        $('alertTabCount').textContent = openCount ? '(' + number(openCount) + ')' : '';
        if (showToast) toast('Alerts refreshed.');
      } catch (error) { toast(error.message, true); }
    }

    function renderAlerts() {
      if (!alerts.length) {
        $('alertList').innerHTML = '<div class="card empty">No alerts in this view.</div>';
        return;
      }
      $('alertList').innerHTML = alerts.map(a => {
        const kind = a.severity === 'critical' ? 'danger' : a.severity === 'warning' ? 'warning' : 'info';
        const canResolve = a.status === 'open';
        return '<article class="card alert-item"><div class="alert-top"><div><div>' + badge(a.severity || 'warning',kind) + ' ' + (a.affiliate_code ? badge(a.affiliate_code,a.affiliate_is_test ? 'warning' : '') : '') + '</div><div class="alert-title" style="margin-top:8px">' + html(a.title) + '</div></div>' +
          (canResolve ? '<button class="button small" data-alert-resolve="' + html(a.id) + '">Resolve</button>' : badge('Resolved','positive')) +
          '</div><div class="alert-message">' + html(a.message) + '</div><div class="alert-meta">' + html(a.affiliate_display_name || 'System-wide') + ' · ' + html(dateTime(a.triggered_at)) + '</div></article>';
      }).join('');
    }

    async function resolveAlert(id) {
      const note = prompt('Resolution note (optional):', 'Reviewed by owner admin.');
      if (note === null) return;
      try {
        await adminFetch('/api/admin/affiliate-alerts/' + encodeURIComponent(id) + '/resolve', { method:'POST', body:{ resolutionNote:note } });
        toast('Alert resolved.');
        await Promise.all([loadAlerts(false), loadAffiliates(false)]);
      } catch (error) { toast(error.message, true); }
    }

    async function loadPayouts(showToast) {
      if (!adminKey) return;
      try {
        const key = $('payoutMonth').value || currentMonthKey();
        $('payoutMonth').value = key;
        const includeTest = $('includeTestPayouts').checked;
        const payload = await adminFetch('/api/admin/affiliate-payouts?payoutPeriod=' + encodeURIComponent(key + '-01') + '&includeTest=' + (includeTest ? 'true' : 'false'));
        payouts = Array.isArray(payload.payouts) ? payload.payouts : [];
        renderPayouts();
        updateFinalizeButton();
        if (showToast) toast('Payout month loaded.');
      } catch (error) { toast(error.message, true); }
    }

    function renderPayouts() {
      if (!payouts.length) {
        $('payoutRows').innerHTML = '<tr><td colspan="11" class="empty">No payout rows exist for this month yet. Use Refresh Month after Apple data is available to build or update the month for all included affiliates.</td></tr>';
        return;
      }
      $('payoutRows').innerHTML = payouts.map(p => {
        const canPay = ['ready_to_pay','partially_paid'].includes(p.status) && numeric(p.remaining_owed) > 0;
        return '<tr>' +
          '<td><div class="partner-name">' + html(p.affiliate_display_name) + '</div><div class="code">' + html(p.affiliate_code) + '</div></td>' +
          '<td>' + html(monthName(p.payout_period)) + '</td>' +
          '<td>' + badge(p.affiliate_is_test ? 'Sandbox' : 'Production', p.affiliate_is_test ? 'warning' : 'info') + '</td>' +
          '<td class="money">' + money(p.eligible_revenue, p.payout_currency) + '</td>' +
          '<td class="money">' + money(p.amount_due, p.payout_currency) + '</td>' +
          '<td class="money">' + money(p.amount_paid, p.payout_currency) + '</td>' +
          '<td class="money">' + money(p.remaining_owed, p.payout_currency) + '</td>' +
          '<td>' + dataStatusBadge(p.data_status) + '</td>' +
          '<td>' + payoutStatusBadge(p) + '</td>' +
          '<td>' + number(p.adjustment_count) + '</td>' +
          '<td><div class="actions"><button class="button small" data-payout-refresh="' + html(p.affiliate_id) + '">Refresh</button>' +
          (canPay ? '<button class="button small gold" data-payout-pay="' + html(p.id) + '">Record Payment</button>' : '') + '</div></td>' +
        '</tr>';
      }).join('');
    }

    async function refreshAffiliatePayout(affiliateId) {
      const month = $('payoutMonth').value;
      try {
        await adminFetch('/api/admin/affiliate-payouts/refresh', { method:'POST', body:{ affiliateId, payoutPeriod:month + '-01', finalize:false, markReconciled:false } });
        toast('Payout refreshed.');
        await Promise.all([loadPayouts(false), loadAffiliates(false)]);
      } catch (error) { toast(error.message, true); }
    }

    function updateFinalizeButton() {
      const month = $('payoutMonth').value || currentMonthKey();
      $('finalizeMonth').disabled = month >= currentMonthKey();
    }

    async function refreshSelectedMonth() {
      const month = $('payoutMonth').value;
      if (!month) { toast('Choose a calendar month.', true); return; }
      const includeTest = $('includeTestPayouts').checked;
      try {
        const payload = await adminFetch('/api/admin/affiliate-payouts/refresh-period', {
          method:'POST',
          body:{ payoutPeriod:month + '-01', includeTest }
        });
        if (Array.isArray(payload.failures) && payload.failures.length) {
          toast('Refreshed ' + payload.refreshed + ' affiliate(s); ' + payload.failures.length + ' require review.', true);
        } else {
          toast('Refreshed ' + number(payload.refreshed) + ' affiliate payout(s).');
        }
        await Promise.all([loadPayouts(false), loadAffiliates(false), loadAlerts(false)]);
      } catch (error) { toast(error.message, true); }
    }

    async function finalizeSelectedMonth() {
      const month = $('payoutMonth').value;
      if (!month || month >= currentMonthKey()) {
        toast('Only a completed prior calendar month can be finalized.', true); return;
      }
      const includeTest = $('includeTestPayouts').checked;
      if (!confirm('Finalize affiliate payouts for ' + monthName(month) + '? This locks completed payout rows; later Apple corrections carry forward.')) return;
      try {
        const payload = await adminFetch('/api/admin/affiliate-payouts/finalize-period', { method:'POST', body:{ payoutPeriod:month + '-01', includeTest, markReconciled:false } });
        if (Array.isArray(payload.failures) && payload.failures.length) {
          toast('Finalized ' + payload.finalized + ' affiliate(s); ' + payload.failures.length + ' require review.', true);
        } else toast('Month finalized for ' + number(payload.finalized) + ' affiliate(s).');
        await Promise.all([loadPayouts(false), loadAffiliates(false), loadAlerts(false)]);
      } catch (error) { toast(error.message, true); }
    }

    function openPaymentModal(payoutId) {
      const p = payouts.find(x => x.id === payoutId);
      if (!p) return;
      const today = new Date();
      const localDate = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
      openModal('<h2>Record Payment</h2><div class="modal-sub">' + html(p.affiliate_display_name) + ' · ' + html(monthName(p.payout_period)) + '. This writes to the payout ledger and Lifetime Paid.</div>' +
        '<div class="notice danger" style="margin-top:16px">Only record money that was actually sent. Corrections should be entered as correction records rather than deleting history.</div>' +
        '<div class="form-grid"><div class="form-group"><label>Amount</label><input id="payAmount" class="field" type="number" min="0.01" step="0.01" value="' + html(Number(p.remaining_owed).toFixed(2)) + '" /></div>' +
        '<div class="form-group"><label>Payment Date</label><input id="payDate" class="field" type="date" value="' + localDate + '" /></div>' +
        '<div class="form-group"><label>Method</label><input id="payMethod" class="field" placeholder="ACH, PayPal, Venmo..." /></div>' +
        '<div class="form-group"><label>Reference</label><input id="payReference" class="field" placeholder="Confirmation / transaction ID" /></div>' +
        '<div class="form-group full"><label>Note</label><textarea id="payNote" rows="3"></textarea></div></div>' +
        '<div id="paymentError" class="login-error"></div>' +
        '<div class="modal-actions"><button class="button" data-modal-action="close">Cancel</button><button class="button gold" data-modal-action="record-payment" data-payout-id="' + html(payoutId) + '">Record Actual Payment</button></div>');
    }

    async function recordPayment(payoutId) {
      const amount = $('payAmount').value.trim();
      const paymentDate = $('payDate').value;
      if (!amount || Number(amount) <= 0 || !paymentDate) { $('paymentError').textContent = 'A positive amount and payment date are required.'; return; }
      if (!confirm('Confirm that ' + money(amount, p.payout_currency) + ' was actually paid?')) return;
      try {
        await adminFetch('/api/admin/affiliate-payouts/' + encodeURIComponent(payoutId) + '/payments', {
          method:'POST',
          headers:{ 'idempotency-key': crypto.randomUUID() },
          body:{ amount, paymentDate, paymentMethod:$('payMethod').value.trim() || null, paymentReference:$('payReference').value.trim() || null, note:$('payNote').value.trim() || null }
        });
        closeModal();
        toast('Payment recorded.');
        await Promise.all([loadPayouts(false), loadAffiliates(false)]);
      } catch (error) { $('paymentError').textContent = error.message; }
    }

    function openModal(content, context) {
      $('modal').innerHTML = content;
      $('modal').dataset.affiliateId = context?.affiliateId || '';
      $('modalBackdrop').classList.remove('hidden');
    }
    function closeModal() { $('modalBackdrop').classList.add('hidden'); $('modal').innerHTML = ''; $('modal').dataset.affiliateId = ''; }

    async function regenerateDashboardLink(id) {
      const a = affiliateById(id);
      if (!a || !confirm('Regenerate ' + a.display_name + "'s private dashboard link? Their old private link will stop working.")) return;
      try {
        const payload = await adminFetch('/api/admin/affiliates/' + encodeURIComponent(id) + '/regenerate-dashboard-token', { method:'POST' });
        $('modal').innerHTML = '<h2>New Dashboard Link</h2><div class="modal-sub">The old private dashboard URL is now invalid.</div><div class="result-box">' + resultLine('Private Dashboard', payload.dashboardUrl) + '</div><div class="modal-actions"><button class="button gold" data-modal-action="close">Done</button></div>';
      } catch (error) { toast(error.message, true); }
    }

    document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => {
      activeTab = button.dataset.tab;
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === button));
      $('overviewTab').classList.toggle('hidden', activeTab !== 'overview');
      $('payoutsTab').classList.toggle('hidden', activeTab !== 'payouts');
      $('alertsTab').classList.toggle('hidden', activeTab !== 'alerts');
      if (activeTab === 'payouts') loadPayouts(false);
      if (activeTab === 'alerts') loadAlerts(false);
    }));

    $('unlockAdmin').addEventListener('click', async () => {
      const value = $('adminKey').value.trim();
      if (!value) { $('loginError').textContent = 'Enter the admin key.'; return; }
      adminKey = value;
      sessionStorage.setItem('agoraAffiliateAdminKey', adminKey);
      $('loginError').textContent = '';
      await verifyAndLoad();
    });
    $('adminKey').addEventListener('keydown', event => { if (event.key === 'Enter') $('unlockAdmin').click(); });
    $('signOut').addEventListener('click', lockAdmin);
    $('refreshAll').addEventListener('click', () => Promise.all([loadAffiliates(true), loadAppleImports(false), loadAlerts(false), loadPayouts(false)]));
    $('syncAppleOffers').addEventListener('click', () => loadAppleImports(true));
    $('toggleIgnoredAppleImports').addEventListener('click', () => {
      showIgnoredAppleImports = !showIgnoredAppleImports;
      renderAppleImports();
    });
    $('createAffiliate').addEventListener('click', openCreateAffiliate);
    $('affiliateSearch').addEventListener('input', renderAffiliateRows);
    $('affiliateFilter').addEventListener('change', renderAffiliateRows);
    $('loadAlerts').addEventListener('click', () => loadAlerts(true));
    $('alertFilter').addEventListener('change', () => loadAlerts(false));
    $('loadPayouts').addEventListener('click', () => loadPayouts(true));
    $('refreshMonth').addEventListener('click', refreshSelectedMonth);
    $('includeTestPayouts').addEventListener('change', () => loadPayouts(false));
    $('payoutMonth').addEventListener('change', () => { updateFinalizeButton(); loadPayouts(false); });
    $('finalizeMonth').addEventListener('click', finalizeSelectedMonth);

    $('affiliateRows').addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const id = button.dataset.id;
      if (button.dataset.action === 'details') openDetails(id);
      if (button.dataset.action === 'dashboard') openPartnerDashboard(id);
      if (button.dataset.action === 'toggle') toggleAffiliate(id, button.dataset.active === 'true');
    });

    $('appleImportRows').addEventListener('click', event => {
      const setup = event.target.closest('button[data-apple-import-setup]');
      const choose = event.target.closest('button[data-apple-import-choose]');
      const ignore = event.target.closest('button[data-apple-import-ignore]');
      const restore = event.target.closest('button[data-apple-import-restore]');
      const blocked = event.target.closest('button[data-apple-import-blocked]');
      if (setup) openAppleImportSetup(setup.dataset.appleImportSetup);
      if (choose) openAppleConfigurationPicker(choose.dataset.appleImportChoose);
      if (ignore) ignoreAppleImport(ignore.dataset.appleImportIgnore);
      if (restore) restoreAppleImport(restore.dataset.appleImportRestore);
      if (blocked) showAppleAttributionBlocker(blocked.dataset.appleImportBlocked);
    });

    $('alertList').addEventListener('click', event => {
      const button = event.target.closest('button[data-alert-resolve]');
      if (button) resolveAlert(button.dataset.alertResolve);
    });

    $('payoutRows').addEventListener('click', event => {
      const refresh = event.target.closest('button[data-payout-refresh]');
      const pay = event.target.closest('button[data-payout-pay]');
      if (refresh) refreshAffiliatePayout(refresh.dataset.payoutRefresh);
      if (pay) openPaymentModal(pay.dataset.payoutPay);
    });

    $('modalBackdrop').addEventListener('click', async event => {
      if (event.target === $('modalBackdrop')) { closeModal(); return; }
      const copy = event.target.closest('button[data-copy-value]');
      if (copy) { await navigator.clipboard.writeText(copy.dataset.copyValue || ''); toast('Copied.'); return; }
      const action = event.target.closest('button[data-modal-action]');
      if (!action) return;
      const name = action.dataset.modalAction;
      const affiliateId = $('modal').dataset.affiliateId;
      if (name === 'close') closeModal();
      if (name === 'close-refresh') { closeModal(); await loadAffiliates(false); }
      if (name === 'create-affiliate') await createAffiliateFromModal();
      if (name === 'save-apple-canonical') await saveAppleCanonical(action.dataset.code);
      if (name === 'open-dashboard') await openPartnerDashboard(affiliateId);
      if (name === 'copy-referral') {
        const a = affiliateById(affiliateId); if (a?.referral_url) { await navigator.clipboard.writeText(a.referral_url); toast('Referral link copied.'); }
      }
      if (name === 'regenerate') await regenerateDashboardLink(affiliateId);
      if (name === 'record-payment') await recordPayment(action.dataset.payoutId);
    });

    $('payoutMonth').value = currentMonthKey();
    updateFinalizeButton();
    if (adminKey) verifyAndLoad(); else lockAdmin();
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

  const appStoreConnectService = options.appStoreConnectService || createAppStoreConnectAffiliateService({
    issuerId: options.appStoreConnectIssuerId || process.env.APP_STORE_CONNECT_ISSUER_ID,
    keyId: options.appStoreConnectKeyId || process.env.APP_STORE_CONNECT_KEY_ID,
    privateKey: options.appStoreConnectPrivateKey || process.env.APP_STORE_CONNECT_PRIVATE_KEY,
    subscriptionId: options.appleSubscriptionId || process.env.AFFILIATE_APPLE_SUBSCRIPTION_ID,
  });

  const appleImportPreferences = options.appleImportPreferences || createAffiliateAppleImportPreferencesService({ pool });

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

  router.get('/admin/affiliates', adminLimiter, adminPageSecurityHeaders, (_req, res) => {
    return res.type('html').send(renderAffiliateAdminDashboardPage());
  });

  router.get('/', adminLimiter, adminPageSecurityHeaders, (req, res, next) => {
    const host = String(req.hostname || '').toLowerCase();
    if (!host.startsWith('admin.')) return next();
    return res.type('html').send(renderAffiliateAdminDashboardPage());
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

  router.get('/api/admin/app-store-connect/imports', adminOnly, async (_req, res) => {
    try {
      if (!appStoreConnectService.isConfigured()) {
        return res.json({
          success: true,
          configured: false,
          syncedAt: null,
          imports: [],
          linked: [],
          ignored: [],
          warnings: [],
          errorMessage: 'App Store Connect sync is not configured yet.',
        });
      }
      const [affiliates, importPreferences] = await Promise.all([
        service.listAffiliates(),
        appleImportPreferences.listPreferences(),
      ]);
      const payload = await appStoreConnectService.listImports({
        existingAffiliates: affiliates,
        importPreferences,
      });
      return res.json({ success: true, ...payload });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.post('/api/admin/app-store-connect/imports/:code/canonical', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const preference = await appleImportPreferences.selectCanonical({
        customCode: req.params.code,
        offerId: req.body?.offerId,
        customCodeId: req.body?.customCodeId,
        actor,
      });
      return res.json({ success: true, preference });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.post('/api/admin/app-store-connect/imports/:code/ignore', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const preference = await appleImportPreferences.ignoreCode({
        customCode: req.params.code,
        actor,
        note: req.body?.note || 'Marked as a non-affiliate App Store Connect code from Affiliate Admin.',
      });
      return res.json({ success: true, preference });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.post('/api/admin/app-store-connect/imports/:code/restore', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const preference = await appleImportPreferences.restoreCode({
        customCode: req.params.code,
        actor,
      });
      return res.json({ success: true, preference });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.post('/api/admin/affiliates/:id/operational-status', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const affiliate = await service.setAffiliateOperationalStatus({
        affiliateId: req.params.id,
        active: req.body?.active,
        actor,
      });
      return res.json({ success: true, affiliate });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.get('/api/admin/affiliate-alerts', adminOnly, async (req, res) => {
    try {
      const alerts = await service.listAffiliateAlerts({
        status: req.query?.status,
        limit: req.query?.limit,
      });
      return res.json({ success: true, alerts });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.post('/api/admin/affiliate-alerts/:id/resolve', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const result = await service.resolveAffiliateAlert({
        alertId: req.params.id,
        resolutionNote: req.body?.resolutionNote,
        actor,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.get('/api/admin/affiliate-payouts', adminOnly, async (req, res) => {
    try {
      const payouts = await service.listAdminPayouts({
        payoutPeriod: req.query?.payoutPeriod,
        includeTest: req.query?.includeTest == null
          ? true
          : String(req.query.includeTest).trim().toLowerCase() === 'true',
        limit: req.query?.limit,
      });
      return res.json({ success: true, payouts });
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

  router.post('/api/admin/affiliate-payouts/refresh-period', adminOnly, async (req, res) => {
    try {
      const actor = req.get('x-admin-actor') || 'owner_admin';
      const result = await service.refreshAffiliatePayoutsForPeriod({
        payoutPeriod: req.body?.payoutPeriod,
        includeTest: readJsonBoolean(req.body?.includeTest, 'includeTest', false),
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

export { renderPartnerDashboardPage, renderAffiliateAdminDashboardPage };
