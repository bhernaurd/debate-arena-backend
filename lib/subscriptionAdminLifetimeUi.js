export function enhanceSubscriptionAdminLifetimeHtml(html) {
  let output = String(html);

  output = output
    .replace(
      "metric('Active Pro',m.active_pro_entitlements||0,'All production Pro entitlements')",
      "metric('Active subscriptions',Math.max(0,Number(m.active_pro_entitlements||0)-Number(m.active_lifetime_pro||0)),Number(m.active_paid_subscribers||0)+' paid · '+Number(m.active_trials||0)+' trial'+(Number(m.active_trials||0)===1?'':'s')+' · '+Number(hm.newSubscribers||0)+' new this month')"
    )
    .replace(
      "metric('Paid subscribers',m.active_paid_subscribers||0,'Monthly + annual, excluding trials'),",
      "metric('Paid subscribers',m.active_paid_subscribers||0,Number(hm.newPaidSubscribers||0)+' first paid this month'),\n        metric('Free trials',m.active_trials||0,Number(hm.trialStarts||0)+' started this month'),"
    )
    .replace(
      '.grid { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px; }',
      '.grid { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px; }\n    #metrics { grid-template-columns:repeat(5,minmax(0,1fr)); }\n    @media (max-width:1200px){ #metrics{grid-template-columns:repeat(3,1fr)} }\n    @media (max-width:760px){ #metrics{grid-template-columns:1fr 1fr} }'
    )
    .replace(
      '.metric .hint { color:#676f7d;font-size:11px;margin-top:7px; }',
      '.metric .hint { color:#676f7d;font-size:11px;margin-top:7px; }\n    .metric.tone-primary { border-color:rgba(212,181,102,.38);background:linear-gradient(145deg,rgba(212,181,102,.10),var(--panel) 58%);box-shadow:inset 3px 0 0 rgba(212,181,102,.85); }\n    .metric.tone-primary .value { color:#e4c777; }\n    .metric.tone-money { border-color:rgba(114,214,162,.30);background:linear-gradient(145deg,rgba(114,214,162,.08),var(--panel) 58%);box-shadow:inset 3px 0 0 rgba(114,214,162,.72); }\n    .metric.tone-money .value { color:#8fddb2; }\n    .metric.tone-trial { border-color:rgba(156,139,229,.30);background:linear-gradient(145deg,rgba(156,139,229,.09),var(--panel) 58%);box-shadow:inset 3px 0 0 rgba(156,139,229,.72); }\n    .metric.tone-trial .value { color:#b6a7ef; }\n    .metric.tone-info { border-color:rgba(102,168,232,.30);background:linear-gradient(145deg,rgba(102,168,232,.08),var(--panel) 58%);box-shadow:inset 3px 0 0 rgba(102,168,232,.70); }\n    .metric.tone-info .value { color:#8fc1ee; }\n    .metric.tone-estimate { border-color:rgba(239,197,106,.28);background:linear-gradient(145deg,rgba(239,197,106,.075),var(--panel) 58%);box-shadow:inset 3px 0 0 rgba(239,197,106,.62); }\n    .metric.tone-estimate .value { color:#e9c777; }\n    .metric.tone-warning { border-color:rgba(229,164,88,.30);background:linear-gradient(145deg,rgba(229,164,88,.08),var(--panel) 58%);box-shadow:inset 3px 0 0 rgba(229,164,88,.70); }\n    .metric.tone-warning .value { color:#efb66f; }\n    .metric.tone-negative { border-color:rgba(237,125,134,.30);background:linear-gradient(145deg,rgba(237,125,134,.075),var(--panel) 58%);box-shadow:inset 3px 0 0 rgba(237,125,134,.68); }\n    .metric.tone-negative .value { color:#f0959c; }'
    )
    .replace(
      "function metric(label,value,hint=''){ return '<div class=\"metric\"><div class=\"label\">'+esc(label)+'</div><div class=\"value\">'+esc(value)+'</div><div class=\"hint\">'+esc(hint)+'</div></div>'; }",
      "function metricTone(label){ const key=String(label||'').toLowerCase(); if(key.includes('account'))return 'tone-info'; if(key.includes('refund')||key.includes('ended')||key.includes('expired')||key.includes('revoked'))return 'tone-negative'; if(key.includes('cancel')||key.includes('trials ending'))return 'tone-warning'; if(key.includes('free trial')||key.includes('trial start')||key==='trials'||key==='trial')return 'tone-trial'; if(key.includes('apple proceeds')||key.includes('fees + tax')||key.includes('estimated'))return 'tone-estimate'; if(key.includes('gross sales')||key.includes('sales this month')||key.includes('paid subscriber')||key.includes('new paid')||key.includes('free → paid')||key==='monthly'||key==='annual')return 'tone-money'; if(key.includes('active subscription')||key.includes('new subscriber'))return 'tone-primary'; return ''; } function metric(label,value,hint=''){ const tone=metricTone(label); return '<div class=\"metric'+(tone?' '+tone:'')+'\"><div class=\"label\">'+esc(label)+'</div><div class=\"value\">'+esc(value)+'</div><div class=\"hint\">'+esc(hint)+'</div></div>'; }"
    )
    .replaceAll('activeProAtMonthEnd', 'activeSubscriptionsAtMonthEnd')
    .replace(
      "metric('Total subscribers',m.active_pro_entitlements||0,'All active production Pro access')",
      "metric('Active subscriptions',Math.max(0,Number(m.active_pro_entitlements||0)-Number(m.active_lifetime_pro||0)),'Monthly + annual subscriptions and trials')"
    )
    .replace(
      "metric('Total subscribers',row.activeSubscriptionsAtMonthEnd==null?'N/A':row.activeSubscriptionsAtMonthEnd,'Active Pro at the end of '+subscriberMonthLabel(row.month))",
      "metric('Active subscriptions',row.activeSubscriptionsAtMonthEnd==null?'N/A':row.activeSubscriptionsAtMonthEnd,'Monthly + annual subscriptions active at the end of '+subscriberMonthLabel(row.month))"
    )
    .replaceAll('<th>Active Pro at end</th>', '<th>Active subscriptions at end</th>')
    .replaceAll('month-end subscriber total.', 'month-end subscription total.');

  output = output.replace(
    `  async function loadOverview(){`,
    `  function overviewPreviousMonth(h){
    const current=String(h?.currentMonth||'');
    return [...(h?.months||[])].filter(row=>String(row.month||'')<current).sort((a,b)=>String(a.month).localeCompare(String(b.month))).at(-1)||null;
  }
  function overviewGrossHint(previous){
    if(!previous)return 'Verified customer billings · normalized to USD';
    return 'Month to date · '+historyMonthLabel(previous.month)+' total '+historyMoneyBag(previous.grossSales||{});
  }
  function overviewAppleHint(base,previous,connected){
    if(!connected||!previous)return base;
    const bag=previous.appleEstimatedProceeds||{};
    if(!Number(previous.appleReportDays||0)&&!historyHasMoney(bag))return base;
    return base+' · '+historyMonthLabel(previous.month)+' '+historyMoneyBag(bag);
  }
  async function loadOverview(){`
  );

  output = output
    .replace(
      "const appleProceedsHint=appleConnected?'Apple Sales & Trends estimate':'Add Vendor Number and import Apple reports';",
      "const previousMonth=overviewPreviousMonth(h); const appleProceedsHint=overviewAppleHint(appleConnected?'Apple Sales & Trends estimate':'Add Vendor Number and import Apple reports',previousMonth,appleConnected);"
    )
    .replace(
      "metric('Gross sales this month',historyMoneyBag(hm.grossSales||{}),'Verified customer billings · normalized to USD')",
      "metric('Gross sales this month',historyMoneyBag(hm.grossSales||{}),overviewGrossHint(previousMonth))"
    )
    .replace(
      "const [overview,history]=await Promise.all([api('/overview'),api('/history')]);",
      "const [overview,history,accounts]=await Promise.all([api('/overview'),api('/history'),api('/accounts-summary')]);"
    )
    .replace(
      "breakdownData={overview,history};",
      "breakdownData={overview,history,accounts};"
    )
    .replace(
      "metrics.innerHTML=[\n        metric('Active subscriptions',",
      "metrics.innerHTML=[\n        metric('Accounts',Number(breakdownData.accounts?.totalAccounts||0),'Registered Agora accounts · excludes deleted'),\n        metric('Active subscriptions',"
    );

  output = output.replace(
    /<h2>(?:Subscriber growth|Active Pro growth|Active subscription growth)<\/h2><span id="breakdownChartSummary">[^<]*<\/span>/,
    '<h2>New subscribers by month</h2><span id="breakdownChartSummary">First-time subscription starts</span>'
  );

  output = output
    .replaceAll('Loading subscriber growth...', 'Loading new subscriber acquisition...')
    .replaceAll('Loading Active Pro growth...', 'Loading new subscriber acquisition...')
    .replaceAll('Loading subscription growth...', 'Loading new subscriber acquisition...')
    .replaceAll('No subscriber growth history yet.', 'No new subscriber history yet.')
    .replaceAll('No Active Pro history yet.', 'No new subscriber history yet.')
    .replaceAll('No subscription history yet.', 'No new subscriber history yet.');

  output = output.replace(
    /  function breakdownGrowthRows\(\)\{[\s\S]*?\n  \}\n  function renderSubscriberGrowthChart\(selected='current'\)\{[\s\S]*?\n  \}\n  function breakdownHistoryTable/,
    `  function breakdownGrowthRows(){\n    if(!breakdownData)return [];\n    return [...(breakdownData.history?.months||[])]\n      .sort((a,b)=>String(a.month).localeCompare(String(b.month)))\n      .map(row=>({month:row.month,value:Number(row.newSubscribers||0)}))\n      .filter(row=>row.month&&Number.isFinite(row.value));\n  }\n  function renderSubscriberGrowthChart(selected='current'){\n    const el=qs('#breakdownChart'), summary=qs('#breakdownChartSummary');\n    if(!el||!summary||!breakdownData)return;\n    const rows=breakdownGrowthRows();\n    if(!rows.length){ el.innerHTML='<div class="empty">No new subscriber history yet.</div>'; summary.textContent='First-time subscription starts'; return; }\n    const currentMonth=breakdownData.history?.currentMonth;\n    const selectedMonth=selected==='current'?currentMonth:selected;\n    const width=900,height=270,left=54,right=22,top=24,bottom=48;\n    const plotWidth=width-left-right,plotHeight=height-top-bottom,baseY=top+plotHeight;\n    const maxValue=Math.max(1,...rows.map(row=>row.value));\n    const slotWidth=plotWidth/Math.max(1,rows.length);\n    const barWidth=Math.max(28,Math.min(96,slotWidth*.56));\n    const xAt=index=>left+slotWidth*(index+.5);\n    const yAt=value=>top+plotHeight-(value/maxValue)*plotHeight;\n    const tickCount=Math.max(1,Math.min(5,maxValue));\n    const grid=Array.from({length:tickCount+1},(_,index)=>{ const value=Math.round(maxValue*index/tickCount); const y=yAt(value); return '<line x1="'+left+'" y1="'+y.toFixed(1)+'" x2="'+(width-right)+'" y2="'+y.toFixed(1)+'" stroke="#242832" stroke-width="1"/><text x="'+(left-10)+'" y="'+(y+4).toFixed(1)+'" fill="#737b89" font-size="11" text-anchor="end">'+esc(value)+'</text>'; }).join('');\n    const bars=rows.map((row,index)=>{ const x=xAt(index),y=yAt(row.value),active=row.month===selectedMonth,barHeight=Math.max(0,baseY-y); return '<g><rect x="'+(x-barWidth/2).toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+barWidth.toFixed(1)+'" height="'+barHeight.toFixed(1)+'" rx="7" fill="'+(active?'#f0cf79':'#d4b566')+'" opacity="'+(active?'1':'.82')+'"><title>'+esc(subscriberMonthLabel(row.month)+': '+row.value+' new subscriber'+(row.value===1?'':'s'))+'</title></rect><text x="'+x.toFixed(1)+'" y="'+Math.max(14,y-9).toFixed(1)+'" fill="'+(active?'#f3f1eb':'#aeb4be')+'" font-size="11" font-weight="700" text-anchor="middle">'+esc(row.value)+'</text><text x="'+x.toFixed(1)+'" y="'+(height-17)+'" fill="'+(active?'#f3f1eb':'#737b89')+'" font-size="11" text-anchor="middle">'+esc(subscriberMonthShortLabel(row.month))+'</text></g>'; }).join('');\n    el.innerHTML='<svg role="img" aria-label="New subscribers by month" viewBox="0 0 '+width+' '+height+'" style="display:block;width:100%;min-width:680px;height:auto">'+grid+bars+'</svg>';\n    const focused=rows.find(row=>row.month===selectedMonth)||rows[rows.length-1];\n    summary.textContent=focused.value+' new subscriber'+(focused.value===1?'':'s')+' in '+subscriberMonthShortLabel(focused.month);\n  }\n  function breakdownHistoryTable`
  );

  output = output
    .replace(
      '<th>Month</th><th>Active subscriptions at end</th>',
      '<th>Month</th><th>New subscribers</th><th>Active subscriptions at end</th>'
    )
    .replace(
      "+'</span></td><td>'+esc(r.activeSubscriptionsAtMonthEnd==null?",
      "+'</span></td><td>'+esc(r.newSubscribers||0)+'</td><td>'+esc(r.activeSubscriptionsAtMonthEnd==null?"
    );

  return output;
}

export default enhanceSubscriptionAdminLifetimeHtml;
