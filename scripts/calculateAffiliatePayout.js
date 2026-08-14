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
Preview or finalize an affiliate calendar-month payout.

Required:
  --affiliate MAXAGORA|affiliate-uuid
  --period YYYY-MM-01

Optional:
  --finalize          Makes the month Ready to Pay using Apple custom-code Analytics data currently available.
  --reconciled        Marks the imported Apple Analytics internally reconciled. This does not make privacy-adjusted Analytics counts transaction-exact.

Example:
  npm run affiliate:payout -- --affiliate MAXAGORA --period 2026-09-01 --finalize
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.affiliate || !args.period) {
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

    let affiliateId = String(args.affiliate);
    if (!/^[0-9a-f-]{36}$/i.test(affiliateId)) {
      const affiliate = await service.findAffiliateByCode(affiliateId);
      if (!affiliate) throw new Error(`Affiliate ${affiliateId} not found.`);
      affiliateId = affiliate.id;
    }

    const result = await service.refreshMonthlyPayout({
      affiliateId,
      payoutPeriod: args.period,
      finalize: Boolean(args.finalize),
      markReconciled: Boolean(args.reconciled),
      actor: 'affiliate_payout_cli',
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[affiliate:payout]', error?.message || error);
  process.exitCode = 1;
});
