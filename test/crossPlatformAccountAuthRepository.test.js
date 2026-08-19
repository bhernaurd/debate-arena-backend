import assert from 'node:assert/strict';
import test from 'node:test';

import { createCrossPlatformAccountAuthRepository } from '../lib/crossPlatformAccountAuthRepository.js';

const existing = {
    identity_id: '11111111-1111-4111-8111-111111111111',
    account_id: '22222222-2222-4222-8222-222222222222',
    issuer: 'https://appleid.apple.com',
    audience: 'com.bhernaurd.TheAgora',
    subject: 'team-scoped-subject',
    account_status: 'active',
    auth_version: 1,
    display_name: 'Agora User',
};

const linked = {
    ...existing,
    identity_id: '33333333-3333-4333-8333-333333333333',
    audience: 'com.bhernaurd.theagora.web',
};

function isExactAudienceLookup(text) {
    return text.includes('WHERE ai.issuer = $1') &&
        text.includes('AND ai.audience = $2') &&
        text.includes('AND ai.subject = $3');
}

test('a new Apple audience links to the existing team-scoped Agora account', async () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    const repository = createCrossPlatformAccountAuthRepository(pool);
    let exactCalls = 0;

    const tx = {
        async query(text) {
            if (isExactAudienceLookup(text)) {
                exactCalls += 1;
                return exactCalls === 1
                    ? { rows: [], rowCount: 0 }
                    : { rows: [linked], rowCount: 1 };
            }
            if (text.includes('account-auth:find-team-scoped-apple-identity')) {
                return { rows: [existing], rowCount: 1 };
            }
            if (text.includes('account-auth:link-additional-apple-audience')) {
                return { rows: [], rowCount: 1 };
            }
            throw new Error(`Unexpected SQL: ${text}`);
        },
    };

    const result = await repository.findAppleIdentityForUpdate(tx, {
        issuer: existing.issuer,
        audience: linked.audience,
        subject: existing.subject,
    });

    assert.equal(result.accountId, existing.account_id);
    assert.equal(result.audience, linked.audience);
    assert.equal(exactCalls, 2);
});

test('conflicting accounts for one team-scoped Apple subject are rejected', async () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    const repository = createCrossPlatformAccountAuthRepository(pool);
    const tx = {
        async query(text) {
            if (isExactAudienceLookup(text)) {
                return { rows: [], rowCount: 0 };
            }
            if (text.includes('account-auth:find-team-scoped-apple-identity')) {
                return {
                    rows: [
                        existing,
                        {
                            ...existing,
                            identity_id: '44444444-4444-4444-8444-444444444444',
                            account_id: '55555555-5555-4555-8555-555555555555',
                        },
                    ],
                    rowCount: 2,
                };
            }
            throw new Error(`Unexpected SQL: ${text}`);
        },
    };

    await assert.rejects(
        () => repository.findAppleIdentityForUpdate(tx, {
            issuer: existing.issuer,
            audience: linked.audience,
            subject: existing.subject,
        }),
        (error) => error?.code === 'apple_identity_account_conflict'
    );
});
