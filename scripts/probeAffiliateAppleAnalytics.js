import '../env.js';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const API_BASE = 'https://api.appstoreconnect.apple.com';
const REPORT_NAME_RE = /(subscription\s+(state|event)|offer)/i;

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

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readPrivateKey() {
  const inline = String(process.env.APP_STORE_CONNECT_PRIVATE_KEY || '').trim();
  if (inline) return inline.replace(/\\n/g, '\n');

  const keyPath = String(process.env.APP_STORE_CONNECT_PRIVATE_KEY_PATH || '').trim();
  if (keyPath) return fs.readFileSync(keyPath, 'utf8');

  throw new Error(
    'APP_STORE_CONNECT_PRIVATE_KEY or APP_STORE_CONNECT_PRIVATE_KEY_PATH is required.'
  );
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function createAppStoreConnectToken() {
  const issuerId = requiredEnv('APP_STORE_CONNECT_ISSUER_ID');
  const keyId = requiredEnv('APP_STORE_CONNECT_KEY_ID');
  const privateKey = readPrivateKey();
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: 'ES256',
    kid: keyId,
    typ: 'JWT',
  };

  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + 15 * 60,
    aud: 'appstoreconnect-v1',
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });

  return `${signingInput}.${signature.toString('base64url')}`;
}

async function ascRequest(token, pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const error = new Error(`App Store Connect API ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function fetchAll(token, firstPath) {
  let url = firstPath.startsWith('http') ? firstPath : `${API_BASE}${firstPath}`;
  const rows = [];

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    const body = await response.json();
    if (!response.ok) {
      const error = new Error(`App Store Connect API ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }

    if (Array.isArray(body.data)) rows.push(...body.data);
    url = body?.links?.next || null;
  }

  return rows;
}

