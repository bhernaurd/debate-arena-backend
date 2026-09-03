import fs from 'node:fs';

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) {
    throw new Error(`Could not find ${label}`);
  }
  return text.replace(from, to);
}

{
  const path = 'subscriptionAdminRoutes.js';
  let text = fs.readFileSync(path, 'utf8');

  text = replaceOnce(
    text,
    "    'active_trials',\n    'active_lifetime_pro',",
    "    'active_trials',\n    'trials_ending',\n    'active_lifetime_pro',",
    'trials_ending normalization slot'
  );

  text = replaceOnce(
    text,
    '      const [metricsResult, sourceResult, statusResult, recentResult] =\n        await Promise.all([\n          pool.query(\'SELECT * FROM subscription_admin_business_metrics_v1\'),',
    `      const [\n        metricsResult,\n        trialsEndingResult,\n        sourceResult,\n        statusResult,\n        recentResult,\n      ] = await Promise.all([\n          pool.query('SELECT * FROM subscription_admin_business_metrics_v1'),\n          pool.query(\`\n            SELECT COUNT(*)::int AS trials_ending\n            FROM subscription_admin_current_customers_v1\n            WHERE environment = 'Production'\n              AND trial_active\n              AND auto_renew_enabled = FALSE\n          \`),`,
    'overview promise list'
  );

  text = replaceOnce(
    text,
    '        metrics: normalizeMetrics(metricsResult.rows[0] || {}),',
    `        metrics: normalizeMetrics({\n          ...(metricsResult.rows[0] || {}),\n          trials_ending: trialsEndingResult.rows[0]?.trials_ending || 0,\n        }),`,
    'overview metrics response'
  );

  fs.writeFileSync(path, text);
}

{
  const path = 'lib/subscriptionAdminOverviewUi.js';
  let text = fs.readFileSync(path, 'utf8');

  text = replaceOnce(
    text,
    "        metric('Free period',m.active_trials||0,'Active free-trial subscribers'),\\n        metric('Monthly',m.paid_monthly||0,'Active paid monthly subscribers'),",
    "        metric('Free period',m.active_trials||0,'Active free-trial subscribers'),\\n        metric('Trials ending',m.trials_ending||0,'Free trials with auto-renew off'),\\n        metric('Monthly',m.paid_monthly||0,'Active paid monthly subscribers'),",
    'current subscriber metrics'
  );

  fs.writeFileSync(path, text);
}

{
  const path = 'lib/subscriptionAdminLifetimeUi.js';
  let text = fs.readFileSync(path, 'utf8');

  text = replaceOnce(
    text,
    "if(key.includes('cancel'))return 'tone-warning'; if(key.includes('free trial')",
    "if(key.includes('cancel')||key.includes('trials ending'))return 'tone-warning'; if(key.includes('free trial')",
    'metric tone rule'
  );

  fs.writeFileSync(path, text);
}

{
  const path = 'test/subscriptionAdminTrialsEnding.test.js';
  fs.writeFileSync(path, `import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport test from 'node:test';\n\ntest('overview derives Trials ending from active trials with auto-renew disabled', () => {\n  const source = fs.readFileSync(new URL('../subscriptionAdminRoutes.js', import.meta.url), 'utf8');\n  assert.match(source, /trials_ending/);\n  assert.match(source, /AND trial_active\\s+AND auto_renew_enabled = FALSE/);\n  assert.match(source, /trials_ending: trialsEndingResult\\.rows\\[0\\]\\?\\.trials_ending \\|\\| 0/);\n});\n\ntest('Subscriber Analytics shows Trials ending as a separate warning metric', () => {\n  const overviewUi = fs.readFileSync(new URL('../lib/subscriptionAdminOverviewUi.js', import.meta.url), 'utf8');\n  const lifetimeUi = fs.readFileSync(new URL('../lib/subscriptionAdminLifetimeUi.js', import.meta.url), 'utf8');\n  assert.match(overviewUi, /metric\\('Trials ending',m\\.trials_ending\\|\\|0,'Free trials with auto-renew off'\\)/);\n  assert.match(lifetimeUi, /key\\.includes\\('trials ending'\\)/);\n});\n`);
}

console.log('Trials ending metric patch applied.');
