import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildAppleSubscriptionAdminAlert,
    classifyAppleSubscriptionAlert,
    formatAppleMilliunitPrice,
} from '../lib/subscriptionAdminNotificationService.js';

test('classifies a V2 initial subscription as a new subscriber alert', () => {
    const result = classifyAppleSubscriptionAlert({
        notificationType: 'SUBSCRIBED',
        subtype: 'INITIAL_BUY',
    });

    assert.equal(result.eventKind, 'new_subscription');
    assert.equal(result.title, 'New Agora Pro subscriber');
});

test('classifies auto-renew disabled separately from expiration', () => {
    const result = classifyAppleSubscriptionAlert({
        notificationType: 'DID_CHANGE_RENEWAL_STATUS',
        subtype: 'AUTO_RENEW_DISABLED',
    });

    assert.equal(result.eventKind, 'auto_renew_disabled');
});

test('renewals are quiet by default and can be enabled explicitly', () => {
    assert.equal(
        classifyAppleSubscriptionAlert({
            notificationType: 'DID_RENEW',
        }),
        null
    );

    const enabled = classifyAppleSubscriptionAlert({
        notificationType: 'DID_RENEW',
        notifyRenewals: true,
    });

    assert.equal(enabled.eventKind, 'renewal');
});

test('formats Apple JWS price milliunits for display', () => {
    assert.equal(
        formatAppleMilliunitPrice(24990, 'USD'),
        '$24.99'
    );

    assert.equal(
        formatAppleMilliunitPrice(null, 'USD'),
        null
    );
});

test('builds a production new-subscriber notification with masked IDs', () => {
    const accountId =
        '59fe07dc-6463-4232-8308-b63ee14afffc';

    const alert = buildAppleSubscriptionAdminAlert({
        notificationUUID: 'notification-123',
        notificationType: 'SUBSCRIBED',
        subtype: 'INITIAL_BUY',
        environment: 'Production',
        transaction: {
            transactionId: '550003115654020',
            originalTransactionId: '550003097549367',
            productId: 'agora_pro_yearly',
            appAccountToken: accountId,
            price: 24990,
            currency: 'USD',
        },
        entitlement: {
            originalTransactionId: '550003097549367',
            productId: 'agora_pro_yearly',
            status: 'active',
            isTrial: false,
            autoRenewEnabled: true,
            expiresDate: new Date('2027-08-19T03:11:06.000Z'),
        },
        affiliateAttribution: {
            normalizedCode: 'MAXAGORA',
        },
    });

    assert.equal(alert.eventKind, 'new_subscription');
    assert.equal(alert.environment, 'Production');
    assert.equal(alert.accountId, accountId);
    assert.equal(alert.productId, 'agora_pro_yearly');
    assert.match(alert.body, /Plan: Yearly/);
    assert.match(alert.body, /Apple transaction price: \$24\.99/);
    assert.match(alert.body, /Affiliate: MAXAGORA/);
    assert.doesNotMatch(alert.body, new RegExp(accountId));
    assert.equal(
        alert.payload.appleTransactionPrice,
        '$24.99'
    );
});

test('ignores App Store events that are not owner-alert events', () => {
    const alert = buildAppleSubscriptionAdminAlert({
        notificationUUID: 'notification-irrelevant',
        notificationType: 'DID_CHANGE_RENEWAL_PREF',
        subtype: 'DOWNGRADE',
        environment: 'Production',
    });

    assert.equal(alert, null);
});
