import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createAnalyticsRouter } from '../analytics.js';

const USER_ID = 'android-analytics-installation-001';
const OTHER_USER_ID = 'android-analytics-installation-999';
const ADMIN_KEY = 'analytics-test-admin';

function futureDate() {
    return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function makePool(entitlementRow = null) {
    const queries = [];
    const insertedEvents = [];

    return {
        queries,
        insertedEvents,
        async query(sql, params = []) {
            const text = String(sql);
            queries.push({ text, params });

            if (text.includes('WITH candidates AS')) {
                return {
                    rows: entitlementRow ? [entitlementRow] : [],
                    rowCount: entitlementRow ? 1 : 0,
                };
            }

            if (text.includes('INSERT INTO user_events')) {
                insertedEvents.push({
                    userId: params[0],
                    eventName: params[1],
                    metadata: JSON.parse(params[2]),
                });
                return { rows: [], rowCount: 1 };
            }

            if (text.includes('INSERT INTO user_activity_days')) {
                return { rows: [], rowCount: 1 };
            }

            if (text.includes('WITH normalized_entitlements AS')) {
                return {
                    rows: [{
                        active_trials: '1',
                        active_paid_subscribers: '2',
                        paid_monthly: '1',
                        paid_yearly: '1',
                        google_play_active_trials: '1',
                        google_play_active_paid_subscribers: '1',
                        google_play_on_hold_subscriptions: '0',
                        google_play_paused_subscriptions: '0',
                    }],
                    rowCount: 1,
                };
            }

            if (text.includes('WITH t AS')) {
                return {
                    rows: [{ total_users: '1', dau: '1', wau: '1', mau: '1' }],
                    rowCount: 1,
                };
            }

            if (text.includes('WITH ranked AS')) {
                return {
                    rows: [{ free_dau: '0', trial_dau: '0', paid_pro_dau: '1', unknown_dau: '0' }],
                    rowCount: 1,
                };
            }

            if (text.includes('WITH first_seen AS')) {
                return {
                    rows: [{ cohort_size: '1', d1_plus: '1.000', d7_plus: '0.000', d30_plus: '0.000' }],
                    rowCount: 1,
                };
            }

            if (text.includes('FROM user_events e')) {
                return {
                    rows: [{
                        app_opens_today: '1',
                        debate_starts_today: '0',
                        debate_completions_today: '0',
                        daily_challenge_completions_today: '0',
                        report_generation_started_today: '0',
                        report_generation_completed_today: '0',
                        report_generation_failed_today: '0',
                        paywall_views_today: '0',
                        purchases_completed_today: '0',
                    }],
                    rowCount: 1,
                };
            }

            throw new Error(`Unexpected analytics test SQL: ${text}`);
        },
    };
}

async function startServer(entitlementRow = null) {
    const pool = makePool(entitlementRow);
    const app = express();
    app.use('/analytics', createAnalyticsRouter(pool, { adminKey: ADMIN_KEY }));

    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();

    return {
        pool,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

async function postEvent(server, bodyUserId = USER_ID, headerUserId = USER_ID) {
    return fetch(`${server.baseUrl}/analytics/event`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Installation-ID': headerUserId,
        },
        body: JSON.stringify({
            userId: bodyUserId,
            eventName: 'debate_started',
            metadata: { philosopher: 'Socrates' },
        }),
    });
}

function playEntitlement(overrides = {}) {
    return {
        status: 'active',
        is_trial: false,
        product_id: 'agora_pro_yearly',
        environment: 'GooglePlay',
        expires_date: futureDate(),
        grace_period_expires_date: null,
        auto_renew_enabled: true,
        pricing_cohort: 'standard',
        store_source: 'google_play',
        is_production: true,
        updated_at: new Date().toISOString(),
        ...overrides,
    };
}

function appleEntitlement(overrides = {}) {
    return {
        status: 'active',
        is_trial: false,
        product_id: 'agora_pro_monthly',
        environment: 'Production',
        expires_date: futureDate(),
        grace_period_expires_date: null,
        auto_renew_enabled: true,
        pricing_cohort: 'founding_2026',
        store_source: 'app_store',
        is_production: true,
        updated_at: new Date().toISOString(),
        ...overrides,
    };
}

test('real Google Play paid entitlement enriches Android analytics as paid Pro', async (t) => {
    const server = await startServer(playEntitlement());
    t.after(server.close);

    const response = await postEvent(server);
    assert.equal(response.status, 200);
    assert.equal(server.pool.insertedEvents.length, 1);

    const metadata = server.pool.insertedEvents[0].metadata;
    assert.equal(metadata.analyticsAccessTier, 'paid_pro');
    assert.equal(metadata.subscriptionStoreSource, 'google_play');
    assert.equal(metadata.subscriptionEnvironment, 'GooglePlay');
    assert.equal(metadata.subscriptionProductId, 'agora_pro_yearly');
    assert.equal(metadata.subscriptionPricingCohort, 'standard');
    assert.equal(metadata.subscriptionAutoRenewEnabled, true);
    assert.equal(metadata.revenueEligible, true);
});

test('Google Play trial remains Pro access but is classified as trial and not revenue eligible', async (t) => {
    const server = await startServer(playEntitlement({ is_trial: true, status: 'trial' }));
    t.after(server.close);

    const response = await postEvent(server);
    assert.equal(response.status, 200);

    const metadata = server.pool.insertedEvents[0].metadata;
    assert.equal(metadata.analyticsAccessTier, 'trial');
    assert.equal(metadata.subscriptionStoreSource, 'google_play');
    assert.equal(metadata.revenueEligible, false);
});

test('Google Play license-test purchase can classify access as paid Pro without becoming revenue eligible', async (t) => {
    const server = await startServer(playEntitlement({ is_production: false }));
    t.after(server.close);

    const response = await postEvent(server);
    assert.equal(response.status, 200);

    const metadata = server.pool.insertedEvents[0].metadata;
    assert.equal(metadata.analyticsAccessTier, 'paid_pro');
    assert.equal(metadata.subscriptionStoreSource, 'google_play');
    assert.equal(metadata.revenueEligible, false);
});

test('Google Play on-hold entitlement is not counted as current Pro analytics access', async (t) => {
    const server = await startServer(playEntitlement({ status: 'on_hold' }));
    t.after(server.close);

    const response = await postEvent(server);
    assert.equal(response.status, 200);

    const metadata = server.pool.insertedEvents[0].metadata;
    assert.equal(metadata.analyticsAccessTier, 'free');
    assert.equal(metadata.subscriptionStatus, 'on_hold');
    assert.equal(metadata.subscriptionStoreSource, 'google_play');
    assert.equal(metadata.revenueEligible, false);
});

test('existing App Store production subscription analytics remain paid Pro', async (t) => {
    const server = await startServer(appleEntitlement());
    t.after(server.close);

    const response = await postEvent(server);
    assert.equal(response.status, 200);

    const metadata = server.pool.insertedEvents[0].metadata;
    assert.equal(metadata.analyticsAccessTier, 'paid_pro');
    assert.equal(metadata.subscriptionStoreSource, 'app_store');
    assert.equal(metadata.subscriptionEnvironment, 'Production');
    assert.equal(metadata.subscriptionPricingCohort, 'founding_2026');
    assert.equal(metadata.revenueEligible, true);
});

test('analytics still rejects installation header/body mismatch before persistence', async (t) => {
    const server = await startServer(playEntitlement());
    t.after(server.close);

    const response = await postEvent(server, OTHER_USER_ID, USER_ID);
    assert.equal(response.status, 403);
    assert.equal(server.pool.insertedEvents.length, 0);
});

test('admin subscription summary normalizes Google Play alongside App Store entitlements', async (t) => {
    const server = await startServer();
    t.after(server.close);

    const response = await fetch(`${server.baseUrl}/analytics/summary`, {
        headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.subscriptions.google_play_active_trials, '1');
    assert.equal(body.subscriptions.google_play_active_paid_subscribers, '1');

    const summaryQuery = server.pool.queries.find((query) =>
        query.text.includes('WITH normalized_entitlements AS')
    );
    assert.ok(summaryQuery, 'expected normalized subscription summary query');
    assert.match(summaryQuery.text, /google_play_subscription_entitlements/);
    assert.match(summaryQuery.text, /account_installations/);
    assert.match(summaryQuery.text, /gp\.test_purchase/);
    assert.match(summaryQuery.text, /google_play_active_paid_subscribers/);
});
