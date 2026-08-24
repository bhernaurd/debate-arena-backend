import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifySubscriptionAdminMilestone,
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
