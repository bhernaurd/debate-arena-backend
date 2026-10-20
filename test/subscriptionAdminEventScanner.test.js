import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifySubscriptionAdminMilestone,
    shouldDeferSubscriptionAdminMilestoneForAffiliate,
} from '../subscriptionAdminEventScanner.js';

test('classifies an initial free trial as a trial-start milestone', () => {
    const result = classifySubscriptionAdminMilestone({
        event_type: 'SUBSCRIBED',
        subtype: 'INITIAL_BUY',
        is_trial: true,
        price_milliunits: 0,
    });

    assert.equal(result, 'trial_started');
});

test('classifies an initial paid purchase as a paid-subscriber milestone', () => {
    const result = classifySubscriptionAdminMilestone({
        event_type: 'SUBSCRIBED',
        subtype: 'INITIAL_BUY',
        is_trial: false,
        price_milliunits: 24990,
    });

    assert.equal(result, 'new_paid_subscription');
});

test('classifies the first paid DID_RENEW after a trial as a conversion', () => {
    const result = classifySubscriptionAdminMilestone(
        {
            event_type: 'DID_RENEW',
            subtype: '',
            is_trial: false,
            price_milliunits: 24990,
        },
        {
            hadTrial: true,
            hadPriorPaidTransaction: false,
        }
    );

    assert.equal(result, 'trial_converted_to_paid');
});

test('does not classify later paid renewals as trial conversions', () => {
    const result = classifySubscriptionAdminMilestone(
        {
            event_type: 'DID_RENEW',
            is_trial: false,
            price_milliunits: 24990,
        },
        {
            hadTrial: true,
            hadPriorPaidTransaction: true,
        }
    );

    assert.equal(result, null);
});

test('does not classify a zero-price DID_RENEW as a paid conversion', () => {
    const result = classifySubscriptionAdminMilestone(
        {
            event_type: 'DID_RENEW',
            is_trial: false,
            price_milliunits: 0,
        },
        {
            hadTrial: true,
            hadPriorPaidTransaction: false,
        }
    );

    assert.equal(result, null);
});


test('defers a fresh Apple trial alert when exact affiliate attribution is still missing', () => {
    const now = new Date('2026-10-20T19:18:00.000Z');

    assert.equal(
        shouldDeferSubscriptionAdminMilestoneForAffiliate(
            {
                event_at: '2026-10-20T19:17:15.000Z',
                affiliate_code: null,
            },
            {
                kind: 'trial_started',
                graceMs: 120_000,
                now,
            }
        ),
        true
    );
});

test('does not defer when the creator code is already attributed', () => {
    const now = new Date('2026-10-20T19:18:00.000Z');

    assert.equal(
        shouldDeferSubscriptionAdminMilestoneForAffiliate(
            {
                event_at: '2026-10-20T19:17:15.000Z',
                affiliate_code: 'SNOXY',
            },
            {
                kind: 'trial_started',
                graceMs: 120_000,
                now,
            }
        ),
        false
    );
});

test('sends without affiliate after the bounded attribution grace window expires', () => {
    const now = new Date('2026-10-20T19:20:00.000Z');

    assert.equal(
        shouldDeferSubscriptionAdminMilestoneForAffiliate(
            {
                event_at: '2026-10-20T19:17:00.000Z',
                affiliate_code: null,
            },
            {
                kind: 'trial_started',
                graceMs: 120_000,
                now,
            }
        ),
        false
    );
});

test('does not delay unrelated Apple admin events', () => {
    const now = new Date('2026-10-20T19:18:00.000Z');

    assert.equal(
        shouldDeferSubscriptionAdminMilestoneForAffiliate(
            {
                event_at: '2026-10-20T19:17:15.000Z',
                affiliate_code: null,
            },
            {
                kind: null,
                graceMs: 120_000,
                now,
            }
        ),
        false
    );
});