async function resolveAppResourceId(token) {
  const explicit = String(process.env.AFFILIATE_ASC_APP_RESOURCE_ID || '').trim();
  if (explicit) return explicit;

  const bundleId = String(process.env.AFFILIATE_BUNDLE_ID || '').trim();
  if (!bundleId) {
    throw new Error(
      'Set AFFILIATE_ASC_APP_RESOURCE_ID or AFFILIATE_BUNDLE_ID so the probe can find The Agora in App Store Connect.'
    );
  }

  const body = await ascRequest(
    token,
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=2`
  );

  const apps = Array.isArray(body?.data) ? body.data : [];
  if (apps.length !== 1) {
    throw new Error(`Expected exactly one App Store Connect app for bundle ID ${bundleId}; found ${apps.length}.`);
  }

  return apps[0].id;
}

async function listReportRequests(token, appId) {
  return fetchAll(token, `/v1/apps/${encodeURIComponent(appId)}/analyticsReportRequests?limit=200`);
}

async function createOngoingReportRequest(token, appId) {
  return ascRequest(token, '/v1/analyticsReportRequests', {
    method: 'POST',
    body: {
      data: {
        type: 'analyticsReportRequests',
        attributes: {
          accessType: 'ONGOING',
        },
        relationships: {
          app: {
            data: {
              type: 'apps',
              id: appId,
            },
          },
        },
      },
    },
  });
}

async function listReports(token, requestId) {
  return fetchAll(
    token,
    `/v1/analyticsReportRequests/${encodeURIComponent(requestId)}/reports?limit=200`
  );
}

async function listInstances(token, reportId) {
  return fetchAll(token, `/v1/analyticsReports/${encodeURIComponent(reportId)}/instances?limit=200`);
}

async function listSegments(token, instanceId) {
  return fetchAll(token, `/v1/analyticsReportInstances/${encodeURIComponent(instanceId)}/segments?limit=200`);
}

function describeRequest(row) {
  return {
    id: row.id,
    accessType: row?.attributes?.accessType || null,
    stoppedDueToInactivity: row?.attributes?.stoppedDueToInactivity ?? null,
  };
}

function chooseRequest(rows) {
  const ongoing = rows.find((row) => row?.attributes?.accessType === 'ONGOING' && !row?.attributes?.stoppedDueToInactivity);
  return ongoing || rows[0] || null;
}

function reportName(report) {
  return String(report?.attributes?.name || report?.attributes?.category || report?.id || 'Unnamed report');
}

function instanceDate(instance) {
  return String(
    instance?.attributes?.processingDate ||
    instance?.attributes?.reportDate ||
    instance?.attributes?.startDate ||
    ''
  );
}

async function downloadAndInspectSegment(segment, outputDir) {
  const url = segment?.attributes?.url;
  if (!url) return null;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Apple segment download failed: ${response.status} ${response.statusText}`);
  }

  const raw = Buffer.from(await response.arrayBuffer());
  let content = raw;
  try {
    content = zlib.gunzipSync(raw);
  } catch {
    // Some URLs or future variants may already be plain text.
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const safeId = String(segment.id || 'segment').replace(/[^A-Za-z0-9._-]/g, '_');
  const outputPath = path.join(outputDir, `${safeId}.txt`);
  fs.writeFileSync(outputPath, content);

  const text = content.toString('utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const preview = lines.slice(0, 6);
  const header = lines[0] ? lines[0].split('\t') : [];

  return {
    outputPath,
    header,
    preview,
  };
}

function safePathPart(value, fallback = 'item') {
  const clean = String(value || fallback).replace(/[^A-Za-z0-9._-]/g, '_');
  return clean || fallback;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = createAppStoreConnectToken();
  const appId = await resolveAppResourceId(token);

  console.log(`App Store Connect app resource ID: ${appId}`);

  let requests = await listReportRequests(token, appId);
  console.log(`Analytics report requests found: ${requests.length}`);
  requests.forEach((row) => console.log(JSON.stringify(describeRequest(row))));

  if (!requests.length && args.create) {
    console.log('No report request exists. Creating an ONGOING request...');
    const created = await createOngoingReportRequest(token, appId);
    requests = created?.data ? [created.data] : [];
    console.log(`Created request: ${requests[0]?.id || 'unknown'}`);
    console.log('Apple normally needs time to generate the first analytics reports. Run this probe again after reports appear.');
    return;
  }

  if (!requests.length) {
    console.log('\nNo analytics report request exists yet.');
    console.log('Run again with --create to request ONGOING reports after confirming your App Store Connect API key has the required role.');
    return;
  }

  const request = chooseRequest(requests);
  console.log(`\nUsing report request: ${request.id}`);

  const reports = await listReports(token, request.id);
  const relevant = reports.filter((report) => REPORT_NAME_RE.test(reportName(report)));

  console.log(`Reports returned: ${reports.length}`);
  console.log(`Subscription/offer candidates: ${relevant.length}`);
  relevant.forEach((report) => console.log(`- ${report.id} :: ${reportName(report)}`));

  if (!args.download) {
    console.log('\nRun with --download to inspect the newest segment headers for subscription/offer reports.');
    return;
  }

  const outputDir = path.resolve(
    String(args['output-dir'] || './tmp/apple-affiliate-analytics-probe')
  );

  for (const report of relevant) {
    const instances = await listInstances(token, report.id);
    if (!instances.length) continue;

    const sorted = [...instances].sort((a, b) => instanceDate(b).localeCompare(instanceDate(a)));
    const newest = sorted[0];
    const segments = await listSegments(token, newest.id);
    if (!segments.length) continue;

    console.log(`\n${reportName(report)}`);
    console.log(`Newest instance: ${newest.id} ${instanceDate(newest)}`);
    console.log(`Segments: ${segments.length}`);

    const instanceDir = path.join(
      outputDir,
      safePathPart(report.id, 'report'),
      safePathPart(newest.id, 'instance')
    );
    const downloaded = [];
    for (const segment of segments) {
      const inspected = await downloadAndInspectSegment(segment, instanceDir);
      if (inspected) downloaded.push({ segment, inspected });
    }

    if (!downloaded.length) {
      console.log('Newest instance had no downloadable segment URLs.');
      continue;
    }

    const first = downloaded[0].inspected;
    const manifestPath = path.join(instanceDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      reportId: report.id,
      reportName: reportName(report),
      requestId: request.id,
      instanceId: newest.id,
      processingDate: instanceDate(newest),
      segmentIds: downloaded.map(({ segment }) => segment.id),
      files: downloaded.map(({ inspected }) => path.basename(inspected.outputPath)),
    }, null, 2));

    console.log(`Saved ${downloaded.length}/${segments.length} segment(s) under: ${instanceDir}`);
    console.log(`Manifest: ${manifestPath}`);
    console.log(`Columns (${first.header.length}): ${first.header.join(' | ')}`);
    console.log('First rows from first segment:');
    first.preview.forEach((line) => console.log(line));
    console.log('Import the complete instance by pointing affiliate:apple-import at this directory; do not mark a single segment complete.');
  }
}

main().catch((error) => {
  console.error('[affiliate:apple-probe]', error?.message || error);
  if (error?.body) {
    console.error(JSON.stringify(error.body, null, 2));
  }
  process.exitCode = 1;
});
