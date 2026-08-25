import fs from 'node:fs';

function replaceOrThrow(text, search, replacement, label) {
  if (!text.includes(search)) throw new Error(`Patch target not found: ${label}`);
  return text.replace(search, replacement);
}

const uiPath = 'lib/subscriptionAdminRevenueUi.js';
let ui = fs.readFileSync(uiPath, 'utf8');

ui = replaceOrThrow(
  ui,
  `.replace(\n      '<div><h1 id="pageTitle">Overview</h1><div class="sub" id="pageSub">Production subscription health and revenue</div></div>',`,
  `.replace(\n      \"const appleProceedsHint=appleConnected?(h?.reporting?.salesAndTrends?.importedThrough?'Apple Sales & Trends · through '+formatDateOnly(h.reporting.salesAndTrends.importedThrough):'Apple Sales & Trends estimate'):'Add Vendor Number and import Apple reports';\",\n      \"const appleProceedsHint=appleConnected?'Apple Sales & Trends estimate':'Add Vendor Number and import Apple reports';\"\n    )\n    .replace(\n      '<div><h1 id="pageTitle">Overview</h1><div class="sub" id="pageSub">Production subscription health and revenue</div></div>',`,
  'Apple proceeds hint'
);

const oldFreshness = `    const salesThrough=h?.reporting?.salesAndTrends?.importedThrough||null;\\n    const finance=[...(h?.financialPeriods||[])].sort((a,b)=>String(a.periodEnd||a.reportDate||'').localeCompare(String(b.periodEnd||b.reportDate||''))).at(-1)||null;\\n    const salesDate=salesThrough?new Date(String(salesThrough).slice(0,10)+'T00:00:00Z'):null;\\n    const salesAgeDays=salesDate&&!Number.isNaN(salesDate.getTime())?Math.floor((Date.now()-salesDate.getTime())/86400000):null;\\n    const sales=salesThrough?(salesAgeDays!=null&&salesAgeDays>3?'Delayed · last checked '+formatDateOnly(salesThrough):'Current · through '+formatDateOnly(salesThrough)):'Not imported';\\n    const settlements=finance?.periodEnd?'through '+formatDateOnly(finance.periodEnd):(h?.reporting?.finance?.hasImportedReports?'Imported':'Pending');\\n    el.innerHTML='<span><b>Subscription data:</b> Live</span><span><b>Apple reporting:</b> '+esc(sales)+'</span><span><b>Financial settlements:</b> '+esc(settlements)+'</span>';`;

const newFreshness = `    const finance=[...(h?.financialPeriods||[])].sort((a,b)=>String(a.periodEnd||a.reportDate||'').localeCompare(String(b.periodEnd||b.reportDate||''))).at(-1)||null;\\n    const current=(h?.months||[]).find(row=>row.month===h?.currentMonth)||{};\\n    const live=current.grossSales||{}, apple=current.appleReportedGrossSales||{};\\n    const currencies=new Set([...Object.keys(live),...Object.keys(apple)]);\\n    let hasLive=false, reconciled=true;\\n    for(const currency of currencies){ const liveAmount=Number(live[currency]||0), appleAmount=Number(apple[currency]||0); if(Math.abs(liveAmount)>0.004)hasLive=true; if(Math.abs(liveAmount-appleAmount)>0.01)reconciled=false; }\\n    const connected=Boolean(h?.reporting?.salesAndTrends?.hasImportedReports);\\n    const sales=!connected?'Not imported':(!hasLive?'No current-month sales':(reconciled?'Reconciled':'Pending reconciliation'));\\n    const settlements=finance?.periodEnd?'through '+formatDateOnly(finance.periodEnd):(h?.reporting?.finance?.hasImportedReports?'Imported':'Pending');\\n    el.innerHTML='<span><b>Subscription data:</b> Live</span><span><b>Apple reporting:</b> '+esc(sales)+'</span><span><b>Financial settlements:</b> '+esc(settlements)+'</span>';`;

ui = replaceOrThrow(ui, oldFreshness, newFreshness, 'freshness reconciliation');

ui = ui.replace(
  `    const through=summary?.appleReportImportedThrough||historyData?.reporting?.salesAndTrends?.importedThrough;\\n    status.textContent=through?'Apple Sales & Trends imported through '+formatDateOnly(through)+'.':'Apple Sales & Trends connected.';`,
  `    status.textContent='Apple Sales & Trends connected. Revenue estimates use imported Apple sales data.';`
);

fs.writeFileSync(uiPath, ui);

const testPath = 'test/subscriptionAdminRevenueUi.test.js';
let test = fs.readFileSync(testPath, 'utf8');
test = test
  .replace(`  assert.match(html, /Delayed · last checked/);\n  assert.match(html, /Current · through/);`, `  assert.match(html, /Reconciled/);\n  assert.match(html, /Pending reconciliation/);\n  assert.doesNotMatch(html, /Delayed · last checked/);`)
  .replace(`  assert.match(html, /Financial settlements:<\\/b>/);`, `  assert.match(html, /Financial settlements:<\\/b>/);\n  assert.match(html, /const appleProceedsHint=appleConnected?'Apple Sales & Trends estimate'/);\n  assert.doesNotMatch(html, /appleProceedsHint=appleConnected\\?\\(h\\?\\.reporting\\?\\.salesAndTrends\\?\\.importedThrough/);`);
fs.writeFileSync(testPath, test);

console.log('Apple reporting reconciliation patch applied.');
