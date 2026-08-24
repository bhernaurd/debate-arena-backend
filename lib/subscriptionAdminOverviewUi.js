export function enhanceSubscriptionAdminOverviewHtml(html) {
  return String(html)
    .replace(
      `<button class="nav active" data-view="overview">Overview</button>\n      <button class="nav" data-view="customers">Customers</button>`,
      `<button class="nav active" data-view="overview">Overview</button>\n      <button class="nav" data-view="breakdown">Breakdown</button>`
    )
    .replace(
      `<button class="nav" data-view="events">Events</button>`,
      `<button class="nav" data-view="events">Subscribers</button>`
    )
    .replace(
      `<h2>Subscription customers</h2><span>Current state · click a customer for full history</span>`,
      `<h2>Subscribers</h2><span>Current state · click a subscriber for full history</span>`
    )
    .replace(
      `<h2>Subscription events</h2><span>Newest first</span>`,
      `<h2>Subscribers</h2><span>Current state · click a subscriber for full history</span>`
    )
    .replace(
      `<h2>Recent customers</h2><span>Latest subscription activity</span>`,
      `<h2>Recent subscribers</h2><span>Latest subscription activity</span>`
    )
    .replace(
      `      <div class="twocol">\n        <div class="section"><div class="sectionhead"><h2>Access source</h2><span>Production</span></div><div class="dist" id="sourceDistribution"></div></div>\n        <div class="section"><div class="sectionhead"><h2>Status</h2><span>Production</span></div><div class="dist" id="statusDistribution"></div></div>\n      </div>\n`,
      ``
    )
    .replace(
      `    <section id="view-customers" class="hidden">`,
      `    <section id="view-breakdown" class="hidden">\n      <div class="toolbar history-toolbar">\n        <select id="breakdownPeriod"><option value="current">Current</option></select>\n        <div class="history-note" id="breakdownNote">Current subscriber state. Choose a past month to see subscriber activity and month-end totals.</div>\n      </div>\n      <div class="grid" id="breakdownMetrics"><div class="loading">Loading subscriber breakdown...</div></div>\n      <div class="section">\n        <div class="sectionhead"><h2>Subscriber history</h2><span>Production · America/Chicago</span></div>\n        <div class="tablewrap" id="breakdownTable"><div class="loading">Loading subscriber history...</div></div>\n      </div>\n    </section>\n\n    <section id="view-customers" class="hidden">`
    )
    .replace(
      `,\n        metric('Trials',m.active_trials||0,'Active production trials'),\n        metric('Monthly',m.paid_monthly||0,'Paid monthly subscribers'),\n        metric('Annual',m.paid_annual||0,'Paid annual subscribers'),\n        metric('Lifetime',m.active_lifetime_pro||0,'Permanent Pro, no recurring revenue'),\n        metric('Canceling',m.canceling_subscriptions||0,'Paid subscriptions ending this month')`,
      ``
    )
    .replace(
      `      const sources=d.byAccessSource||[]; const maxS=Math.max(1,...sources.map(x=>Number(x.active_pro||0)));\n      qs('#sourceDistribution').innerHTML=sources.length?sources.map(x=>'<div class="distrow"><span>'+esc(titleCase(x.pro_access_source))+'</span><div class="bar"><i style="width:'+Math.round(Number(x.active_pro||0)/maxS*100)+'%"></i></div><b>'+esc(x.active_pro||0)+'</b></div>').join(''):'<div class="empty">No production entitlements yet.</div>';\n      const statuses=d.byStatus||[]; const maxT=Math.max(1,...statuses.map(x=>Number(x.count||0)));\n      qs('#statusDistribution').innerHTML=statuses.length?statuses.map(x=>'<div class="distrow"><span>'+esc(titleCase(x.status))+'</span><div class="bar"><i style="width:'+Math.round(Number(x.count||0)/maxT*100)+'%"></i></div><b>'+esc(x.count||0)+'</b></div>').join(''):'<div class="empty">No status data yet.</div>';\n`,
      ``
    )
    .replace(
      `  function customerParams(){`,
      `  let breakdownData=null;\n  function subscriberMonthLabel(key){\n    const parts=String(key||'').split('-').map(Number);\n    if(parts.length!==2||!parts[0]||!parts[1])return String(key||'Unknown');\n    return new Date(Date.UTC(parts[0],parts[1]-1,1)).toLocaleDateString(undefined,{month:'long',year:'numeric',timeZone:'UTC'});\n  }\n  function breakdownHistoryTable(months){\n    if(!months?.length)return '<div class="empty">No subscriber history yet.</div>';\n    const rows=[...months].sort((a,b)=>String(b.month).localeCompare(String(a.month)));\n    return '<table><thead><tr><th>Month</th><th>Active Pro at end</th><th>Free period starts</th><th>New paid</th><th>Free → Paid</th><th>Lifetime added</th><th>Cancel requests</th><th>Ended</th></tr></thead><tbody>'+rows.map(r=>'<tr><td><span class="history-month">'+esc(subscriberMonthLabel(r.month))+'</span></td><td>'+esc(r.activeProAtMonthEnd==null?'N/A':r.activeProAtMonthEnd)+'</td><td>'+esc(r.trialStarts||0)+'</td><td>'+esc(r.newPaidSubscribers||0)+'</td><td>'+esc(r.trialConversions||0)+'</td><td>'+esc(r.lifetimeGrants||0)+'</td><td>'+(Number(r.cancellationRequests||0)>0?'<span class="pill warn">'+esc(r.cancellationRequests)+'</span>':'<span class="history-zero">0</span>')+'</td><td>'+(Number(r.subscriptionsEnded||0)>0?'<span class="pill bad">'+esc(r.subscriptionsEnded)+'</span>':'<span class="history-zero">0</span>')+'</td></tr>').join('')+'</tbody></table>';\n  }\n  function renderBreakdownPeriod(){\n    if(!breakdownData)return;\n    const selected=qs('#breakdownPeriod').value||'current';\n    const metrics=qs('#breakdownMetrics'), note=qs('#breakdownNote');\n    if(selected==='current'){\n      const m=breakdownData.overview?.metrics||{};\n      metrics.innerHTML=[\n        metric('Total subscribers',m.active_pro_entitlements||0,'All active production Pro access'),\n        metric('Free period',m.active_trials||0,'Active free-trial subscribers'),\n        metric('Monthly',m.paid_monthly||0,'Active paid monthly subscribers'),\n        metric('Annual',m.paid_annual||0,'Active paid annual subscribers'),\n        metric('Lifetime',m.active_lifetime_pro||0,'Permanent Pro access'),\n        metric('Canceling',m.canceling_subscriptions||0,'Auto-renew off while access remains')\n      ].join('');\n      note.textContent='Current subscriber state. Free period means active free-trial access.';\n      return;\n    }\n    const row=(breakdownData.history?.months||[]).find(item=>item.month===selected);\n    if(!row){ metrics.innerHTML='<div class="empty">No subscriber data for this period.</div>'; return; }\n    metrics.innerHTML=[\n      metric('Total subscribers',row.activeProAtMonthEnd==null?'N/A':row.activeProAtMonthEnd,'Active Pro at the end of '+subscriberMonthLabel(row.month)),\n      metric('Free period starts',row.trialStarts||0,'Subscribers who started a free trial'),\n      metric('New paid',row.newPaidSubscribers||0,'Subscribers who made their first payment'),\n      metric('Free → Paid',row.trialConversions||0,'First successful payment after a free trial'),\n      metric('Lifetime added',row.lifetimeGrants||0,'New Lifetime Pro access'),\n      metric('Cancel requests',row.cancellationRequests||0,'Auto-renew turned off'),\n      metric('Subscriptions ended',row.subscriptionsEnded||0,'Access actually expired')\n    ].join('');\n    note.textContent=subscriberMonthLabel(row.month)+' subscriber activity and month-end subscriber total.';\n  }\n  async function loadBreakdown(){\n    const metrics=qs('#breakdownMetrics'), table=qs('#breakdownTable'), select=qs('#breakdownPeriod');\n    metrics.innerHTML='<div class="loading">Loading subscriber breakdown...</div>';\n    table.innerHTML='<div class="loading">Loading subscriber history...</div>';\n    try{\n      const [overview,history]=await Promise.all([api('/overview'),api('/history')]);\n      breakdownData={overview,history};\n      const previous=select.value||'current';\n      select.innerHTML='<option value="current">Current</option>'+[...(history.months||[])].sort((a,b)=>String(b.month).localeCompare(String(a.month))).map(r=>'<option value="'+esc(r.month)+'">'+esc(subscriberMonthLabel(r.month))+'</option>').join('');\n      select.value=[...select.options].some(option=>option.value===previous)?previous:'current';\n      table.innerHTML=breakdownHistoryTable(history.months||[]);\n      renderBreakdownPeriod();\n    }catch(e){ showError(metrics,e); showError(table,e); }\n  }\n  function customerParams(){`
    )
    .replace(
      `state.view=view; qsa('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view===view)); ['overview','customers','history','events'].forEach(v=>qs('#view-'+v).classList.toggle('hidden',v!==view));\n    const meta={overview:['Overview','Production subscription health and revenue'],customers:['Customers','Search and inspect subscription ownership'],history:['History','Revenue, Apple proceeds, trials, conversions and churn over time'],events:['Events','Apple subscription lifecycle activity']}[view]; qs('#pageTitle').textContent=meta[0]; qs('#pageSub').textContent=meta[1];\n    if(view==='overview')loadOverview(); if(view==='customers')loadCustomers(); if(view==='history')loadHistory(); if(view==='events')loadEvents();`,
      `state.view=view; qsa('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view===view)); ['overview','breakdown','customers','history','events'].forEach(v=>qs('#view-'+v).classList.toggle('hidden',v!==view));\n    const meta={overview:['Overview','Production subscription health and revenue'],breakdown:['Breakdown','Subscriber totals, free periods, plan mix and subscriber activity over time'],history:['History','Revenue, Apple proceeds, trials, conversions and churn over time'],events:['Subscribers','Current subscribers and subscription lifecycle history']}[view]; qs('#pageTitle').textContent=meta[0]; qs('#pageSub').textContent=meta[1];\n    if(view==='overview')loadOverview(); if(view==='breakdown')loadBreakdown(); if(view==='history')loadHistory(); if(view==='events')loadEvents();`
    )
    .replace(
      `  qs('#historyPeriod').addEventListener('change',renderHistoryPeriod);`,
      `  qs('#breakdownPeriod').addEventListener('change',renderBreakdownPeriod);\n  qs('#historyPeriod').addEventListener('change',renderHistoryPeriod);`
    );
}

export default enhanceSubscriptionAdminOverviewHtml;
