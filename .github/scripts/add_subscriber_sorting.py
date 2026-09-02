from pathlib import Path

# API sorting support.
path = Path('subscriptionAdminRoutes.js')
text = path.read_text()
marker = "const VALID_STATUSES = new Set([\n  'trial',\n  'active',\n  'grace_period',\n  'billing_retry',\n  'expired',\n  'revoked',\n  'unknown',\n]);\n"
insert = marker + "\nconst CUSTOMER_SORTS = new Set([\n  'last_activity',\n  'newest',\n  'oldest',\n]);\n"
assert marker in text
text = text.replace(marker, insert, 1)

marker = "function normalizeBooleanQuery(value, fieldName) {\n"
helper = "function normalizeCustomerSort(value) {\n  const clean = cleanText(value, 32).toLowerCase() || 'last_activity';\n  if (!CUSTOMER_SORTS.has(clean)) {\n    const error = new Error('sort must be last_activity, newest, or oldest.');\n    error.statusCode = 400;\n    error.code = 'invalid_customer_sort';\n    throw error;\n  }\n  return clean;\n}\n\nfunction customerSortSql(sort) {\n  if (sort === 'newest') {\n    return `COALESCE(original_purchase_date, purchase_date, created_at) DESC NULLS LAST, customer_key ASC`;\n  }\n  if (sort === 'oldest') {\n    return `COALESCE(original_purchase_date, purchase_date, created_at) ASC NULLS LAST, customer_key ASC`;\n  }\n  return `CASE WHEN has_pro_access THEN 0 ELSE 1 END, CASE WHEN environment = 'Production' THEN 0 ELSE 1 END, COALESCE(latest_transaction_signed_date, updated_at) DESC NULLS LAST, customer_key ASC`;\n}\n\n" + marker
assert marker in text
text = text.replace(marker, helper, 1)

old = "      const limit = boundedInteger(req.query.limit, 50, 1, 100);\n      const offset = boundedInteger(req.query.offset, 0, 0, 100000);\n      const filters = buildCustomerFilters(req.query);\n"
new = "      const limit = boundedInteger(req.query.limit, 50, 1, 500);\n      const offset = boundedInteger(req.query.offset, 0, 0, 100000);\n      const sort = normalizeCustomerSort(req.query.sort);\n      const filters = buildCustomerFilters(req.query);\n"
assert old in text
text = text.replace(old, new, 1)

old = "        ORDER BY\n          CASE WHEN has_pro_access THEN 0 ELSE 1 END,\n          CASE WHEN environment = 'Production' THEN 0 ELSE 1 END,\n          COALESCE(latest_transaction_signed_date, updated_at) DESC NULLS LAST,\n          customer_key ASC\n"
new = "        ORDER BY ${customerSortSql(sort)}\n"
assert old in text
text = text.replace(old, new, 1)

old = "        offset,\n        customers: customersResult.rows,\n"
new = "        offset,\n        sort,\n        customers: customersResult.rows,\n"
assert old in text
text = text.replace(old, new, 1)
path.write_text(text)

