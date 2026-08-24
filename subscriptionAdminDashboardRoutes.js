import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';

const COOKIE_NAME = 'agora_subscription_admin_session';
const DEFAULT_SESSION_HOURS = 12;

function cleanText(value, maxLength = 4096) {
  if (value == null) return '';
  return String(value).trim().slice(0, maxLength);
}

function constantTimeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''), 'utf8');
  const right = Buffer.from(String(rightValue || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function readCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

function securityHeaders(_req, res, next) {
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Credentials');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
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

function createSessionManager({
  adminKey,
  password,
  cookieSecret,
  sessionHours,
  allowInsecureCookie,
}) {
  const cleanAdminKey = cleanText(adminKey);
  const cleanPassword = cleanText(password) || cleanAdminKey;
  const secret = cleanText(cookieSecret) || cleanAdminKey;
  const durationHours = boundedInteger(
    sessionHours,
    DEFAULT_SESSION_HOURS,
    1,
    168
  );
  const maxAgeSeconds = durationHours * 60 * 60;

  function configured() {
    return (
      cleanAdminKey.length >= 32 &&
      cleanPassword.length >= 12 &&
      secret.length >= 32
    );
  }

  function signPayload(payload) {
    return crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('base64url');
  }

  function createToken() {
    const expiresAt = Date.now() + maxAgeSeconds * 1000;
    const payload = `v1.${expiresAt}`;
    return `${payload}.${signPayload(payload)}`;
  }

  function verifyToken(token) {
    if (!configured()) return false;
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return false;

    const expiresAt = Number(parts[1]);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

    const payload = `${parts[0]}.${parts[1]}`;
    return constantTimeEqual(parts[2], signPayload(payload));
  }

  function isAuthorized(req) {
    return verifyToken(readCookie(req, COOKIE_NAME));
  }

  function passwordMatches(candidate) {
    return configured() && constantTimeEqual(cleanText(candidate), cleanPassword);
  }

  function setCookie(res) {
    const secure = allowInsecureCookie !== true;
    const attributes = [
      `${COOKIE_NAME}=${encodeURIComponent(createToken())}`,
      'Path=/subscription-admin',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (secure) attributes.push('Secure');
    res.setHeader('Set-Cookie', attributes.join('; '));
  }

  function clearCookie(res) {
    const secure = allowInsecureCookie !== true;
    const attributes = [
      `${COOKIE_NAME}=`,
      'Path=/subscription-admin',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
    ];
    if (secure) attributes.push('Secure');
    res.setHeader('Set-Cookie', attributes.join('; '));
  }

  return Object.freeze({
    configured,
    isAuthorized,
    passwordMatches,
    setCookie,
    clearCookie,
    adminKey: cleanAdminKey,
    durationHours,
  });
}

function renderLoginPage({ error = null, configured = true } = {}) {
  const message = !configured
    ? 'Dashboard authentication is not configured on the server.'
    : error;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Agora Subscriptions</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #090a0d; color: #f5f2e9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .card { width: min(440px, calc(100vw - 32px)); background: #111318; border: 1px solid #252932; border-radius: 22px; padding: 30px; box-shadow: 0 30px 80px rgba(0,0,0,.4); }
    .mark { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 14px; background: linear-gradient(145deg,#d6b76a,#8d6c2e); color: #111; font-weight: 800; margin-bottom: 22px; }
    h1 { margin: 0 0 8px; font-size: 27px; letter-spacing: -.03em; }
    p { margin: 0 0 24px; color: #9da3ae; line-height: 1.5; }
    label { display: block; font-size: 13px; color: #aeb3bd; margin-bottom: 8px; }
    input { width: 100%; border: 1px solid #2c313b; background: #0b0d11; color: #fff; border-radius: 12px; padding: 13px 14px; font: inherit; outline: none; }
    input:focus { border-color: #a88a48; box-shadow: 0 0 0 3px rgba(168,138,72,.15); }
    button { width: 100%; margin-top: 14px; border: 0; border-radius: 12px; padding: 13px 16px; font: inherit; font-weight: 700; background: #d7b96b; color: #111; cursor: pointer; }
    .error { margin: 0 0 18px; border: 1px solid #67363b; background: #241315; color: #ffb7bc; border-radius: 12px; padding: 11px 12px; font-size: 13px; }
    .foot { margin-top: 18px; color: #666d79; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <main class="card">
    <div class="mark">A</div>
    <h1>Agora Subscriptions</h1>
    <p>Private owner dashboard for subscription customers, revenue, entitlements and lifecycle events.</p>
    ${message ? `<div class="error">${escapeHtml(message)}</div>` : ''}
    ${configured ? `
    <form method="post" action="/subscription-admin/login">
      <label for="password">Dashboard password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
      <button type="submit">Sign in</button>
    </form>` : ''}
    <div class="foot">The Agora private administration</div>
  </main>
</body>
</html>`;
}

function renderDashboardPage({ sessionHours }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Agora Subscriptions</title>
  <style>
    :root { color-scheme: dark; --bg:#08090c; --panel:#111318; --panel2:#15181e; --line:#242832; --text:#f3f1eb; --muted:#8d95a3; --gold:#d4b566; --good:#72d6a2; --warn:#efc56a; --bad:#ed7d86; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,input,select { font:inherit; }
    button { cursor:pointer; }
    .shell { display:grid; grid-template-columns:240px minmax(0,1fr); min-height:100vh; }
    aside { border-right:1px solid var(--line); background:#0d0f13; padding:22px 16px; position:sticky; top:0; height:100vh; }
    .brand { display:flex; align-items:center; gap:11px; padding:4px 8px 22px; font-weight:750; }
    .brandmark { width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(145deg,#d6b76a,#836425);color:#111;font-weight:900; }
    nav { display:grid; gap:4px; }
    .nav { border:0;background:transparent;color:#969dab;text-align:left;padding:11px 12px;border-radius:10px; }
    .nav.active,.nav:hover { color:#fff;background:#171a21; }
    .sidebottom { position:absolute;left:16px;right:16px;bottom:18px; }
    .logout { width:100%;border:1px solid var(--line);background:transparent;color:#9da4b0;border-radius:10px;padding:10px; }
    main { min-width:0; padding:28px 32px 60px; }
    .top { display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:28px; }
    h1 { margin:0;font-size:27px;letter-spacing:-.035em; }
    .sub { color:var(--muted);font-size:13px;margin-top:6px; }
    .refresh { border:1px solid var(--line);background:var(--panel);color:#d7dae0;border-radius:10px;padding:9px 12px; }
    .grid { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px; }
    .metric { background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:17px;min-height:112px; }
    .metric .label { color:var(--muted);font-size:12px;margin-bottom:13px; }
    .metric .value { font-size:30px;font-weight:760;letter-spacing:-.04em; }
    .metric .hint { color:#676f7d;font-size:11px;margin-top:7px; }
    .section { margin-top:22px;background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden; }
    .sectionhead { display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--line); }
    .sectionhead h2 { margin:0;font-size:15px; }
    .sectionhead span { color:var(--muted);font-size:12px; }
    .tablewrap { overflow:auto; }
    table { width:100%;border-collapse:collapse;min-width:860px; }
    th { color:#7e8795;font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.04em;text-align:left;padding:11px 14px;border-bottom:1px solid var(--line); }
    td { padding:13px 14px;border-bottom:1px solid #1c2027;font-size:13px;vertical-align:middle; }
    tbody tr:last-child td { border-bottom:0; }
    tbody tr.clickable:hover { background:#171a20; }
    .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px; }
    .muted { color:var(--muted); }
    .pill { display:inline-flex;align-items:center;border:1px solid #303641;border-radius:999px;padding:4px 8px;font-size:11px;color:#c4c8d0;background:#171a20;white-space:nowrap; }
    .pill.good { border-color:#265940;color:#91e5b8;background:#10241b; }
    .pill.warn { border-color:#65512a;color:#f0ce80;background:#241d10; }
    .pill.bad { border-color:#63343a;color:#ff9ca4;background:#261216; }
    .toolbar { display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px; }
    .toolbar input,.toolbar select { border:1px solid var(--line);background:#101217;color:#e8e9ec;border-radius:10px;padding:9px 10px;outline:none; }
    .toolbar input { min-width:260px;flex:1; }
    .toolbar button { border:1px solid var(--line);background:#181b21;color:#e8e9ec;border-radius:10px;padding:9px 12px; }
    .empty,.loading,.error { padding:28px;text-align:center;color:var(--muted); }
    .error { color:#f3a1a8; }
    .twocol { display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:22px; }
    .dist { padding:15px 18px; }
    .distrow { display:grid;grid-template-columns:120px 1fr auto;gap:10px;align-items:center;padding:8px 0; }
    .bar { height:7px;border-radius:999px;background:#22262e;overflow:hidden; }
    .bar > i { display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#80682f,#d7b96b); }
    .drawerback { position:fixed;inset:0;background:rgba(0,0,0,.58);display:none;z-index:20; }
    .drawerback.open { display:block; }
    .drawer { position:absolute;right:0;top:0;bottom:0;width:min(760px,92vw);background:#0e1014;border-left:1px solid var(--line);overflow:auto;padding:24px; }
    .drawerhead { display:flex;justify-content:space-between;gap:12px;align-items:flex-start;position:sticky;top:-24px;background:#0e1014;padding:24px 0 16px;z-index:2;border-bottom:1px solid var(--line); }
    .drawer h2 { margin:0;font-size:20px; }
    .close { border:1px solid var(--line);background:#171a20;color:#fff;border-radius:9px;padding:7px 10px; }
    .detailgrid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:18px; }
    .detail { border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0; }
    .detail b { display:block;color:#777f8d;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px; }
    .detail span { display:block;overflow-wrap:anywhere;font-size:13px; }
    .timeline { margin-top:20px; }
    .timeline h3 { font-size:14px;margin:0 0 10px; }
    .event { border-left:2px solid #3a404b;padding:2px 0 16px 13px;margin-left:4px; }
    .event strong { font-size:12px; }
    .event small { display:block;color:var(--muted);margin-top:4px; }
    .hidden { display:none !important; }
    @media (max-width:1000px){ .grid{grid-template-columns:repeat(2,1fr)} .twocol{grid-template-columns:1fr} }
    @media (max-width:760px){ .shell{display:block} aside{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:12px} nav{display:flex;overflow:auto}.nav{white-space:nowrap}.sidebottom{position:static;margin-top:8px}.brand{padding-bottom:10px} main{padding:20px 14px 50px}.grid{grid-template-columns:1fr 1fr}.metric{min-height:100px}.toolbar input{min-width:100%}.detailgrid{grid-template-columns:1fr} }
  </style>
</head>
<body>
<div class="shell">
  <aside>
    <div class="brand"><div class="brandmark">A</div><div>Agora Subscriptions</div></div>
    <nav>
      <button class="nav active" data-view="overview">Overview</button>
      <button class="nav" data-view="customers">Customers</button>
      <button class="nav" data-view="events">Events</button>
    </nav>
    <div class="sidebottom">
      <form method="post" action="/subscription-admin/logout"><button class="logout" type="submit">Sign out</button></form>
    </div>
  </aside>
  <main>
    <div class="top">
      <div><h1 id="pageTitle">Overview</h1><div class="sub" id="pageSub">Production subscription health and revenue</div></div>
      <button class="refresh" id="refreshButton">Refresh</button>
    </div>

    <section id="view-overview">
      <div class="grid" id="metrics"><div class="loading">Loading metrics...</div></div>
      <div class="twocol">
        <div class="section"><div class="sectionhead"><h2>Access source</h2><span>Production</span></div><div class="dist" id="sourceDistribution"></div></div>
        <div class="section"><div class="sectionhead"><h2>Status</h2><span>Production</span></div><div class="dist" id="statusDistribution"></div></div>
      </div>
      <div class="section"><div class="sectionhead"><h2>Recent customers</h2><span>Latest subscription activity</span></div><div class="tablewrap" id="recentCustomers"></div></div>
    </section>

    <section id="view-customers" class="hidden">
      <div class="toolbar">
        <input id="customerSearch" placeholder="Search email, account, transaction or affiliate" />
        <select id="customerEnvironment"><option value="Production">Production</option><option value="Sandbox">Sandbox</option><option value="all">All environments</option></select>
        <select id="customerSource"><option value="all">All access</option><option value="monthly">Monthly</option><option value="annual">Annual</option><option value="lifetime">Lifetime</option></select>
        <select id="customerStatus"><option value="all">All statuses</option><option value="active">Active</option><option value="trial">Trial</option><option value="grace_period">Grace period</option><option value="billing_retry">Billing retry</option><option value="expired">Expired</option><option value="revoked">Revoked</option></select>
        <button id="customerFilterButton">Apply</button>
      </div>
      <div class="section"><div class="sectionhead"><h2>Customers</h2><span id="customerCount"></span></div><div class="tablewrap" id="customerTable"><div class="loading">Loading customers...</div></div></div>
    </section>

    <section id="view-events" class="hidden">
      <div class="toolbar">
        <input id="eventSearch" placeholder="Search customer or transaction" />
        <select id="eventEnvironment"><option value="Production">Production</option><option value="Sandbox">Sandbox</option><option value="all">All environments</option></select>
        <input id="eventType" placeholder="Event type, e.g. RENEWAL" />
        <button id="eventFilterButton">Apply</button>
      </div>
      <div class="section"><div class="sectionhead"><h2>Subscription events</h2><span>Newest first</span></div><div class="tablewrap" id="eventTable"><div class="loading">Loading events...</div></div></div>
    </section>
  </main>
</div>

<div class="drawerback" id="drawerBack"><aside class="drawer" id="drawer"><div class="loading">Loading customer...</div></aside></div>

<script>
(() => {
  const state = { view: 'overview', customerOffset: 0 };
  const qs = (s) => document.querySelector(s);
  const qsa = (s) => [...document.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const fmtDate = (v) => v ? new Date(v).toLocaleString() : 'N/A';
  const money = (v, currency='USD') => {
    const n = Number(v || 0);
    try { return new Intl.NumberFormat(undefined,{style:'currency',currency}).format(n); } catch { return '$' + n.toFixed(2); }
  };
  const priceMilli = (v, currency='USD') => v == null ? 'N/A' : money(Number(v)/1000, currency || 'USD');
  const shortId = (v) => { const s=String(v||''); return !s ? 'N/A' : (s.length>16 ? s.slice(0,8)+'…'+s.slice(-5) : s); };
  const titleCase = (v) => String(v||'unknown').replaceAll('_',' ').replace(/\b\w/g,m=>m.toUpperCase());
  const statusPill = (row) => {
    const status=String(row.status||row.status_after||'unknown');
    const cls = row.has_pro_access || ['active','trial','grace_period'].includes(status) ? 'good' : (status==='billing_retry' ? 'warn' : (['revoked','expired'].includes(status) ? 'bad' : ''));
    return '<span class="pill '+cls+'">'+esc(titleCase(status))+'</span>';
  };
  async function api(path) {
    const r = await fetch('/subscription-admin/data' + path, { credentials:'same-origin', headers:{'accept':'application/json'} });
    if (r.status===401) { location.href='/subscription-admin/login'; throw new Error('Session expired'); }
    const body = await r.json().catch(()=>({}));
    if (!r.ok || body.success===false) throw new Error(body?.error?.message || 'Request failed');
    return body;
  }
  function showError(el,error){ el.innerHTML='<div class="error">'+esc(error.message||error)+'</div>'; }
  function metric(label,value,hint=''){ return '<div class="metric"><div class="label">'+esc(label)+'</div><div class="value">'+esc(value)+'</div><div class="hint">'+esc(hint)+'</div></div>'; }
  function customerName(r){ return r.account_display_name || r.account_email || (r.account_id ? shortId(r.account_id) : shortId(r.original_transaction_id)); }
  function customerTable(rows){
    if(!rows?.length) return '<div class="empty">No customers found.</div>';
    return '<table><thead><tr><th>Customer</th><th>Access</th><th>Status</th><th>Renewal</th><th>Price</th><th>Environment</th><th>Updated</th></tr></thead><tbody>'+rows.map(r=>'<tr class="clickable" data-customer="'+esc(r.customer_key)+'"><td><strong>'+esc(customerName(r))+'</strong><div class="muted mono">'+esc(shortId(r.original_transaction_id))+'</div></td><td>'+esc(titleCase(r.pro_access_source))+(r.is_trial?' <span class="pill warn">Trial</span>':'')+'</td><td>'+statusPill(r)+'</td><td>'+esc(r.is_lifetime_pro?'Permanent':(r.auto_renew_enabled===false?'Off':(r.auto_renew_enabled===true?'On':'N/A')))+'</td><td>'+esc(priceMilli(r.price_milliunits,r.currency))+'</td><td><span class="pill">'+esc(r.environment)+'</span></td><td>'+esc(fmtDate(r.latest_transaction_signed_date||r.updated_at))+'</td></tr>').join('')+'</tbody></table>';
  }
  function bindCustomerRows(root=document){ qsa.call ? null : null; root.querySelectorAll?.('[data-customer]').forEach(el=>el.addEventListener('click',()=>openCustomer(el.dataset.customer))); }
  async function loadOverview(){
    const metricsEl=qs('#metrics');
    try {
      const d=await api('/overview'); const m=d.metrics||{};
      metricsEl.innerHTML=[
        metric('Active Pro',m.active_pro_entitlements||0,'All production Pro entitlements'),
        metric('Paid subscribers',m.active_paid_subscribers||0,'Monthly + annual, excluding trials'),
        metric('Estimated MRR',money(m.estimated_mrr_usd||0),'Recurring only. Lifetime excluded'),
        metric('Trials',m.active_trials||0,'Active production trials'),
        metric('Monthly',m.paid_monthly||0,'Paid monthly subscribers'),
        metric('Annual',m.paid_annual||0,'Paid annual subscribers'),
        metric('Lifetime',m.active_lifetime_pro||0,'Permanent Pro, no recurring revenue'),
        metric('Canceling',m.canceling_subscriptions||0,'Auto-renew off but access remains')
      ].join('');
      const sources=d.byAccessSource||[]; const maxS=Math.max(1,...sources.map(x=>Number(x.active_pro||0)));
      qs('#sourceDistribution').innerHTML=sources.length?sources.map(x=>'<div class="distrow"><span>'+esc(titleCase(x.pro_access_source))+'</span><div class="bar"><i style="width:'+Math.round(Number(x.active_pro||0)/maxS*100)+'%"></i></div><b>'+esc(x.active_pro||0)+'</b></div>').join(''):'<div class="empty">No production entitlements yet.</div>';
      const statuses=d.byStatus||[]; const maxT=Math.max(1,...statuses.map(x=>Number(x.count||0)));
      qs('#statusDistribution').innerHTML=statuses.length?statuses.map(x=>'<div class="distrow"><span>'+esc(titleCase(x.status))+'</span><div class="bar"><i style="width:'+Math.round(Number(x.count||0)/maxT*100)+'%"></i></div><b>'+esc(x.count||0)+'</b></div>').join(''):'<div class="empty">No status data yet.</div>';
      qs('#recentCustomers').innerHTML=customerTable(d.recentCustomers||[]); bindCustomerRows(qs('#recentCustomers'));
    } catch(e){ showError(metricsEl,e); }
  }
  function customerParams(){ const p=new URLSearchParams({limit:'100',offset:String(state.customerOffset),environment:qs('#customerEnvironment').value,accessSource:qs('#customerSource').value,status:qs('#customerStatus').value}); const q=qs('#customerSearch').value.trim(); if(q)p.set('q',q); return p; }
  async function loadCustomers(){
    const el=qs('#customerTable'); el.innerHTML='<div class="loading">Loading customers...</div>';
    try{ const d=await api('/customers?'+customerParams().toString()); qs('#customerCount').textContent=(d.total||0)+' total'; el.innerHTML=customerTable(d.customers||[]); bindCustomerRows(el); }catch(e){ showError(el,e); }
  }
  function eventParams(){ const p=new URLSearchParams({limit:'150',environment:qs('#eventEnvironment').value}); const q=qs('#eventSearch').value.trim(); const type=qs('#eventType').value.trim(); if(q)p.set('q',q); if(type)p.set('eventType',type); return p; }
  async function loadEvents(){
    const el=qs('#eventTable'); el.innerHTML='<div class="loading">Loading events...</div>';
    try{ const d=await api('/events?'+eventParams().toString()); const rows=d.events||[]; el.innerHTML=rows.length?'<table><thead><tr><th>Event</th><th>Customer</th><th>Product</th><th>Status after</th><th>Environment</th><th>Time</th></tr></thead><tbody>'+rows.map(r=>'<tr '+(r.customer_key?'class="clickable" data-customer="'+esc(r.customer_key)+'"':'')+'><td><strong>'+esc(titleCase(r.event_type))+'</strong><div class="muted">'+esc(r.subtype||r.source||'')+'</div></td><td>'+esc(r.account_email||r.account_display_name||shortId(r.original_transaction_id))+'</td><td>'+esc(titleCase(r.pro_access_source||r.product_id))+'</td><td>'+statusPill(r)+'</td><td><span class="pill">'+esc(r.environment)+'</span></td><td>'+esc(fmtDate(r.event_at))+'</td></tr>').join('')+'</tbody></table>':'<div class="empty">No events found.</div>'; bindCustomerRows(el); }catch(e){ showError(el,e); }
  }
  async function openCustomer(key){
    const back=qs('#drawerBack'), drawer=qs('#drawer'); back.classList.add('open'); drawer.innerHTML='<div class="loading">Loading customer...</div>';
    try{
      const d=await api('/customers/'+encodeURIComponent(key)); const c=(d.chains||[])[0]||{};
      const details=[['Customer',customerName(c)],['Account email',c.account_email||'N/A'],['Account ID',c.account_id||'N/A'],['Original transaction',c.original_transaction_id||'N/A'],['Access',titleCase(c.pro_access_source)],['Status',titleCase(c.status)],['Product',c.product_id||'N/A'],['Environment',c.environment||'N/A'],['Auto-renew',c.is_lifetime_pro?'N/A':(c.auto_renew_enabled===true?'On':c.auto_renew_enabled===false?'Off':'Unknown')],['Access ends',c.is_lifetime_pro?'Never':fmtDate(c.access_ends_at)],['Pricing cohort',titleCase(c.pricing_cohort)],['Affiliate',c.affiliate_code||'None']];
      const tx=(d.transactions||[]).slice(0,40), ev=(d.events||[]).slice(0,60);
      drawer.innerHTML='<div class="drawerhead"><div><h2>'+esc(customerName(c))+'</h2><div class="sub">'+esc(c.customer_key||'')+'</div></div><button class="close" id="drawerClose">Close</button></div><div class="detailgrid">'+details.map(([a,b])=>'<div class="detail"><b>'+esc(a)+'</b><span>'+esc(b)+'</span></div>').join('')+'</div><div class="timeline"><h3>Transactions</h3>'+(tx.length?tx.map(t=>'<div class="event"><strong>'+esc(titleCase(t.transaction_reason||'transaction'))+' · '+esc(t.product_id||'')+'</strong><small>'+esc(fmtDate(t.signed_date||t.purchase_date))+' · '+esc(priceMilli(t.price_milliunits,t.currency))+' · '+esc(shortId(t.transaction_id))+'</small></div>').join(''):'<div class="empty">No transactions.</div>')+'</div><div class="timeline"><h3>Lifecycle events</h3>'+(ev.length?ev.map(e=>'<div class="event"><strong>'+esc(titleCase(e.event_type))+(e.subtype?' · '+esc(titleCase(e.subtype)):'')+'</strong><small>'+esc(fmtDate(e.event_at))+' · '+esc(titleCase(e.status_after))+'</small></div>').join(''):'<div class="empty">No events.</div>')+'</div>';
      qs('#drawerClose').addEventListener('click',closeDrawer);
    }catch(e){ showError(drawer,e); }
  }
  function closeDrawer(){ qs('#drawerBack').classList.remove('open'); }
  function switchView(view){
    state.view=view; qsa('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view===view)); ['overview','customers','events'].forEach(v=>qs('#view-'+v).classList.toggle('hidden',v!==view));
    const meta={overview:['Overview','Production subscription health and revenue'],customers:['Customers','Search and inspect subscription ownership'],events:['Events','Apple subscription lifecycle activity']}[view]; qs('#pageTitle').textContent=meta[0]; qs('#pageSub').textContent=meta[1];
    if(view==='overview')loadOverview(); if(view==='customers')loadCustomers(); if(view==='events')loadEvents();
  }
  qsa('.nav').forEach(n=>n.addEventListener('click',()=>switchView(n.dataset.view)));
  qs('#refreshButton').addEventListener('click',()=>switchView(state.view));
  qs('#customerFilterButton').addEventListener('click',()=>{state.customerOffset=0;loadCustomers();});
  qs('#customerSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){state.customerOffset=0;loadCustomers();}});
  qs('#eventFilterButton').addEventListener('click',loadEvents);
  qs('#eventSearch').addEventListener('keydown',e=>{if(e.key==='Enter')loadEvents();});
  qs('#drawerBack').addEventListener('click',e=>{if(e.target===qs('#drawerBack'))closeDrawer();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer();});
  loadOverview();
})();
</script>
</body>
</html>`;
}

function queryString(req) {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(req.query || {})) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value != null) params.append(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function createSubscriptionAdminDashboardRouter({
  adminKey =
    process.env.SUBSCRIPTION_DASHBOARD_ADMIN_KEY ||
    process.env.ANALYTICS_ADMIN_KEY,
  password = process.env.SUBSCRIPTION_DASHBOARD_PASSWORD,
  cookieSecret = process.env.SUBSCRIPTION_DASHBOARD_COOKIE_SECRET,
  sessionHours = process.env.SUBSCRIPTION_DASHBOARD_SESSION_HOURS,
  allowInsecureCookie =
    String(process.env.SUBSCRIPTION_DASHBOARD_ALLOW_INSECURE_COOKIE || '')
      .trim()
      .toLowerCase() === 'true',
  port = process.env.PORT || 3000,
} = {}) {
  const router = express.Router();
  const session = createSessionManager({
    adminKey,
    password,
    cookieSecret,
    sessionHours,
    allowInsecureCookie,
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many sign-in attempts. Try again later.',
  });

  router.use(securityHeaders);

  router.get('/login', (req, res) => {
    if (session.isAuthorized(req)) {
      return res.redirect(302, '/subscription-admin');
    }
    return res.status(session.configured() ? 200 : 503).send(
      renderLoginPage({ configured: session.configured() })
    );
  });

  router.post(
    '/login',
    loginLimiter,
    express.urlencoded({ extended: false, limit: '8kb' }),
    (req, res) => {
      if (!session.configured()) {
        return res.status(503).send(
          renderLoginPage({ configured: false })
        );
      }

      if (!session.passwordMatches(req.body?.password)) {
        return res.status(401).send(
          renderLoginPage({ error: 'Incorrect dashboard password.' })
        );
      }

      session.setCookie(res);
      return res.redirect(303, '/subscription-admin');
    }
  );

  router.post('/logout', (req, res) => {
    session.clearCookie(res);
    return res.redirect(303, '/subscription-admin/login');
  });

  router.use((req, res, next) => {
    if (session.isAuthorized(req)) return next();
    if (req.path.startsWith('/data/')) {
      return res.status(401).json({
        success: false,
        error: { code: 'subscription_dashboard_session_required', message: 'Sign in again.' },
      });
    }
    return res.redirect(302, '/subscription-admin/login');
  });

  async function proxyJson(req, res, apiPath) {
    try {
      const url = `http://127.0.0.1:${port}/api/subscription-admin${apiPath}${queryString(req)}`;
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'x-admin-key': session.adminKey,
        },
      });
      const text = await response.text();
      res.status(response.status);
      res.type('application/json');
      return res.send(text);
    } catch (error) {
      console.error('[SubscriptionDashboard] Data proxy failed:', error?.message || error);
      return res.status(502).json({
        success: false,
        error: {
          code: 'subscription_dashboard_proxy_failed',
          message: 'Dashboard data is temporarily unavailable.',
        },
      });
    }
  }

  router.get('/data/overview', (req, res) =>
    proxyJson(req, res, '/overview')
  );
  router.get('/data/customers', (req, res) =>
    proxyJson(req, res, '/customers')
  );
  router.get('/data/customers/:customerKey', (req, res) =>
    proxyJson(
      req,
      res,
      `/customers/${encodeURIComponent(cleanText(req.params.customerKey, 256))}`
    )
  );
  router.get('/data/events', (req, res) =>
    proxyJson(req, res, '/events')
  );

  router.get('/', (_req, res) => {
    return res.send(
      renderDashboardPage({ sessionHours: session.durationHours })
    );
  });

  return router;
}
