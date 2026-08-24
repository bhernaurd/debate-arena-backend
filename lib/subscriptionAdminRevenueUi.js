export function enhanceSubscriptionAdminRevenueHtml(html) {
  let output = String(html);

  output = output
    .replace(
      /<button class="nav" data-view="breakdown">Breakdown<\/button>/,
      '<button class="nav" data-view="breakdown">Subscriber Analytics</button>'
    )
    .replace(
      /<button class="nav" data-view="history">History<\/button>/,
      '<button class="nav" data-view="history">Revenue</button>'
    )
    .replace(
      /breakdown:\['Breakdown','[^']*'\]/,
      "breakdown:['Subscriber Analytics','Subscriber totals, plan mix and lifecycle trends over time']"
    )
    .replace(
      /history:\['History','[^']*'\]/,
      "history:['Revenue','Sales, Apple proceeds, fees and refunds over time']"
    )
    .replace(
      '<h2>Monthly history</h2>',
      '<h2>Monthly financial history</h2>'
    )
    .replace(
      `      <div class="section">\n        <div class="sectionhead"><h2>Monthly financial history</h2><span>Production · America/Chicago</span></div>`,
      `      <div class="section">\n        <div class="sectionhead"><h2>Gross sales trend</h2><span id="revenueTrendSummary">Gross sales · USD</span></div>\n        <div id="revenueTrendChart" class="revenue-trend-chart"><div class="loading">Loading gross sales trend...</div></div>\n      </div>\n      <div class="section">\n        <div class="sectionhead"><h2>Monthly financial history</h2><span>Production · America/Chicago</span></div>`
    )
    .replace(
      `      <div class="section">\n        <div class="sectionhead"><h2>Final Apple settlements</h2><span>Closed Apple fiscal periods</span></div>\n        <div class="tablewrap" id="financialHistoryTable"><div class="loading">Loading financial reports...</div></div>\n      </div>`,
      `      <details class="section revenue-settlements">\n        <summary class="revenue-settlements-summary"><span><strong>Final Apple settlements</strong><small>Closed Apple fiscal periods and final proceeds</small></span><span class="revenue-settlements-action">View settlements <b>⌄</b></span></summary>\n        <div class="tablewrap" id="financialHistoryTable"><div class="loading">Loading financial reports...</div></div>\n      </details>`
    )
    .replace(
      `.hidden { display:none !important; }`,
      `.revenue-trend-chart { padding:14px 18px 12px;min-height:300px;overflow-x:auto; }\n    .revenue-settlements { overflow:hidden; }\n    .revenue-settlements-summary { list-style:none;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 18px;cursor:pointer; }\n    .revenue-settlements-summary::-webkit-details-marker { display:none; }\n    .revenue-settlements-summary strong { display:block;font-size:15px;color:var(--text); }\n    .revenue-settlements-summary small { display:block;color:var(--muted);font-size:11px;margin-top:4px;font-weight:400; }\n    .revenue-settlements-action { color:var(--muted);font-size:12px;white-space:nowrap; }\n    .revenue-settlements-action b { display:inline-block;margin-left:5px;transition:transform .15s ease; }\n    .revenue-settlements[open] .revenue-settlements-action b { transform:rotate(180deg); }\n    .revenue-settlements[open] .revenue-settlements-summary { border-bottom:1px solid var(--line); }\n    .hidden { display:none !important; }`
    );

  // Replace the original History functions before inserting Revenue helpers. This avoids
  // later regex passes accidentally matching helper code that we insert ourselves.
  output = output.replace(
    /  function historyMetricSet\(summary,isAllTime\)\{[\s\S]*?\n  \}\n  function monthlyAppleCell/,
    `  function historyMetricSet(summary,isAllTime){\n    return [\n      metric('Gross sales',historyMoneyBag(summary.grossSales),'Verified customer billings'),\n      metric('Apple proceeds est.',appleMoney(summary.appleEstimatedProceeds),'Expected proceeds after Apple commission and tax'),\n      metric('Apple fees + tax est.',appleMoney(summary.appleEstimatedDeductions),'Apple gross minus estimated proceeds'),\n      metric('Refunds',historyMoneyBag(summary.refunds),'Refunded customer charges')\n    ].join('');\n  }\n  function monthlyAppleCell`
  );

  output = output.replace(
    /  function historyTableHtml\(months,currentMonth\)\{[\s\S]*?\n  \}\n  function financialPeriodsHtml/,
    `  function historyTableHtml(months,currentMonth){\n    if(!months?.length)return '<div class="empty">No financial history yet.</div>';\n    const rows=[...months].sort((a,b)=>String(b.month).localeCompare(String(a.month)));\n    return '<table><thead><tr><th>Month</th><th>Gross sales</th><th>Apple proceeds est.</th><th>Fees + tax est.</th><th>Refunds</th><th>Final proceeds</th></tr></thead><tbody>'+rows.map(r=>{\n      const current=r.month===currentMonth;\n      return '<tr><td><span class="history-month">'+esc(historyMonthLabel(r.month))+'</span>'+(current?' <span class="history-current">Current</span>':'')+'</td><td>'+esc(historyMoneyBag(r.grossSales))+'</td><td>'+monthlyAppleCell(r,'appleEstimatedProceeds','history-proceeds')+'</td><td>'+monthlyAppleCell(r,'appleEstimatedDeductions','history-deduction')+'</td><td>'+esc(historyMoneyBag(r.refunds||{}))+'</td><td>'+monthlyFinalProceedsCell(r.month)+'</td></tr>';\n    }).join('')+'</tbody></table>';\n  }\n  function financialPeriodsHtml`
  );

  output = output.replace(
    /  function updateAppleHistoryStatus\(summary\)\{[\s\S]*?\n  \}\n  function renderHistoryPeriod/,
    `  function updateAppleHistoryStatus(summary){\n    const status=qs('#historyAppleStatus'); if(!status)return;\n    if(!appleReportsConnected()){ status.textContent='Apple Sales & Trends has not been imported yet.'; return; }\n    const through=summary?.appleReportImportedThrough||historyData?.reporting?.salesAndTrends?.importedThrough;\n    status.textContent=through?'Apple Sales & Trends imported through '+formatDateOnly(through)+'.':'Apple Sales & Trends connected.';\n  }\n  function renderHistoryPeriod`
  );

  output = output.replace(
    `  function historyTableHtml(months,currentMonth){`,
    `  function historyPrimaryAmount(bag){\n    const entries=Object.entries(bag||{}).filter(([,amount])=>Number.isFinite(Number(amount)));\n    if(Object.prototype.hasOwnProperty.call(bag||{},'USD'))return Number(bag.USD||0);\n    if(entries.length===1)return Number(entries[0][1]||0);\n    return entries.length===0?0:null;\n  }\n  function historyMonthShortLabel(key){\n    const parts=String(key||'').split('-').map(Number);\n    if(parts.length!==2||!parts[0]||!parts[1])return String(key||'');\n    return new Date(Date.UTC(parts[0],parts[1]-1,1)).toLocaleDateString(undefined,{month:'short',year:'2-digit',timeZone:'UTC'});\n  }\n  function finalProceedsForMonth(month){\n    const period=(historyData?.financialPeriods||[]).find(item=>String(item.reportDate||'').slice(0,7)===String(month||''));\n    return period?.finalProceeds||null;\n  }\n  function monthlyFinalProceedsCell(month){\n    const bag=finalProceedsForMonth(month);\n    if(!bag)return '<span class="history-pending">Pending</span>';\n    return '<span class="history-proceeds">'+esc(historyMoneyBag(bag))+'</span>';\n  }\n  function revenueTrendRows(){\n    if(!historyData)return [];\n    return [...(historyData.months||[])].sort((a,b)=>String(a.month).localeCompare(String(b.month))).map(row=>{\n      const gross=historyPrimaryAmount(row.grossSales||{});\n      return {month:row.month,gross:Number.isFinite(gross)?gross:null};\n    }).filter(row=>row.month&&row.gross!=null);\n  }\n  function renderRevenueTrend(selected='all'){\n    const el=qs('#revenueTrendChart'), summary=qs('#revenueTrendSummary');\n    if(!el||!summary||!historyData)return;\n    const rows=revenueTrendRows();\n    if(!rows.length){ el.innerHTML='<div class="empty">No gross sales history yet.</div>'; summary.textContent='Gross sales · USD'; return; }\n    const selectedMonth=selected==='all'?(historyData.currentMonth||rows[rows.length-1]?.month):selected;\n    const values=rows.map(row=>row.gross).filter(value=>value!=null&&Number.isFinite(value));\n    const width=900,height=270,left=62,right=24,top=28,bottom=48;\n    const plotWidth=width-left-right,plotHeight=height-top-bottom;\n    const maxValue=Math.max(1,...values);\n    const xAt=index=>rows.length===1?left+plotWidth/2:left+(index/(rows.length-1))*plotWidth;\n    const yAt=value=>top+plotHeight-(Number(value||0)/maxValue)*plotHeight;\n    const grossPoints=rows.map((row,index)=>xAt(index).toFixed(1)+','+yAt(row.gross).toFixed(1)).join(' ');\n    const grid=[0,.25,.5,.75,1].map(fraction=>{ const value=maxValue*fraction; const y=yAt(value); return '<line x1="'+left+'" y1="'+y.toFixed(1)+'" x2="'+(width-right)+'" y2="'+y.toFixed(1)+'" stroke="#242832" stroke-width="1"/><text x="'+(left-10)+'" y="'+(y+4).toFixed(1)+'" fill="#737b89" font-size="11" text-anchor="end">&#36;'+esc(value<10?value.toFixed(2):Math.round(value))+'</text>'; }).join('');\n    const grossDots=rows.map((row,index)=>{ const x=xAt(index),y=yAt(row.gross),active=row.month===selectedMonth; return '<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="'+(active?6:4)+'" fill="#d4b566" stroke="#0d0f13" stroke-width="2"><title>'+esc(historyMonthLabel(row.month)+': '+money(row.gross,'USD')+' gross sales')+'</title></circle>'; }).join('');\n    const labels=rows.map((row,index)=>'<text x="'+xAt(index).toFixed(1)+'" y="'+(height-17)+'" fill="'+(row.month===selectedMonth?'#f3f1eb':'#737b89')+'" font-size="11" text-anchor="middle">'+esc(historyMonthShortLabel(row.month))+'</text>').join('');\n    el.innerHTML='<svg role="img" aria-label="Gross sales by month" viewBox="0 0 '+width+' '+height+'" style="display:block;width:100%;min-width:680px;height:auto">'+grid+'<polyline points="'+grossPoints+'" fill="none" stroke="#d4b566" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'+grossDots+labels+'</svg>';\n    const latest=rows[rows.length-1], previous=rows.length>1?rows[rows.length-2]:null;\n    if(previous&&latest.gross!=null&&previous.gross!=null){ const delta=latest.gross-previous.gross; summary.textContent=(delta===0?'No gross-sales change':((delta>0?'+':'')+money(delta,'USD')))+' vs '+historyMonthShortLabel(previous.month); }\n    else summary.textContent='Gross sales · USD';\n  }\n  function historyTableHtml(months,currentMonth){`
  );

  output = output
    .replace(
      `    metrics.innerHTML=historyMetricSet(summary,selected==='all');\n    updateAppleHistoryStatus(summary);`,
      `    metrics.innerHTML=historyMetricSet(summary,selected==='all');\n    renderRevenueTrend(selected);\n    updateAppleHistoryStatus(summary);`
    )
    .replace(
      `    const metrics=qs('#historyMetrics'), table=qs('#historyTable'), finance=qs('#financialHistoryTable');\n    metrics.innerHTML='<div class="loading">Loading history...</div>'; table.innerHTML='<div class="loading">Loading monthly history...</div>'; finance.innerHTML='<div class="loading">Loading financial reports...</div>';`,
      `    const metrics=qs('#historyMetrics'), chart=qs('#revenueTrendChart'), table=qs('#historyTable'), finance=qs('#financialHistoryTable');\n    metrics.innerHTML='<div class="loading">Loading revenue...</div>'; chart.innerHTML='<div class="loading">Loading gross sales trend...</div>'; table.innerHTML='<div class="loading">Loading monthly financial history...</div>'; finance.innerHTML='<div class="loading">Loading financial reports...</div>';`
    )
    .replace(
      `    }catch(e){ showError(metrics,e); showError(table,e); showError(finance,e); }`,
      `    }catch(e){ showError(metrics,e); showError(chart,e); showError(table,e); showError(finance,e); }`
    );

  return output;
}

export default enhanceSubscriptionAdminRevenueHtml;
