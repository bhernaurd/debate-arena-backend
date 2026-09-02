export function enhanceSubscriptionAdminSubscribersHtml(html) {
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
