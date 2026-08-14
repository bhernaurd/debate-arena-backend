import '../env.js';

import pg from 'pg';
import { createAffiliateProgramService } from '../lib/affiliateProgramService.js';

const { Pool } = pg;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith('--')) values[key] = true;
    else { values[key] = next; index += 1; }
  }
  return values;
}

function usage() {
  console.log(`
Finalize every eligible affiliate payout for one calendar month.

Required:
  --period YYYY-MM-01

Optional:
  --reconciled   Marks imported Apple Analytics internally reconciled after review; this does not make privacy-adjusted counts transaction-exact.
  --include-test Include affiliates explicitly marked as test affiliates.

Normal 1st-of-month example:
  npm run affiliate:payout-all -- --period 2026-09-01
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.period) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false,
  });

  try {
    const service = createAffiliateProgramService({
      pool,
      appAppleId: process.env.AFFILIATE_APPLE_APP_ID,
      tokenEncryptionKey: process.env.AFFILIATE_TOKEN_ENCRYPTION_KEY,
      partnerBaseUrl: process.env.AFFILIATE_PARTNER_BASE_URL,
      referralBaseUrl: process.env.AFFILIATE_REFERRAL_BASE_URL,
    });

    const result = await service.finalizeAffiliatePayoutsForPeriod({
      payoutPeriod: args.period,
      markReconciled: Boolean(args.reconciled),
      includeTest: Boolean(args['include-test']),
      actor: 'affiliate_payout_all_cli',
    });

    console.log(JSON.stringify(result, null, 2));
    if (result.failures.length) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[affiliate:payout-all]', error?.message || error);
  process.exitCode = 1;
});
