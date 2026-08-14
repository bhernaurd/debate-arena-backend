import '../env.js';

import fs from 'fs';
import path from 'path';
import pg from 'pg';

import {
  decodeAppleAnalyticsBuffer,
  normalizeAppleSubscriptionEventRows,
  normalizeAppleSubscriptionStateRows,
} from '../lib/appleAffiliateAnalyticsParser.js';
import { createAffiliateProgramService } from '../lib/affiliateProgramService.js';

const { Pool } = pg;

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      result[key] = true;
    } else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}

function usage() {
  console.log(`
Import a Standard App Store Subscription State/Event Analytics report.

Required:
  --type state|event
  exactly one of:
    --file /path/to/apple-report.txt.gz
    --dir  /path/to/all-segments-for-one-instance

For --dir downloads created by affiliate:apple-probe, manifest.json is read
and its processingDate/requestId/instanceId/reportName are used automatically.

Required for a production single-file import without a probe manifest:
  --processing-date YYYY-MM-DD            Apple Analytics instance processingDate

Optional:
  --environment production|sandbox|test   (default: production)
  --report-name "App Store Subscription Event - Standard"
  --request-id ID
  --instance-id ID
  --segment-id ID
  --complete-instance                     Only with --dir + probe manifest; confirms all manifest segments are present and treats them as the complete instance

Example single report segment:
  npm run affiliate:apple-import -- --type event --file ./subscription-event.txt.gz --processing-date 2026-09-01

Preferred complete instance downloaded by affiliate:apple-probe:
  npm run affiliate:apple-import -- --type event --dir ./tmp/apple-affiliate-analytics-probe/<report>/<instance> --complete-instance
`);
}

function readProbeManifest(directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid Apple probe manifest at ${manifestPath}: ${error?.message || error}`);
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid Apple probe manifest at ${manifestPath}.`);
  }

  return { manifest, manifestPath };
}

function reportInputFromArgs(args) {
  const hasFile = typeof args.file === 'string' && args.file.trim();
  const hasDir = typeof args.dir === 'string' && args.dir.trim();
  if (Boolean(hasFile) === Boolean(hasDir)) {
    throw new Error('Provide exactly one of --file or --dir.');
  }

  if (hasFile) {
    return {
      files: [path.resolve(args.file)],
      directory: null,
      manifest: null,
      manifestPath: null,
    };
  }

  const directory = path.resolve(args.dir);
  const probeManifest = readProbeManifest(directory);
  const manifest = probeManifest?.manifest || null;
  let files;

  if (Array.isArray(manifest?.files) && manifest.files.length) {
    const seen = new Set();
    files = manifest.files.map((name) => {
      const base = path.basename(String(name || ''));
      if (!base || base !== String(name)) {
        throw new Error(`Unsafe or invalid file entry in ${probeManifest.manifestPath}: ${name}`);
      }
      if (seen.has(base)) {
        throw new Error(`Duplicate segment file in ${probeManifest.manifestPath}: ${base}`);
      }
      seen.add(base);
      const fullPath = path.join(directory, base);
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        throw new Error(`Manifest segment is missing: ${fullPath}`);
      }
      if (!/\.(txt|tsv|gz)$/i.test(base)) {
        throw new Error(`Manifest segment has an unsupported extension: ${base}`);
      }
      return fullPath;
    });
  } else {
    files = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== 'manifest.json' && /\.(txt|tsv|gz)$/i.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  }

  if (!files.length) throw new Error(`No .txt, .tsv, or .gz report segments found in ${directory}.`);

  return {
    files,
    directory,
    manifest,
    manifestPath: probeManifest?.manifestPath || null,
  };
}

function manifestValue(manifest, key) {
  const value = manifest?.[key];
  return value == null || String(value).trim() === '' ? null : String(value).trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.type || (!args.file && !args.dir)) {
    usage();
    process.exitCode = 1;
    return;
  }

  const type = String(args.type).trim().toLowerCase();
  if (!['state', 'event'].includes(type)) {
    throw new Error('--type must be state or event.');
  }

  const environment = String(args.environment || 'production').trim().toLowerCase();
  if (!['production', 'sandbox', 'test'].includes(environment)) {
    throw new Error('--environment must be production, sandbox, or test.');
  }

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

  if (args['complete-instance'] && !args.dir) {
    throw new Error('--complete-instance is intentionally allowed only with --dir so a single Apple segment cannot erase rows from other segments.');
  }

  const input = reportInputFromArgs(args);
  if (args['complete-instance'] && !input.manifest) {
    throw new Error('--complete-instance requires the manifest.json written by affiliate:apple-probe so the importer can prove every downloaded segment is present.');
  }

  if (args['complete-instance']) {
    const segmentIds = Array.isArray(input.manifest?.segmentIds) ? input.manifest.segmentIds : [];
    const manifestFiles = Array.isArray(input.manifest?.files) ? input.manifest.files : [];
    if (!manifestFiles.length || (segmentIds.length && segmentIds.length !== manifestFiles.length)) {
      throw new Error(`Probe manifest is incomplete and cannot be used with --complete-instance: ${input.manifestPath}`);
    }
  }

  const processingDate = String(
    args['processing-date'] || manifestValue(input.manifest, 'processingDate') || ''
  ).trim();
  if (environment === 'production' && !/^\d{4}-\d{2}-\d{2}$/.test(processingDate)) {
    throw new Error('--processing-date YYYY-MM-DD is required for production Apple Analytics imports unless it is available in the probe manifest.');
  }

  const reportName = String(
    args['report-name'] ||
    manifestValue(input.manifest, 'reportName') ||
    `App Store Subscription ${type === 'state' ? 'State' : 'Event'} - Standard`
  ).trim();

  const expectedWord = type === 'state' ? 'state' : 'event';
  if (input.manifest && !reportName.toLowerCase().includes(expectedWord)) {
    throw new Error(`The probe manifest report name does not appear to match --type ${type}: ${reportName}`);
  }

  const rows = input.files.flatMap((file) => {
    const raw = fs.readFileSync(file);
    const text = decodeAppleAnalyticsBuffer(raw);
    return type === 'state'
      ? normalizeAppleSubscriptionStateRows(text, { environment })
      : normalizeAppleSubscriptionEventRows(text, { environment });
  });

  if (!rows.length) {
    console.log('No affiliate Vanity Code rows were found in this report instance. Nothing imported.');
    return;
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

    const result = await service.importNormalizedAppleMetrics({
      rows,
      source: {
        type: type === 'state' ? 'analytics_state' : 'analytics_event',
        environment,
        reportName,
        requestId: args['request-id'] || manifestValue(input.manifest, 'requestId'),
        instanceId: args['instance-id'] || manifestValue(input.manifest, 'instanceId'),
        segmentId: args['segment-id'] || (args.dir ? `combined:${input.files.length}` : null),
        processingDate: processingDate || null,
        completeInstance: Boolean(args['complete-instance']),
      },
      actor: 'affiliate_apple_report_import_cli',
    });

    console.log(JSON.stringify({
      ...result,
      filesImported: input.files.length,
      manifestUsed: Boolean(input.manifest),
      processingDate: processingDate || null,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[affiliate:apple-import]', error?.message || error);
  process.exitCode = 1;
});
