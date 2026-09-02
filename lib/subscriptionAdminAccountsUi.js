export function enhanceSubscriptionAdminAccountsHtml(html) {
  let output = String(html);

  output = output
    .replace(
      '<button class="nav" data-view="breakdown">Subscriber Analytics</button>',
      '<button class="nav" data-view="breakdown">Subscriber Analytics</button>\n      <button class="nav" data-view="accounts">Accounts</button>'
    )
    .replace(
      '    <section id="view-history" class="hidden">',
      `    <section id="view-accounts" class="hidden">\n      <div class="grid accounts-metrics" id="accountMetrics"><div class="loading">Loading accounts...</div></div>\n      <div class="section">\n        <div class="sectionhead"><h2>Accounts created by month</h2><span id="accountsChartSummary">New registered accounts</span></div>\n        <div id="accountsChart" class="accounts-chart"><div class="loading">Loading account creation history...</div></div>\n      </div>\n      <div class="section">\n        <div class="sectionhead"><h2>Monthly account history</h2><span>America/Chicago</span></div>\n        <div class="tablewrap" id="accountsTable"><div class="loading">Loading account history...</div></div>\n      </div>\n    </section>\n\n    <section id="view-history" class="hidden">`
    )
    .replace(
      '.hidden { display:none !important; }',
      `.accounts-metrics { grid-template-columns:repeat(3,minmax(0,1fr)); }\n    .accounts-chart { padding:14px 18px 12px;min-height:300px;overflow-x:auto; }\n    @media (max-width:900px){ .accounts-metrics{grid-template-columns:1fr 1fr} }\n    @media (max-width:620px){ .accounts-metrics{grid-template-columns:1fr} }\n    .hidden { display:none !important; }`
    )
    .replace(
      "const [overview,history,accounts]=await Promise.all([api('/overview'),api('/history'),api('/accounts-summary')]);",
      "const [overview,history]=await Promise.all([api('/overview'),api('/history')]);"
    )
    .replace(
      'breakdownData={overview,history,accounts};',
      'breakdownData={overview,history};'
    )
    .replace(
      "        metric('Accounts',Number(breakdownData.accounts?.totalAccounts||0),'Registered Agora accounts · excludes deleted'),\n",
      ''
    );

  output = output.replace(
    `  function eventParams(){`,
    `  let accountsData=null;\n  function accountMonthLabel(key){\n    const parts=String(key||'').split('-').map(Number);\n    if(parts.length!==2||!parts[0]||!parts[1])return String(key||'Unknown');\n    return new Date(Date.UTC(parts[0],parts[1]-1,1)).toLocaleDateString(undefined,{month:'long',year:'numeric',timeZone:'UTC'});\n  }\n  function accountMonthShortLabel(key){\n    const parts=String(key||'').split('-').map(Number);\n    if(parts.length!==2||!parts[0]||!parts[1])return String(key||'');\n    return new Date(Date.UTC(parts[0],parts[1]-1,1)).toLocaleDateString(undefined,{month:'short',year:'2-digit',timeZone:'UTC'});\n  }\n  function renderAccountsChart(){\n    const el=qs('#accountsChart'), summary=qs('#accountsChartSummary');\n    if(!el||!summary||!accountsData)return;\n    const rows=[...(accountsData.months||[])].sort((a,b)=>String(a.month).localeCompare(String(b.month)));\n    if(!rows.length){ el.innerHTML='<div class="empty">No account creation history yet.</div>'; summary.textContent='New registered accounts'; return; }\n    const currentMonth=String(accountsData.currentMonth||'');\n    const width=900,height=270,left=54,right=22,top=24,bottom=48;\n    const plotWidth=width-left-right,plotHeight=height-top-bottom,baseY=top+plotHeight;\n    const maxValue=Math.max(1,...rows.map(row=>Number(row.createdAccounts||0)));\n    const slotWidth=plotWidth/Math.max(1,rows.length);\n    const barWidth=Math.max(28,Math.min(96,slotWidth*.56));\n    const xAt=index=>left+slotWidth*(index+.5);\n    const yAt=value=>top+plotHeight-(Number(value||0)/maxValue)*plotHeight;\n    const tickCount=Math.max(1,Math.min(5,maxValue));\n    const grid=Array.from({length:tickCount+1},(_,index)=>{ const value=Math.round(maxValue*index/tickCount); const y=yAt(value); return '<line x1="'+left+'" y1="'+y.toFixed(1)+'" x2="'+(width-right)+'" y2="'+y.toFixed(1)+'" stroke="#242832" stroke-width="1"/><text x="'+(left-10)+'" y="'+(y+4).toFixed(1)+'" fill="#737b89" font-size="11" text-anchor="end">'+esc(value)+'</text>'; }).join('');\n    const bars=rows.map((row,index)=>{ const value=Number(row.createdAccounts||0),x=xAt(index),y=yAt(value),active=row.month===currentMonth,barHeight=Math.max(0,baseY-y); return '<g><rect x="'+(x-barWidth/2).toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+barWidth.toFixed(1)+'" height="'+barHeight.toFixed(1)+'" rx="7" fill="'+(active?'#8fc1ee':'#66a8e8')+'" opacity="'+(active?'1':'.80')+'"><title>'+esc(accountMonthLabel(row.month)+': '+value+' account'+(value===1?'':'s')+' created')+'</title></rect><text x="'+x.toFixed(1)+'" y="'+Math.max(14,y-9).toFixed(1)+'" fill="'+(active?'#f3f1eb':'#aeb4be')+'" font-size="11" font-weight="700" text-anchor="middle">'+esc(value)+'</text><text x="'+x.toFixed(1)+'" y="'+(height-17)+'" fill="'+(active?'#f3f1eb':'#737b89')+'" font-size="11" text-anchor="middle">'+esc(accountMonthShortLabel(row.month))+'</text></g>'; }).join('');\n    el.innerHTML='<svg role="img" aria-label="Accounts created by month" viewBox="0 0 '+width+' '+height+'" style="display:block;width:100%;min-width:680px;height:auto">'+grid+bars+'</svg>';\n    const current=rows.find(row=>row.month===currentMonth)||rows[rows.length-1];\n    const value=Number(current?.createdAccounts||0);\n    summary.textContent=value+' account'+(value===1?'':'s')+' created in '+accountMonthShortLabel(current?.month);\n  }\n  function accountsTableHtml(){\n    const rows=[...(accountsData?.months||[])].sort((a,b)=>String(a.month).localeCompare(String(b.month)));\n    if(!rows.length)return '<div class="empty">No account creation history yet.</div>';\n    let running=0;\n    const enriched=rows.map(row=>{ running+=Number(row.createdAccounts||0); return {...row,runningTotal:running}; }).reverse();\n    return '<table><thead><tr><th>Month</th><th>Accounts created</th><th>All-time created through month</th></tr></thead><tbody>'+enriched.map(row=>'<tr><td><span class="history-month">'+esc(accountMonthLabel(row.month))+'</span>'+(row.month===accountsData.currentMonth?' <span class="history-current">Current</span>':'')+'</td><td>'+esc(row.createdAccounts||0)+'</td><td>'+esc(row.runningTotal||0)+'</td></tr>').join('')+'</tbody></table>';\n  }\n  async function loadAccounts(){\n    const metrics=qs('#accountMetrics'), chart=qs('#accountsChart'), table=qs('#accountsTable');\n    metrics.innerHTML='<div class="loading">Loading accounts...</div>'; chart.innerHTML='<div class="loading">Loading account creation history...</div>'; table.innerHTML='<div class="loading">Loading account history...</div>';\n    try{\n      accountsData=await api('/accounts-summary');\n      metrics.innerHTML=[\n        metric('Current accounts',Number(accountsData.totalAccounts||0),'Registered accounts · deleted accounts excluded'),\n        metric('Created this month',Number(accountsData.createdThisMonth||0),'New account registrations this month'),\n        metric('All-time created',Number(accountsData.allTimeCreated||0),'Includes accounts that were later deleted')\n      ].join('');\n      renderAccountsChart();\n      table.innerHTML=accountsTableHtml();\n    }catch(e){ showError(metrics,e); showError(chart,e); showError(table,e); }\n  }\n  function eventParams(){`
  );

  output = output
    .replace(
      "['overview','breakdown','customers','history','events']",
      "['overview','breakdown','accounts','customers','history','events']"
    )
    .replace(
      "breakdown:['Subscriber Analytics','Subscriber totals, plan mix and lifecycle trends over time'],",
      "breakdown:['Subscriber Analytics','Subscriber totals, plan mix and lifecycle trends over time'],accounts:['Accounts','Registered Agora accounts and account creation over time'],"
    )
    .replace(
      "if(view==='breakdown')loadBreakdown();",
      "if(view==='breakdown')loadBreakdown(); if(view==='accounts')loadAccounts();"
    );

  return output;
}

export default enhanceSubscriptionAdminAccountsHtml;