# Final UI enhancer for the Subscribers tab.
Path('lib/subscriptionAdminSubscribersUi.js').write_text(r'''export function enhanceSubscriptionAdminSubscribersHtml(html) {
  let output = String(html);

  output = output
    .replace(
      '<input id="eventType" placeholder="Filter history event, e.g. DID_RENEW" />',
      '<select id="subscriberSort"><option value="last_activity">Last activity</option><option value="newest">Newest subscribers</option><option value="oldest">Oldest subscribers</option></select>'
    )
    .replace(
      '<h2>Subscribers</h2><span>Current state · click a subscriber for full history</span></div><div class="tablewrap" id="eventTable">',
      '<h2>Subscribers</h2><span id="subscriberCount">Current state · click a subscriber for full history</span></div><div class="tablewrap" id="eventTable">'
    );

  output = output.replace(
    '  async function openCustomer(key){',
    `  function subscriberParams(){
    const p=new URLSearchParams({limit:'500',offset:'0',environment:qs('#eventEnvironment').value,sort:qs('#subscriberSort').value});
    const q=qs('#eventSearch').value.trim(); if(q)p.set('q',q); return p;
  }
  function subscriberSince(r){ return r.original_purchase_date||r.purchase_date||r.created_at||null; }
  function subscriberSortLabel(value){ return value==='newest'?'Newest first':value==='oldest'?'Oldest first':'Last activity'; }
  function subscriberTable(rows){
    if(!rows?.length)return '<div class="empty">No subscribers found.</div>';
    return '<table><thead><tr><th>Subscriber</th><th>Access</th><th>Status</th><th>Subscriber since</th><th>Next</th><th>Price</th><th>Environment</th><th>Last activity</th></tr></thead><tbody>'+rows.map(r=>'<tr class="clickable" data-customer="'+esc(r.customer_key)+'"><td><strong>'+esc(customerName(r))+'</strong><div class="muted mono">'+esc(shortId(r.original_transaction_id))+'</div></td><td>'+esc(titleCase(r.pro_access_source))+(r.is_trial?' <span class="pill warn">Trial</span>':(r.has_pro_access&&r.is_recurring_pro&&r.status==='active'?' <span class="pill good">Paid</span>':''))+'</td><td>'+statusPill(r)+'</td><td>'+esc(formatDateOnly(subscriberSince(r)))+'</td><td>'+nextActionHtml(r,r.access_ends_at||r.expires_date)+'</td><td>'+esc(priceMilli(r.price_milliunits,r.currency))+'</td><td><span class="pill">'+esc(r.environment)+'</span></td><td>'+esc(fmtDate(r.latest_transaction_signed_date||r.updated_at))+'</td></tr>').join('')+'</tbody></table>';
  }
  async function loadEvents(){
    const el=qs('#eventTable'), count=qs('#subscriberCount'); el.innerHTML='<div class="loading">Loading subscribers...</div>';
    try{ const d=await api('/customers?'+subscriberParams().toString()); const rows=d.customers||[]; el.innerHTML=subscriberTable(rows); if(count)count.textContent=Number(d.total||0)+' total · '+subscriberSortLabel(d.sort||qs('#subscriberSort').value); bindCustomerRows(el); }catch(e){ showError(el,e); }
  }
  async function openCustomer(key){`
  );

  output = output.replace(
    "  qs('#eventFilterButton').addEventListener('click',loadEvents);",
    "  qs('#eventFilterButton').addEventListener('click',loadEvents); qs('#subscriberSort')?.addEventListener('change',loadEvents);"
  );

  return output;
}

export default enhanceSubscriptionAdminSubscribersHtml;
''')

# Compose the enhancer last so it sees the final Subscribers markup.
path = Path('subscriptionAdminDashboardRoutes.js')
text = path.read_text()
marker = "import {\n  enhanceSubscriptionAdminAutoRenewHtml,\n} from './lib/subscriptionAdminAutoRenewUi.js';\n"
insert = marker + "import {\n  enhanceSubscriptionAdminSubscribersHtml,\n} from './lib/subscriptionAdminSubscribersUi.js';\n"
assert marker in text
text = text.replace(marker, insert, 1)
old = "          ? enhanceSubscriptionAdminAutoRenewHtml(\n              enhanceSubscriptionAdminAccountsHtml("
new = "          ? enhanceSubscriptionAdminSubscribersHtml(\n              enhanceSubscriptionAdminAutoRenewHtml(\n              enhanceSubscriptionAdminAccountsHtml("
assert old in text
text = text.replace(old, new, 1)
old = "              )\n            )\n          : body;"
new = "              )\n              )\n            )\n          : body;"
assert old in text
text = text.replace(old, new, 1)
path.write_text(text)

# Syntax check coverage.
path = Path('package.json')
text = path.read_text()
old = "node --check lib/subscriptionAdminAutoRenewUi.js && node --check lib/subscriptionAdminHistoryService.js"
new = "node --check lib/subscriptionAdminAutoRenewUi.js && node --check lib/subscriptionAdminSubscribersUi.js && node --check lib/subscriptionAdminHistoryService.js"
assert old in text
path.write_text(text.replace(old, new, 1))

