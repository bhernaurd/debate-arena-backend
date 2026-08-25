import fs from 'node:fs';

function replaceOrThrow(text, search, replacement, label) {
  if (!text.includes(search)) {
    throw new Error(`Patch target not found: ${label}`);
  }
  return text.replace(search, replacement);
}

const packagePath = 'package.json';
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
packageJson.scripts.start = 'node start.js';
packageJson.scripts.dev = 'node --watch start.js';
if (!packageJson.scripts.check.includes('node --check start.js')) {
  packageJson.scripts.check = packageJson.scripts.check.replace(
    'node --check server.js',
    'node --check start.js && node --check server.js'
  );
}
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

fs.writeFileSync(
  'start.js',
  `// Production entrypoint. Load environment first, then background workers, then HTTP server.\nimport './env.js';\nimport './appleProceedsSyncWorker.js';\nimport './server.js';\n`
);

const workerPath = 'appleProceedsSyncWorker.js';
let worker = fs.readFileSync(workerPath, 'utf8');
worker = replaceOrThrow(
  worker,
  "const enabled = booleanEnvironment('APP_STORE_CONNECT_REPORTS_ENABLED', false);",
  "const enabled = booleanEnvironment('APP_STORE_CONNECT_REPORTS_ENABLED', true);",
  'Apple reports default enabled'
);

worker = replaceOrThrow(
  worker,
  `function monthKey(date) {\n  return date.toISOString().slice(0, 7);\n}\n\nfunction addMonths(date, amount) {`,
  `function dateKey(date) {\n  const value = date instanceof Date ? date : new Date(date);\n  if (Number.isNaN(value.getTime())) return null;\n  return value.toISOString().slice(0, 10);\n}\n\nfunction addDays(date, amount) {\n  const value = date instanceof Date ? new Date(date.getTime()) : new Date(date);\n  value.setUTCDate(value.getUTCDate() + amount);\n  return value;\n}\n\nfunction monthKey(date) {\n  return date.toISOString().slice(0, 7);\n}\n\nfunction addMonths(date, amount) {`,
  'date helpers'
);

const salesBlock = /    async function runSalesSync\(reason = 'scheduled'\) \{[\s\S]*?\n    \}\n\n    async function runFinanceSync/;
if (!salesBlock.test(worker)) {
  throw new Error('Patch target not found: runSalesSync block');
}
worker = worker.replace(
  salesBlock,
  `    async function startupSalesLookbackDays(reason) {\n      if (reason !== 'startup') return 7;\n\n      try {\n        const result = await pool.query(\`\n          SELECT MAX(report_date) AS imported_through\n          FROM app_store_sales_report_imports\n          WHERE report_type = 'SALES'\n            AND report_subtype = 'SUMMARY'\n            AND frequency = 'DAILY'\n        \`);\n        const lastKey = dateKey(result.rows[0]?.imported_through);\n        if (!lastKey) return 90;\n\n        const last = new Date(\`\${lastKey}T00:00:00Z\`);\n        const through = addDays(new Date(), -1);\n        const gapDays = Math.floor((through.getTime() - last.getTime()) / 86_400_000) + 1;\n        return Math.max(7, Math.min(365, gapDays));\n      } catch (error) {\n        console.warn('[AppleProceedsWorker] Could not determine Sales & Trends catch-up window.', error?.message || error);\n        return 90;\n      }\n    }\n\n    async function recordNoReportChecks(results) {\n      const noReports = (results || []).filter((row) => row.status === 'not_available' && row.reportDate);\n      for (const row of noReports) {\n        await pool.query(\`\n          INSERT INTO app_store_sales_report_imports (\n            report_date, vendor_number, report_type, report_subtype, frequency,\n            source_sha256, row_count, imported_at\n          )\n          VALUES ($1,$2,'SALES','SUMMARY','DAILY',NULL,0,NOW())\n          ON CONFLICT (report_date, vendor_number, report_type, report_subtype, frequency)\n          DO UPDATE SET source_sha256 = NULL, row_count = 0, imported_at = NOW()\n        \`, [row.reportDate, reportsService.vendorNumber]);\n      }\n    }\n\n    async function runSalesSync(reason = 'scheduled') {\n      if (running) {\n        console.log('[AppleProceedsWorker] Skipping overlapping sales sync.');\n        return;\n      }\n      running = true;\n      try {\n        const days = await startupSalesLookbackDays(reason);\n        const results = await service.syncRecentSales({ days });\n        await recordNoReportChecks(results);\n        const imported = results.filter((row) => row.status === 'imported');\n        console.log('[AppleProceedsWorker] Sales reports synced.', {\n          reason,\n          checkedDays: results.length,\n          lookbackDays: days,\n          reportDays: imported.length,\n          importedRows: imported.reduce((sum, row) => sum + Number(row.importedRows || 0), 0),\n        });\n      } catch (error) {\n        console.error('[AppleProceedsWorker] Sales sync failed:', error?.message || error);\n      } finally {\n        running = false;\n      }\n    }\n\n    async function runFinanceSync`
);
fs.writeFileSync(workerPath, worker);

