import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildDefaultAppClipCreatorUrl,
} from '../lib/affiliateProgramService.js';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = fs.readFileSync(
  path.join(root, 'scripts', 'runAffiliateHandoffMigration.js'),
  'utf8'
);
const routes = fs.readFileSync(
  path.join(root, 'affiliateRoutes.js'),
  'utf8'
);
const programService = fs.readFileSync(
  path.join(root, 'lib', 'affiliateProgramService.js'),
  'utf8'
);
const serverSource = fs.readFileSync(
  path.join(root, 'server.js'),
  'utf8'
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
);

test('handoff rollout has a dedicated migration runner that applies only 023', () => {
  assert.equal(
    packageJson.scripts['affiliate:handoff-migrate'],
    'node scripts/runAffiliateHandoffMigration.js'
  );
  assert.match(runner, /MIGRATION_VERSION = 23/);
  assert.match(runner, /023_affiliate_referral_handoffs\.sql/);
  assert.match(runner, /requirePrerequisiteSchema/);
  assert.match(runner, /Unrelated pending migrations will not be touched/);
  assert.doesNotMatch(runner, /runMigrations\.js/);
});

test('generated referral links default to the production Railway host until a branded domain is routed there', () => {
  assert.match(
    routes,
    /AFFILIATE_REFERRAL_BASE_URL[\s\S]*?https:\/\/debate-arena-backend-production\.up\.railway\.app/
  );
});


test('live creator referral URL is a direct Apple default App Clip link with only the public creator code', () => {
  const url = new URL(buildDefaultAppClipCreatorUrl({
    appClipBundleId: 'com.bhernaurd.TheAgora.Clip',
    creatorCode: 'maxagora',
  }));

  assert.equal(url.origin, 'https://appclip.apple.com');
  assert.equal(url.pathname, '/id');
  assert.equal(url.searchParams.get('p'), 'com.bhernaurd.TheAgora.Clip');
  assert.equal(url.searchParams.get('code'), 'MAXAGORA');
  assert.equal(url.searchParams.get('handoff'), null);
});


test('public rollout flag also makes exact referral handoff mandatory for new affiliate ownership', () => {
  assert.match(
    serverSource,
    /AFFILIATE_APP_CLIP_HANDOFF_ENABLED[\s\S]*?requireReferralHandoffForNewAttribution:[\s\S]*?affiliateAppClipHandoffEnabled/
  );
  assert.match(
    serverSource,
    /createAffiliateRouter\(pool, \{[\s\S]*?appClipHandoffEnabled: affiliateAppClipHandoffEnabled/
  );
});
