import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAffiliateAccountReferralService,
} from '../lib/affiliateAccountReferralService.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const AFF_MAX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AFF_LEVI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeHarness({ existing = null } = {}) {
  const state = { claim: existing, alerts: 0 };
  const accountAuthService = {
    async authorizeAccessToken({ installationId }) {
      return { accountId: ACCOUNT, installationId };
    },
  };

  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM affiliates') && text.includes('WHERE normalized_code = $1')) {
        const code = params[0];
        if (code === 'MAXAGORA') return { rows: [{ id: AFF_MAX, display_name: 'Max', normalized_code: code, status: 'active', code_status: 'active', is_test: false }], rowCount: 1 };
        if (code === 'LEVI99') return { rows: [{ id: AFF_LEVI, display_name: 'Levi', normalized_code: code, status: 'active', code_status: 'active', is_test: false }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM affiliate_account_referrals claim')) {
        return { rows: state.claim ? [state.claim] : [], rowCount: state.claim ? 1 : 0 };
      }
      if (text.includes('INSERT INTO affiliate_account_referrals')) {
        state.claim = {
          account_id: params[0],
          affiliate_id: params[1],
          creator_code: params[2],
          normalized_code: params[2],
          claim_source: params[3],
          claimed_at: new Date('2026-08-14T20:00:00Z'),
          display_name: params[2] === 'MAXAGORA' ? 'Max' : 'Levi',
          affiliate_status: 'active',
          code_status: 'active',
        };
        return { rows: [state.claim], rowCount: 1 };
      }
      if (text.includes('INSERT INTO affiliate_alerts')) {
        state.alerts += 1;
        return { rows: [], rowCount: 1 };
      }
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected SQL: ${text}`);
    },
    release() {},
  };

  const pool = {
    async connect() { return client; },
    async query(sql, params) { return client.query(sql, params); },
  };

  return { state, pool, accountAuthService };
}

const auth = {
  installationId: 'installation-12345',
  accessToken: 'signed-in-access-token',
};

test('first authenticated creator-code claim is locked to the account', async () => {
  const { state, pool, accountAuthService } = makeHarness();
  const service = createAffiliateAccountReferralService({ pool, accountAuthService });

  const result = await service.claimCreatorCode({
    ...auth,
    customCode: 'maxagora',
  });

  assert.equal(result.created, true);
  assert.equal(result.claim.creatorCode, 'MAXAGORA');
  assert.equal(state.claim.affiliate_id, AFF_MAX);
});

test('claiming the same creator code again is idempotent', async () => {
  const existing = {
    account_id: ACCOUNT,
    affiliate_id: AFF_MAX,
    creator_code: 'MAXAGORA',
    normalized_code: 'MAXAGORA',
    claim_source: 'creator_code_entry',
    claimed_at: new Date('2026-08-14T20:00:00Z'),
    display_name: 'Max',
    affiliate_status: 'active',
    code_status: 'active',
  };
  const { pool, accountAuthService } = makeHarness({ existing });
  const service = createAffiliateAccountReferralService({ pool, accountAuthService });

  const result = await service.claimCreatorCode({ ...auth, customCode: 'MAXAGORA' });
  assert.equal(result.created, false);
  assert.equal(result.claim.creatorCode, 'MAXAGORA');
});

test('later conflicting creator code never silently replaces the locked claim', async () => {
  const existing = {
    account_id: ACCOUNT,
    affiliate_id: AFF_MAX,
    creator_code: 'MAXAGORA',
    normalized_code: 'MAXAGORA',
    claim_source: 'creator_code_entry',
    claimed_at: new Date('2026-08-14T20:00:00Z'),
    display_name: 'Max',
    affiliate_status: 'active',
    code_status: 'active',
  };
  const { state, pool, accountAuthService } = makeHarness({ existing });
  const service = createAffiliateAccountReferralService({ pool, accountAuthService });

  await assert.rejects(
    service.claimCreatorCode({ ...auth, customCode: 'LEVI99' }),
    error => error?.code === 'affiliate_claim_already_set'
  );
  assert.equal(state.claim.normalized_code, 'MAXAGORA');
  assert.equal(state.alerts, 1);
});
