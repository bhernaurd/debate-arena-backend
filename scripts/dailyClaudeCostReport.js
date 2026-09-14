import '../env.js';
import pg from 'pg';
import { reconcileAnthropicCostForUtcDay } from '../lib/anthropicCostReconciliation.js';
import { sendTelegramMessage } from './analyticsReportV2Shared.js';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

function yesterdayUtcDateString(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86_400_000)
    .toISOString().slice(0, 10);
}

function dateLabel(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function signedMoney(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? '+' : '-'}$${Math.abs(number).toFixed(2)}`;
}

function signedPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  return `${number >= 0 ? '+' : ''}${number.toFixed(1)}%`;
}

function statusIcon(reconciliation) {
  if (!reconciliation.localTrackingComplete) return '⏳';
  const absoluteDifference = Math.abs(Number(reconciliation.differenceUsd || 0));
  const absolutePercent = Math.abs(Number(reconciliation.differencePercent || 0));
  return absoluteDifference >= 0.05 && absolutePercent >= 5 ? '⚠️' : '✅';
}

async function main() {
  const reportDate = yesterdayUtcDateString();
  try {
    const reconciliation = await reconcileAnthropicCostForUtcDay(pool, reportDate);
    const lines = [
      `🤖 <b>CLAUDE API — ${dateLabel(reportDate)} UTC</b>`,
      ``,
      `${reconciliation.localCallCount} calls`,
      `Estimated app cost: ${money(reconciliation.localEstimatedCostUsd)}${reconciliation.localTrackingComplete ? '' : ' (partial tracking)'}`,
      `Anthropic reported cost: ${money(reconciliation.anthropicReportedCostUsd)}`,
      `Difference: ${signedMoney(reconciliation.differenceUsd)} (${signedPercent(reconciliation.differencePercent)}) ${statusIcon(reconciliation)}`,
    ];

    if (!reconciliation.appApiKeyMatched) {
      lines.push(`⚠️ App API key could not be matched in Anthropic Admin data.`);
    } else if (!reconciliation.tokenUsageMatches && reconciliation.localTrackingComplete) {
      lines.push(`⚠️ Anthropic token usage does not match the app's Postgres logs.`);
    }

    if (reconciliation.isDefaultWorkspace && reconciliation.localTrackingComplete && Math.abs(Number(reconciliation.differenceUsd || 0)) >= 0.05) {
      lines.push(`Note: Anthropic's Default Workspace total can include Console or other API-key usage.`);
    }

    await sendTelegramMessage(lines.join('\n'));
    console.log('[dailyClaudeCostReport] Sent:', reconciliation);
  } catch (error) {
    console.error('[dailyClaudeCostReport] Failed:', error?.message || error);
    try {
      await sendTelegramMessage(`🤖 <b>CLAUDE API</b>\n\n⚠️ Cost reconciliation failed: ${String(error?.message || error).slice(0, 300)}`);
    } catch {}
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
