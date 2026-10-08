import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import express from 'express';

import {
  analyticsClientContextFromHeaders,
  createAnalyticsRouter,
} from '../analytics.js';

function createPoolRecorder(subscriptionRows = []) {
  const eventRows = [];

  return {
    eventRows,

    async query(text, params = []) {
      if (text.includes('FROM subscription_entitlements se')) {
        return { rows: subscriptionRows };
      }

      if (text.includes('INSERT INTO user_events')) {
        eventRows.push({
          userId: params[0],
          eventName: params[1],
          metadata: JSON.parse(params[2]),
        });
        return { rows: [], rowCount: 1 };
      }

      if (text.includes('INSERT INTO user_activity_days')) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(
        `Unexpected analytics test query: ${text.slice(0, 120)}`
      );
    },
  };
}

async function withAnalyticsServer(pool, work) {
  const app = express();
  app.use(
    '/analytics',
    createAnalyticsRouter(pool, {
      adminKey: 'test-admin-key',
    })
  );

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });

  try {
    const address = server.address();
    await work(
      `http://127.0.0.1:${address.port}/analytics`
    );
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

test('Android analytics context uses the explicit platform and Android build headers', () => {
  assert.deepEqual(
    analyticsClientContextFromHeaders({
      clientPlatform: 'android',
      androidVersion: '4.3',
      androidBuild: '6',
    }),
    {
      clientPlatform: 'android',
      clientVersion: '4.3',
      clientBuild: '6',
      clientPlatformSource: 'x-client-platform',
      clientAnalyticsVersion: 'platform_v1',
    }
  );
});

test('iOS analytics context uses the explicit platform and iOS build headers', () => {
  assert.deepEqual(
    analyticsClientContextFromHeaders({
      clientPlatform: 'ios',
      iosVersion: '4.3',
      iosBuild: '812',
    }),
    {
      clientPlatform: 'ios',
      clientVersion: '4.3',
      clientBuild: '812',
      clientPlatformSource: 'x-client-platform',
      clientAnalyticsVersion: 'platform_v1',
    }
  );
});

test('legacy iOS builds are inferred from X-iOS-Build when X-Client-Platform is absent', () => {
  assert.deepEqual(
    analyticsClientContextFromHeaders({
      iosBuild: '812',
    }),
    {
      clientPlatform: 'ios',
      clientVersion: null,
      clientBuild: '812',
      clientPlatformSource: 'ios-header-fallback',
      clientAnalyticsVersion: 'platform_v1',
    }
  );
});

test('Android analytics metadata cannot spoof iOS platform identity', async () => {
  const pool = createPoolRecorder();

  await withAnalyticsServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Installation-ID': 'android-installation-123',
        'X-Client-Platform': 'android',
        'X-Android-Version': '4.3',
        'X-Android-Build': '6',
      },
      body: JSON.stringify({
        userId: 'android-installation-123',
        eventName: 'debate_completed',
        metadata: {
          clientPlatform: 'ios',
          clientVersion: 'spoofed',
          clientBuild: 'spoofed',
        },
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.equal(pool.eventRows.length, 1);
  assert.equal(
    pool.eventRows[0].metadata.clientPlatform,
    'android'
  );
  assert.equal(
    pool.eventRows[0].metadata.clientVersion,
    '4.3'
  );
  assert.equal(
    pool.eventRows[0].metadata.clientBuild,
    '6'
  );
  assert.equal(
    pool.eventRows[0].metadata.clientPlatformSource,
    'x-client-platform'
  );
});

test('legacy iOS app-open analytics are tagged as iOS by the backend', async () => {
  const pool = createPoolRecorder();

  await withAnalyticsServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/app-open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Installation-ID': 'ios-installation-123',
        'X-iOS-Build': '812',
      },
      body: JSON.stringify({
        userId: 'ios-installation-123',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.equal(pool.eventRows.length, 1);
  assert.equal(
    pool.eventRows[0].eventName,
    'app_opened'
  );
  assert.equal(
    pool.eventRows[0].metadata.clientPlatform,
    'ios'
  );
  assert.equal(
    pool.eventRows[0].metadata.clientBuild,
    '812'
  );
  assert.equal(
    pool.eventRows[0].metadata.clientPlatformSource,
    'ios-header-fallback'
  );
});


test('Google Play Pro is classified as paid Pro in Android analytics metadata', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const pool = createPoolRecorder([
    {
      status: 'active',
      is_trial: false,
      product_id: 'agora_pro_monthly',
      environment: 'Production',
      expires_date: future,
      grace_period_expires_date: null,
      revocation_date: null,
      auto_renew_enabled: true,
      pro_access_source: 'google_play',
      is_recurring_pro: true,
      is_lifetime_pro: false,
      pricing_cohort: 'standard',
      subscription_store: 'google_play',
    },
  ]);

  await withAnalyticsServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Installation-ID': 'android-installation-456',
        'X-Client-Platform': 'android',
        'X-Android-Version': '4.3',
        'X-Android-Build': '6',
      },
      body: JSON.stringify({
        userId: 'android-installation-456',
        eventName: 'paywall_viewed',
        metadata: {},
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.equal(pool.eventRows.length, 1);
  const metadata = pool.eventRows[0].metadata;
  assert.equal(metadata.clientPlatform, 'android');
  assert.equal(metadata.analyticsAccessTier, 'paid_pro');
  assert.equal(metadata.subscriptionStore, 'google_play');
  assert.equal(metadata.subscriptionAccessSource, 'google_play');
  assert.equal(metadata.revenueEligible, true);
});


test('account-owned Apple and manual Pro sources are part of analytics entitlement lookup', () => {
  const source = fs.readFileSync(
    new URL('../analytics.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /FROM account_subscription_ownership ownership/);
  assert.match(source, /ownership\.ownership_status = 'active'/);
  assert.match(source, /FROM account_manual_pro_grants manual/);
  assert.match(source, /manual\.expires_at IS NULL/);
  assert.match(source, /'manual'::text AS subscription_store/);
});

test('manual Pro is classified as Pro but never as store revenue', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const pool = createPoolRecorder([
    {
      status: 'active',
      is_trial: false,
      product_id: 'agora_pro_manual',
      environment: 'Manual',
      expires_date: future,
      grace_period_expires_date: null,
      revocation_date: null,
      auto_renew_enabled: null,
      pro_access_source: 'manual',
      is_recurring_pro: false,
      is_lifetime_pro: false,
      pricing_cohort: 'unknown',
      subscription_store: 'manual',
    },
  ]);

  await withAnalyticsServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Installation-ID': 'android-review-installation-123',
        'X-Client-Platform': 'android',
        'X-Android-Version': '4.3',
        'X-Android-Build': '6',
      },
      body: JSON.stringify({
        userId: 'android-review-installation-123',
        eventName: 'app_opened',
        metadata: {},
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.equal(pool.eventRows.length, 1);
  const metadata = pool.eventRows[0].metadata;
  assert.equal(metadata.analyticsAccessTier, 'paid_pro');
  assert.equal(metadata.subscriptionStore, 'manual');
  assert.equal(metadata.subscriptionAccessSource, 'manual');
  assert.equal(metadata.revenueEligible, false);
});

test('App Store Pro remains classified as paid Pro for linked-account analytics', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const pool = createPoolRecorder([
    {
      status: 'active',
      is_trial: false,
      product_id: 'agora_pro_yearly',
      environment: 'Production',
      expires_date: future,
      grace_period_expires_date: null,
      revocation_date: null,
      auto_renew_enabled: true,
      pro_access_source: 'app_store',
      is_recurring_pro: true,
      is_lifetime_pro: false,
      pricing_cohort: 'standard',
      subscription_store: 'app_store',
    },
  ]);

  await withAnalyticsServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Installation-ID': 'ios-linked-installation-123',
        'X-iOS-Build': '812',
      },
      body: JSON.stringify({
        userId: 'ios-linked-installation-123',
        eventName: 'paywall_viewed',
        metadata: {},
      }),
    });

    assert.equal(response.status, 200);
  });

  const metadata = pool.eventRows[0].metadata;
  assert.equal(metadata.clientPlatform, 'ios');
  assert.equal(metadata.analyticsAccessTier, 'paid_pro');
  assert.equal(metadata.subscriptionStore, 'app_store');
  assert.equal(metadata.revenueEligible, true);
});