const revenuePath = 'lib/subscriptionAdminRevenueUi.js';
let revenue = fs.readFileSync(revenuePath, 'utf8');
revenue = replaceOrThrow(
  revenue,
  "const sales=salesThrough?formatDateOnly(salesThrough):'Not imported';",
  "const salesDate=salesThrough?new Date(String(salesThrough).slice(0,10)+'T00:00:00Z'):null;\\n    const salesAgeDays=salesDate&&!Number.isNaN(salesDate.getTime())?Math.floor((Date.now()-salesDate.getTime())/86400000):null;\\n    const sales=salesThrough?(salesAgeDays!=null&&salesAgeDays>3?'Delayed · last checked '+formatDateOnly(salesThrough):'Current · through '+formatDateOnly(salesThrough)):'Not imported';",
  'freshness status logic'
);
revenue = replaceOrThrow(
  revenue,
  'Apple sales:</b>',
  'Apple reporting:</b>',
  'freshness label'
);
fs.writeFileSync(revenuePath, revenue);

const revenueTestPath = 'test/subscriptionAdminRevenueUi.test.js';
let revenueTest = fs.readFileSync(revenueTestPath, 'utf8');
revenueTest = replaceOrThrow(
  revenueTest,
  `  assert.match(html, /Apple sales:<\\/b>/);`,
  `  assert.match(html, /Apple reporting:<\\/b>/);\n  assert.match(html, /Delayed · last checked/);\n  assert.match(html, /Current · through/);`,
  'freshness test wording'
);
fs.writeFileSync(revenueTestPath, revenueTest);

fs.writeFileSync(
  'test/appleProceedsWorkerWiring.test.js',
  `import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport test from 'node:test';\n\ntest('production entrypoint starts Apple proceeds worker', () => {\n  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));\n  const start = fs.readFileSync('start.js', 'utf8');\n  const worker = fs.readFileSync('appleProceedsSyncWorker.js', 'utf8');\n\n  assert.equal(pkg.scripts.start, 'node start.js');\n  assert.match(start, /import '\\.\\/env\\.js'/);\n  assert.match(start, /import '\\.\\/appleProceedsSyncWorker\\.js'/);\n  assert.match(start, /import '\\.\\/server\\.js'/);\n  assert.match(worker, /APP_STORE_CONNECT_REPORTS_ENABLED', true/);\n  assert.match(worker, /recordNoReportChecks/);\n  assert.match(worker, /MAX\\(report_date\\) AS imported_through/);\n  assert.match(worker, /Math\\.min\\(365, gapDays\\)/);\n});\n`
);

console.log('Apple reporting runtime patch applied.');
