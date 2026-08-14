import '../env.js';

import pg from 'pg';

import {
  createAffiliateProgramService,
} from '../lib/affiliateProgramService.js';

const { Pool } = pg;

function parseArgs(argv) {
  const values = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    const next = argv[index + 1];

    if (next == null || next.startsWith('--')) {
      values[key] = true;
      continue;
    }

    values[key] = next;
    index += 1;
  }

  return values;
}

function usage() {
  console.log(`
Create an affiliate for The Agora.

Required:
  --name "Max"
  --code MAXAGORA
  --since 2026-08-13

Optional:
  --display-name "Max"
  --rate 0.5
  --basis base_price
  --test

Example:
  npm run affiliate:create -- --name "Max" --code MAXAGORA --since 2026-08-13
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.name || !args.code || !args.since) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  if (!process.env.AFFILIATE_APPLE_APP_ID) {
    throw new Error('AFFILIATE_APPLE_APP_ID is required.');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway')
      ? { rejectUnauthorized: false }
      : false,
  });

  try {
    const service = createAffiliateProgramService({
      pool,
      appAppleId: process.env.AFFILIATE_APPLE_APP_ID,
      tokenEncryptionKey: process.env.AFFILIATE_TOKEN_ENCRYPTION_KEY,
      partnerBaseUrl: process.env.AFFILIATE_PARTNER_BASE_URL,
      referralBaseUrl: process.env.AFFILIATE_REFERRAL_BASE_URL,
    });

    const result = await service.createAffiliate({
      internalName: args.name,
      displayName: args['display-name'] || args.name,
      customCode: args.code,
      affiliateSince: args.since,
      commissionRate: args.rate || '0.5',
      commissionBasis: args.basis || 'base_price',
      isTest: Boolean(args.test),
      codeStatus: 'active',
    }, 'createAffiliate_script');

    console.log('\nAffiliate created.\n');
    console.log(`Name: ${result.affiliate.display_name}`);
    console.log(`Code: ${result.affiliate.normalized_code}`);
    console.log(`Referral link: ${result.referralUrl}`);
    console.log(`Apple redemption: ${result.appleRedemptionUrl}`);
    console.log(`Private dashboard: ${result.dashboardUrl}`);
    console.log('\nSave the private dashboard link securely. It is shown here at creation time.\n');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[affiliate:create]', error?.message || error);
  process.exitCode = 1;
});
