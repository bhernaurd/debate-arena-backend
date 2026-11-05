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
  function subscriberSince(r){ return r.subscriber_since||r.original_purchase_date||r.purchase_date||r.created_at||null; }
  function lifetimeValueText(bag,row={}){
    const entries=Object.entries(bag&&typeof bag==='object'?bag:{}).filter(([,value])=>Number.isFinite(Number(value)));
    if(entries.length)return entries.sort(([a],[b])=>a.localeCompare(b)).map(([currency,value])=>money(Number(value),currency||'USD')).join(' + ');
    if(row.store_platform==='app_store'&&row.is_trial===true)return money(0,row.currency||'USD');
    return 'Unavailable';
  }
  function googlePlanMilli(productId){
    if(productId==='agora_pro_monthly')return 7990;
    if(productId==='agora_pro_yearly')return 49990;
    return null;
  }
  function subscriberPlanPriceUsd(r){
    if(Number.isFinite(Number(r.price_usd)))return money(Number(r.price_usd),'USD');
    const inferred=googlePlanMilli(r.product_id);
    if(inferred!=null)return priceMilli(inferred,'USD');
    return null;
  }
  function subscriberOriginalPlanPrice(r){
    if(r.price_milliunits!=null){
      const numeric=Number(r.price_milliunits);
      if(!(r.is_trial===true&&numeric===0))return priceMilli(r.price_milliunits,r.currency);
    }
    if(r.store_platform==='google_play'){
      const inferred=googlePlanMilli(r.product_id);
      if(inferred!=null)return priceMilli(inferred,'USD');
    }
    return 'N/A';
  }
  function lifetimeValueFromTransactions(rows){
    const bag={}, seen=new Set();
    (rows||[]).forEach(t=>{
      const key=[t.store_platform||'',t.environment||'',t.transaction_id||''].join('|');
      if(t.transaction_id&&seen.has(key))return; if(t.transaction_id)seen.add(key);
      if(t.is_trial===true||t.revocation_date)return;
      let price=t.price_milliunits, currency=t.currency;
      if((price==null||!currency)&&t.store_platform==='google_play'){
        price=googlePlanMilli(t.product_id); currency='USD';
      }
      if(price==null||!currency)return;
      const numericPrice=Number(price), quantity=Math.max(1,Number(t.quantity||1));
      if(!Number.isFinite(numericPrice)||numericPrice<0||!Number.isFinite(quantity))return;
      bag[currency]=(bag[currency]||0)+(numericPrice/1000)*quantity;
    });
    return bag;
  }
  function paymentCountFromTransactions(rows){
    const seen=new Set(); let count=0;
    (rows||[]).forEach(t=>{
      const key=[t.store_platform||'',t.environment||'',t.transaction_id||''].join('|');
      if(t.transaction_id&&seen.has(key))return; if(t.transaction_id)seen.add(key);
      if(t.is_trial===true||t.revocation_date)return;
      let price=t.price_milliunits, currency=t.currency;
      if((price==null||!currency)&&t.store_platform==='google_play'){
        price=googlePlanMilli(t.product_id); currency='USD';
      }
      const numericPrice=Number(price);
      if(price==null||!currency||!Number.isFinite(numericPrice)||numericPrice<0)return;
      count+=1;
    });
    return count;
  }
  function actualPaymentText(rows,row={}){
    const seen=new Set();
    for(const t of (rows||[])){
      const key=[t.store_platform||'',t.environment||'',t.transaction_id||''].join('|');
      if(t.transaction_id&&seen.has(key))continue; if(t.transaction_id)seen.add(key);
      if(t.is_trial===true||t.revocation_date)continue;
      const numericPrice=Number(t.price_milliunits), currency=String(t.currency||'').trim().toUpperCase();
      if(Number.isFinite(numericPrice)&&numericPrice>0&&currency)return priceMilli(numericPrice,currency);
    }
    if(row.is_trial===true)return 'Not charged yet';
    if(row.store_platform==='google_play')return 'Local currency not reported by Google Play';
    return subscriberOriginalPlanPrice(row);
  }
  function usPlanPriceText(productId){
    const milli=googlePlanMilli(productId);
    return milli==null?'N/A':priceMilli(milli,'USD');
  }
  function subscriberStartFromTransactions(rows,row={}){
    const candidates=(rows||[]).map(t=>t.original_purchase_date||t.purchase_date||t.created_at).filter(Boolean).map(v=>new Date(v)).filter(d=>!Number.isNaN(d.getTime()));
    if(candidates.length)return new Date(Math.min(...candidates.map(d=>d.getTime()))).toISOString();
    return row.original_purchase_date||row.purchase_date||row.created_at||null;
  }
  function subscriberSortLabel(value){ return value==='newest'?'Newest first':value==='oldest'?'Oldest first':'Last activity'; }
  function subscriberTable(rows){
    if(!rows?.length)return '<div class="empty">No subscribers found.</div>';
    return '<table><thead><tr><th>Subscriber</th><th>Subscription</th><th>Status</th><th>Value</th><th>Next billing</th><th>Referral</th><th>Last activity</th></tr></thead><tbody>'+rows.map(r=>{
      const store=r.store_platform==='google_play'?'Google Play':'App Store';
      const planPrice=subscriberPlanPriceUsd(r);
      const ltv=Number.isFinite(Number(r.lifetime_value_usd))?money(Number(r.lifetime_value_usd),'USD'):'USD unavailable';
      const next=nextActionHtml(r,r.access_ends_at||r.expires_date)+(planPrice?'<div class="muted" style="margin-top:4px">'+esc(planPrice)+'</div>':'');
      const referral=r.affiliate_display_name?(r.affiliate_display_name+(r.affiliate_code?' · '+r.affiliate_code:'')):(r.affiliate_code||'None');
      return '<tr class="clickable" data-customer="'+esc(r.customer_key)+'"><td><strong>'+esc(customerName(r))+'</strong><div class="muted mono">'+esc(shortId(r.original_transaction_id))+'</div></td><td><strong>'+esc(titleCase(r.pro_access_source))+'</strong><div class="muted">'+esc(store)+'</div></td><td>'+statusPill(r)+'</td><td><strong>'+esc(ltv)+'</strong><div class="muted">'+esc(Number(r.payment_count||0))+' '+(Number(r.payment_count||0)===1?'payment':'payments')+' collected</div></td><td>'+next+'</td><td>'+esc(referral)+'</td><td>'+esc(formatDateOnly(r.latest_transaction_signed_date||r.updated_at))+'</td></tr>';
    }).join('')+'</tbody></table>';
  }
  async function loadEvents(){
    const el=qs('#eventTable'), count=qs('#subscriberCount'); el.innerHTML='<div class="loading">Loading subscribers...</div>';
    try{ const d=await api('/customers?'+subscriberParams().toString()); const rows=d.customers||[]; el.innerHTML=subscriberTable(rows); if(count)count.textContent=Number(d.total||0)+' total · '+subscriberSortLabel(d.sort||qs('#subscriberSort').value); bindCustomerRows(el); }catch(e){ showError(el,e); }
  }
  async function openCustomer(key){`
  );

  output = output.replace(
    /      const details=\[\['Customer',customerName\(c\)\][\s\S]*?\];\n      const tx=/,
    `      const detailTransactions=d.transactions||[], detailStart=subscriberStartFromTransactions(detailTransactions,c), detailLifetime=lifetimeValueFromTransactions(detailTransactions), detailPayments=paymentCountFromTransactions(detailTransactions), actualPayment=actualPaymentText(detailTransactions,c);
      const details=[['Customer',customerName(c)],['Account email',c.account_email||'N/A'],['Account ID',c.account_id||'N/A'],['Original transaction',c.original_transaction_id||'N/A'],['Subscription',titleCase(c.pro_access_source)+' · '+(c.store_platform==='google_play'?'Google Play':'App Store')],['Status',titleCase(c.status)],['Actual payment',actualPayment],['US plan price',usPlanPriceText(c.product_id)],['Lifetime value',lifetimeValueText(detailLifetime,c)],['Payments collected',String(detailPayments)],['Subscriber since',formatDateOnly(detailStart)],['Product',c.product_id||'N/A'],['Environment',c.environment||'N/A'],['Auto-renew',typeof autoRenewDetail==='function'?autoRenewDetail(c):(c.is_lifetime_pro?'N/A':(c.auto_renew_enabled===true?'On':c.auto_renew_enabled===false?'Off':'Unknown'))],['Access ends',c.is_lifetime_pro?'Never':fmtDate(c.access_ends_at)],['Pricing cohort',titleCase(c.pricing_cohort)],['Referral',c.affiliate_display_name?(c.affiliate_display_name+(c.affiliate_code?' · '+c.affiliate_code:'')):(c.affiliate_code||'None')],['Affiliate attribution',c.affiliate_attribution_source?titleCase(c.affiliate_attribution_source):'None']];
      const tx=`
  );

  output = output.replace(
    "  qs('#eventFilterButton').addEventListener('click',loadEvents);",
    "  qs('#eventFilterButton').addEventListener('click',loadEvents); qs('#subscriberSort')?.addEventListener('change',loadEvents);"
  );

  return output;
}

export default enhanceSubscriptionAdminSubscribersHtml;
