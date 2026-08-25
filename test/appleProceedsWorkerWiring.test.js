import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('production entrypoint starts Apple proceeds worker', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const start = fs.readFileSync('start.js', 'utf8');
  const worker = fs.readFileSync('appleProceedsSyncWorker.js', 'utf8');

  assert.equal(pkg.scripts.start, 'node start.js');
  assert.match(start, /import '\.\/env\.js'/);
  assert.match(start, /import '\.\/appleProceedsSyncWorker\.js'/);
  assert.match(start, /import '\.\/server\.js'/);
  assert.match(worker, /APP_STORE_CONNECT_REPORTS_ENABLED', true/);
  assert.match(worker, /recordNoReportChecks/);
  assert.match(worker, /MAX\(report_date\) AS imported_through/);
  assert.match(worker, /Math\.min\(365, gapDays\)/);
});
