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
      `    <section id="view-breakdown" class="hidden">\n      <div class="grid" id="breakdownMetrics"><div class="loading">Loading breakdown...</div></div>\n      <div class="twocol">\n        <div class="section"><div class="sectionhead"><h2>Access source</h2><span>Production</span></div><div class="dist" id="sourceDistribution"></div></div>\n        <div class="section"><div class="sectionhead"><h2>Status</h2><span>Production</span></div><div class="dist" id="statusDistribution"></div></div>\n      </div>\n    </section>\n\n    <section id="view-customers" class="hidden">`
    )
    .replace(
      `,\n        metric('Trials',m.active_trials||0,'Active production trials'),\n        metric('Monthly',m.paid_monthly||0,'Paid monthly subscribers'),\n        metric('Annual',m.paid_annual||0,'Paid annual subscribers'),\n        metric('Lifetime',m.active_lifetime_pro||0,'Permanent Pro, no recurring revenue'),\n        metric('Canceling',m.canceling_subscriptions||0,'Paid subscriptions ending this month')`,
      ``
    )
    .replace(
      `  function customerParams(){`,
      `  async function loadBreakdown(){\n    const metricsEl=qs('#breakdownMetrics'), sourceEl=qs('#sourceDistribution'), statusEl=qs('#statusDistribution');\n    metricsEl.innerHTML='<div class="loading">Loading breakdown...</div>';\n    try{\n      const d=await api('/overview'); const m=d.metrics||{};\n      metricsEl.innerHTML=[\n        metric('Trials',m.active_trials||0,'Active production trials'),\n        metric('Monthly',m.paid_monthly||0,'Paid monthly subscribers'),\n        metric('Annual',m.paid_annual||0,'Paid annual subscribers'),\n        metric('Lifetime',m.active_lifetime_pro||0,'Permanent Pro, no recurring revenue'),\n        metric('Canceling',m.canceling_subscriptions||0,'Paid subscriptions ending this month')\n      ].join('');\n      const sources=d.byAccessSource||[]; const maxS=Math.max(1,...sources.map(x=>Number(x.active_pro||0)));\n      sourceEl.innerHTML=sources.length?sources.map(x=>'<div class="distrow"><span>'+esc(titleCase(x.pro_access_source))+'</span><div class="bar"><i style="width:'+Math.round(Number(x.active_pro||0)/maxS*100)+'%"></i></div><b>'+esc(x.active_pro||0)+'</b></div>').join(''):'<div class="empty">No production entitlements yet.</div>';\n      const statuses=d.byStatus||[]; const maxT=Math.max(1,...statuses.map(x=>Number(x.count||0)));\n      statusEl.innerHTML=statuses.length?statuses.map(x=>'<div class="distrow"><span>'+esc(titleCase(x.status))+'</span><div class="bar"><i style="width:'+Math.round(Number(x.count||0)/maxT*100)+'%"></i></div><b>'+esc(x.count||0)+'</b></div>').join(''):'<div class="empty">No status data yet.</div>';\n    }catch(e){ showError(metricsEl,e); showError(sourceEl,e); showError(statusEl,e); }\n  }\n  function customerParams(){`
    )
    .replace(
      `state.view=view; qsa('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view===view)); ['overview','customers','history','events'].forEach(v=>qs('#view-'+v).classList.toggle('hidden',v!==view));\n    const meta={overview:['Overview','Production subscription health and revenue'],customers:['Customers','Search and inspect subscription ownership'],history:['History','Revenue, Apple proceeds, trials, conversions and churn over time'],events:['Events','Apple subscription lifecycle activity']}[view]; qs('#pageTitle').textContent=meta[0]; qs('#pageSub').textContent=meta[1];\n    if(view==='overview')loadOverview(); if(view==='customers')loadCustomers(); if(view==='history')loadHistory(); if(view==='events')loadEvents();`,
      `state.view=view; qsa('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view===view)); ['overview','breakdown','customers','history','events'].forEach(v=>qs('#view-'+v).classList.toggle('hidden',v!==view));\n    const meta={overview:['Overview','Production subscription health and revenue'],breakdown:['Breakdown','Subscriber mix, access sources and current subscription status'],history:['History','Revenue, Apple proceeds, trials, conversions and churn over time'],events:['Subscribers','Current subscribers and subscription lifecycle history']}[view]; qs('#pageTitle').textContent=meta[0]; qs('#pageSub').textContent=meta[1];\n    if(view==='overview')loadOverview(); if(view==='breakdown')loadBreakdown(); if(view==='history')loadHistory(); if(view==='events')loadEvents();`
    );
}

export default enhanceSubscriptionAdminOverviewHtml;
