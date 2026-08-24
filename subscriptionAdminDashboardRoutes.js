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
