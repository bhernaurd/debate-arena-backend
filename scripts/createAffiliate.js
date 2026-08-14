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

function readPresenceFlag(args, key) {
  if (args[key] == null) return false;
  if (args[key] === true) return true;

  throw new Error(
    `--${key} is a presence-only flag. Use --${key} with no value, or omit it.`
  );
}

function usage() {
  console.log(`
Create an affiliate for The Agora.

Required:
  --name "Max"
  --code MAXAGORA
  --since 2026-08-13
  --offer-reference MAXAGORA     App Store Connect offer reference name

Optional:
  --display-name "Max"
  --rate 0.5
  --basis base_price           50% of approved revenue/base-price basis
  --basis net_proceeds         50% of Apple-reported actual net proceeds
  --test

Example:
  npm run affiliate:create -- --name "Max" --code MAXAGORA --since 2026-08-13 --offer-reference MAXAGORA
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const isTest = readPresenceFlag(args, 'test');

  if (!args.name || !args.code || !args.since || (!isTest && !args['offer-reference'])) {
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
      appleOfferIdentifier: args['offer-reference'] || null,
      affiliateSince: args.since,
      commissionRate: args.rate || '0.5',
      commissionBasis: args.basis || 'base_price',
      isTest,
      codeStatus: 'active',
    }, 'createAffiliate_script');

    console.log('\nAffiliate created.\n');
    console.log(`Name: ${result.affiliate.display_name}`);
    console.log(`Code: ${result.affiliate.normalized_code}`);
    console.log(`Apple offer reference: ${result.affiliate.apple_offer_identifier || 'test-only / not configured'}`);
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
