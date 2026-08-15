import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAffiliateSubscriptionAttributionService,
} from '../lib/affiliateSubscriptionAttributionService.js';

const ACCOUNT_MAX = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_LEVI = '22222222-2222-4222-8222-222222222222';
const AFF_MAX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AFF_LEVI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHARED_OFFER = 'AFFILIATE FIRST MONTH $0.99';

function makeHarness({ accountId = ACCOUNT_MAX, code = 'MAXAGORA', affiliateId = AFF_MAX, existing = null, knownOffer = true, claim = true } = {}) {
  const state = { attribution: existing, alerts: [], updates: 0 };

  const client = {
    async query(sql, params = []) {
      const text = String(sql);

      if (text.includes('FROM affiliate_subscription_attributions attribution')) {
        return { rows: state.attribution ? [state.attribution] : [], rowCount: state.attribution ? 1 : 0 };
      }
      if (text.includes('SELECT EXISTS') && text.includes('FROM affiliates')) {
        return { rows: [{ known: knownOffer }], rowCount: 1 };
      }
      if (text.includes('FROM accounts') && text.includes('WHERE id = $1')) {
        return { rows: params[0] === accountId ? [{ id: accountId }] : [], rowCount: params[0] === accountId ? 1 : 0 };
      }
      if (text.includes('FROM account_subscription_ownership')) {
        return { rows: [{ account_id: accountId }], rowCount: 1 };
      }
      if (text.includes('FROM affiliate_account_referrals claim')) {
        if (!claim) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            account_id: accountId,
            affiliate_id: affiliateId,
            creator_code: code,
            normalized_code: code,
            claim_source: 'creator_code_entry',
            claimed_at: new Date('2026-08-14T20:00:00Z'),
            display_name: code,
            status: 'active',
            code_status: 'active',
            apple_offer_identifier: 'Affiliate First Month $0.99',
            normalized_apple_offer_identifier: SHARED_OFFER,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('INSERT INTO affiliate_subscription_attributions')) {
        state.attribution = {
          id: 'attr-new',
          affiliate_id: params[0],
          account_id: params[1],
          original_transaction_id: params[2],
          environment: params[3],
          attribution_transaction_id: params[4],
          offer_identifier: params[5],
          normalized_offer_identifier: params[6],
          offer_type: '3',
          creator_code: params[7],
          normalized_creator_code: params[7],
          attribution_source: 'account_creator_code',
          normalized_code: code,
        };
        return { rows: [state.attribution], rowCount: 1 };
      }
      if (text.includes('UPDATE affiliate_subscription_attributions')) {
        state.updates += 1;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO affiliate_alerts')) {
        state.alerts.push({ params, sql: text });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('UPDATE affiliate_alerts')) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected SQL: ${text}`);
    },
  };

  const pool = {
    async connect() { return { ...client, release() {} }; },
    async query() { return { rows: [], rowCount: 0 }; },
  };

  return { state, client, pool };
}

function offerTransaction(overrides = {}) {
  return {
    transactionId: 'tx-1',
    originalTransactionId: 'orig-1',
    offerType: 3,
    offerIdentifier: 'Affiliate First Month $0.99',
    productId: 'agora_pro_monthly',
    appAccountToken: ACCOUNT_MAX,
    purchaseDate: Date.UTC(2026, 7, 14, 20, 0, 0),
    price: 990,
    currency: 'USD',
    ...overrides,
  };
}

test('shared Apple offer plus MAXAGORA account claim attributes the chain to MAXAGORA', async () => {
  const { state, client, pool } = makeHarness();
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    accountId: ACCOUNT_MAX,
    transaction: offerTransaction(),
  });

  assert.equal(result.status, 'attributed_new');
  assert.equal(result.affiliateId, AFF_MAX);
  assert.equal(result.normalizedCode, 'MAXAGORA');
  assert.equal(state.attribution.account_id, ACCOUNT_MAX);
  assert.equal(state.attribution.normalized_creator_code, 'MAXAGORA');
  assert.equal(state.attribution.attribution_source, 'account_creator_code');
});

test('same shared Apple offer can attribute another account to LEVI99', async () => {
  const { state, client, pool } = makeHarness({
    accountId: ACCOUNT_LEVI,
    code: 'LEVI99',
    affiliateId: AFF_LEVI,
  });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    accountId: ACCOUNT_LEVI,
    transaction: offerTransaction({ appAccountToken: ACCOUNT_LEVI, originalTransactionId: 'orig-levi' }),
  });

  assert.equal(result.status, 'attributed_new');
  assert.equal(result.affiliateId, AFF_LEVI);
  assert.equal(result.normalizedCode, 'LEVI99');
  assert.equal(state.attribution.normalized_offer_identifier, SHARED_OFFER);
});

test('shared affiliate offer with no account creator-code claim stays unassigned and reviewable', async () => {
  const { state, client, pool } = makeHarness({ claim: false });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    accountId: ACCOUNT_MAX,
    transaction: offerTransaction(),
  });

  assert.equal(result.status, 'awaiting_creator_code_claim');
  assert.equal(result.attributed, false);
  assert.equal(state.attribution, null);
  assert.equal(state.alerts.length, 1);
});

test('non-affiliate Apple offer is ignored rather than guessed', async () => {
  const { state, client, pool } = makeHarness({ knownOffer: false });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    accountId: ACCOUNT_MAX,
    transaction: offerTransaction({ offerIdentifier: 'Friends and Family Free Pro' }),
  });

  assert.equal(result.status, 'not_affiliate_offer');
  assert.equal(result.attributed, false);
  assert.equal(state.attribution, null);
});

test('renewal without an offer inherits existing chain ownership', async () => {
  const existing = {
    id: 'attr-1',
    affiliate_id: AFF_MAX,
    normalized_code: 'MAXAGORA',
    original_transaction_id: 'orig-1',
    environment: 'Production',
  };
  const { client, pool } = makeHarness({ existing });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    transaction: offerTransaction({ transactionId: 'renewal-1', offerType: null, offerIdentifier: null }),
  });

  assert.equal(result.status, 'inherited_existing');
  assert.equal(result.affiliateId, AFF_MAX);
});
