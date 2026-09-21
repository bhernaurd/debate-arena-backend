// Railway cron entry point. Run each report in its own process so every
// database/API handle is isolated and a stuck report cannot keep the cron
// container alive indefinitely.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const timeoutMs = Number(process.env.DAILY_ANALYTICS_REPORT_TIMEOUT_MS || 120_000);

const reports = [
  'dailyAnalyticsReportV2.js',
  'dailyClaudeCostReport.js',
  'dailyPaywallReport.js',
];

function runReport(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(scriptsDir, script)], {
      env: process.env,
      stdio: 'inherit',
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`[dailyAnalyticsReport] ${script} exceeded ${timeoutMs}ms; terminating it.`);
      child.kill('SIGTERM');

      const forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      forceKill.unref();
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timeout);
      console.error(`[dailyAnalyticsReport] Failed to start ${script}:`, error);
      resolve(false);
    });

    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut) {
        console.log(`[dailyAnalyticsReport] ${script} completed successfully.`);
        resolve(true);
        return;
      }

      console.error(
        `[dailyAnalyticsReport] ${script} failed${timedOut ? ' after timeout' : ''} (code=${code}, signal=${signal}).`,
      );
      resolve(false);
    });
  });
}

let allSucceeded = true;
for (const report of reports) {
  const succeeded = await runReport(report);
  if (!succeeded) allSucceeded = false;
}

if (!allSucceeded) {
  console.error('[dailyAnalyticsReport] One or more report jobs failed.');
  process.exit(1);
}

console.log('[dailyAnalyticsReport] All report jobs completed. Exiting cleanly.');
process.exit(0);