# Focused regression test.
Path('test/subscriptionAdminSubscriberSorting.test.js').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { enhanceSubscriptionAdminHistoryHtml } from '../lib/subscriptionAdminHistoryUi.js';
import { enhanceSubscriptionAdminPayoutHtml } from '../lib/subscriptionAdminPayoutUi.js';
import { enhanceSubscriptionAdminOverviewHtml } from '../lib/subscriptionAdminOverviewUi.js';
import { enhanceSubscriptionAdminRevenueHtml } from '../lib/subscriptionAdminRevenueUi.js';
import { enhanceSubscriptionAdminLifetimeHtml } from '../lib/subscriptionAdminLifetimeUi.js';
import { enhanceSubscriptionAdminAccountsHtml } from '../lib/subscriptionAdminAccountsUi.js';
import { enhanceSubscriptionAdminAutoRenewHtml } from '../lib/subscriptionAdminAutoRenewUi.js';
import { enhanceSubscriptionAdminSubscribersHtml } from '../lib/subscriptionAdminSubscribersUi.js';

function renderBaseDashboard(){
  const source=fs.readFileSync(new URL('../subscriptionAdminDashboardBaseRoutes.js',import.meta.url),'utf8');
  const a=source.indexOf('function renderDashboardPage({ sessionHours }) {');
  const b=source.indexOf('\n\nfunction queryString(req) {',a);
  return new Function(`${source.slice(a,b)}; return renderDashboardPage;`)()({sessionHours:12});
}
function renderFinalDashboard(){
  let output=String(renderBaseDashboard())
    .replace('Auto-renew off but access remains','Paid subscriptions ending this month')
    .replace(`metric('Estimated MRR',money(m.estimated_mrr_usd||0),'Recurring only. Lifetime excluded')`,`metric('Sales this month',money(m.net_sales_this_month_usd||0),'Customer billings this month · before Apple fees/tax')`)
    .replace(`<div class="section"><div class="sectionhead"><h2>Subscription events</h2><span>Newest first</span></div><div class="tablewrap" id="eventTable"><div class="loading">Loading events...</div></div></div>`,`<div class="section"><div class="sectionhead"><h2>Subscription customers</h2><span>Current state · click a customer for full history</span></div><div class="tablewrap" id="eventTable"><div class="loading">Loading customers...</div></div></div>`)
    .replace(`placeholder="Event type, e.g. RENEWAL"`,`placeholder="Filter history event, e.g. DID_RENEW"`);
  output=enhanceSubscriptionAdminHistoryHtml(output);
  output=enhanceSubscriptionAdminPayoutHtml(output);
  output=enhanceSubscriptionAdminOverviewHtml(output);
  output=enhanceSubscriptionAdminRevenueHtml(output);
  output=enhanceSubscriptionAdminLifetimeHtml(output);
  output=enhanceSubscriptionAdminAccountsHtml(output);
  output=enhanceSubscriptionAdminAutoRenewHtml(output);
  return enhanceSubscriptionAdminSubscribersHtml(output);
}

test('Subscribers tab offers activity, newest, and oldest sorting',()=>{
  const html=renderFinalDashboard();
  assert.match(html,/id="subscriberSort"/);
  assert.match(html,/Last activity/);
  assert.match(html,/Newest subscribers/);
  assert.match(html,/Oldest subscribers/);
  assert.match(html,/Subscriber since/);
  assert.match(html,/original_purchase_date\|\|r\.purchase_date\|\|r\.created_at/);
  assert.match(html,/api\('\/customers\?'\+subscriberParams\(\)\.toString\(\)\)/);
  const script=html.match(/<script>\s*([\s\S]*?)\s*<\/script>/i)?.[1]||'';
  assert.ok(script);
  new vm.Script(script,{filename:'subscription-admin-client.js'});
});

test('customer API uses a validated server-side sort',()=>{
  const source=fs.readFileSync(new URL('../subscriptionAdminRoutes.js',import.meta.url),'utf8');
  assert.match(source,/CUSTOMER_SORTS/);
  assert.match(source,/normalizeCustomerSort\(req\.query\.sort\)/);
  assert.match(source,/sort === 'newest'/);
  assert.match(source,/sort === 'oldest'/);
  assert.match(source,/COALESCE\(original_purchase_date, purchase_date, created_at\) DESC NULLS LAST/);
  assert.match(source,/COALESCE\(original_purchase_date, purchase_date, created_at\) ASC NULLS LAST/);
});
''')