test('analytics entitlement precedence cannot downgrade paid Pro to trial or manual access', () => {
  const source = fs.readFileSync(
    new URL('../analytics.js', import.meta.url),
    'utf8'
  );

  const paidStore = source.indexOf(
    "WHEN subscription_store IN ('app_store', 'google_play')\n" +
    "            AND is_trial = false"
  );
  const storeTrial = source.indexOf(
    "WHEN subscription_store IN ('app_store', 'google_play')\n" +
    "            AND is_trial = true"
  );
  const manual = source.indexOf(
    "WHEN subscription_store = 'manual'"
  );

  assert.ok(paidStore >= 0);
  assert.ok(storeTrial > paidStore);
  assert.ok(manual > storeTrial);
});

test('daily and platform analytics apply account-level test-user exclusions', () => {
  const source = fs.readFileSync(
    new URL('../analytics.js', import.meta.url),
    'utf8'
  );

  const todayStart = source.indexOf('const todayQ = pool.query(');
  const tierStart = source.indexOf('const tierQ = pool.query(');
  const platformStart = source.indexOf(
    'const todayByPlatformQ = pool.query('
  );
  const subscriptionsStart = source.indexOf(
    'const subscriptionsQ = pool.query('
  );

  assert.ok(todayStart >= 0 && tierStart > todayStart);
  assert.ok(platformStart >= 0 && subscriptionsStart > platformStart);

  const todayQuery = source.slice(todayStart, tierStart);
  const platformQuery = source.slice(
    platformStart,
    subscriptionsStart
  );

  for (const query of [todayQuery, platformQuery]) {
    assert.match(query, /excluded_accounts AS/);
    assert.match(query, /LEFT JOIN installation_accounts ia/);
    assert.match(
      query,
      /ea\.account_id = ia\.account_id/
    );
  }
});

test('App Store subscription summary excludes entitlements owned by excluded accounts', () => {
  const source = fs.readFileSync(
    new URL('../analytics.js', import.meta.url),
    'utf8'
  );

  const subscriptionsStart = source.indexOf(
    'const subscriptionsQ = pool.query('
  );
  const googlePlayStart = source.indexOf(
    'const googlePlaySubscriptionsQ = pool.query('
  );
  assert.ok(
    subscriptionsStart >= 0 &&
    googlePlayStart > subscriptionsStart
  );

  const appStoreQuery = source.slice(
    subscriptionsStart,
    googlePlayStart
  );

  assert.match(
    appStoreQuery,
    /FROM account_subscription_ownership ownership/
  );
  assert.match(
    appStoreQuery,
    /ownership\.ownership_status = 'active'/
  );
  assert.match(
    appStoreQuery,
    /ai\.installation_id = x\.user_id/
  );
});
