import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createAffiliateSubscriptionAttributionService,
} from '../lib/affiliateSubscriptionAttributionService.js';

const ACCOUNT_MAX = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_LEVI = '22222222-2222-4222-8222-222222222222';
const AFF_MAX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AFF_LEVI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHARED_OFFER = 'AFFILIATE FIRST MONTH $0.99';
const INSTALLATION_ONE = '11111111-aaaa-4aaa-8aaa-111111111111';

function makeHarness({
  accountId = ACCOUNT_MAX,
  code = 'MAXAGORA',
  affiliateId = AFF_MAX,
  existing = null,
  knownOffer = true,
  claim = true,
  handoffs = [],
  raceAttribution = null,
  claimIsTest = false,
  handoffTableMissing = false,
} = {}) {
  const state = {
    attribution: existing,
    alerts: [],
    updates: 0,
    handoffUpdates: 0,
    handoffs,
  };

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
            is_test: claimIsTest,
            apple_offer_identifier: 'Affiliate First Month $0.99',
            normalized_apple_offer_identifier: SHARED_OFFER,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM affiliate_referral_handoffs handoff')) {
        if (handoffTableMissing) {
          const error = new Error('relation affiliate_referral_handoffs does not exist');
          error.code = '42P01';
          throw error;
        }
        let rows = state.handoffs.slice();
        if (text.includes('handoff.installation_id = $1')) {
          rows = rows.filter(row => row.installation_id === params[0]);
        }
        if (text.includes('handoff.account_id = $1')) {
          rows = rows.filter(row => row.account_id === params[0]);
        }
        rows = rows.filter(
          row => row.normalized_apple_offer_identifier === params[1]
        );
        if (text.includes("affiliate.status = 'active'")) {
          rows = rows.filter(row => row.affiliate_status !== 'inactive');
        }
        if (text.includes("affiliate.code_status = 'active'")) {
          rows = rows.filter(row => row.code_status !== 'inactive');
        }
        if (text.includes('affiliate.is_test = $4')) {
          rows = rows.filter(
            row => Boolean(row.affiliate_is_test) === Boolean(params[3])
          );
        }
        return { rows, rowCount: rows.length };
      }
      if (text.includes('INSERT INTO affiliate_subscription_attributions')) {
        if (raceAttribution) {
          state.attribution = raceAttribution;
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('referral_handoff_id')) {
          state.attribution = {
            id: 'attr-new',
            affiliate_id: params[0],
            account_id: params[1],
            referral_handoff_id: params[2],
            attribution_installation_id: params[3],
            original_transaction_id: params[4],
            environment: params[5],
            attribution_transaction_id: params[6],
            offer_identifier: params[7],
            normalized_offer_identifier: params[8],
            offer_type: '3',
            creator_code: params[9],
            normalized_creator_code: params[9],
            attribution_source: 'referral_handoff',
            normalized_code: params[9],
          };
        } else {
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
        }
        return { rows: [state.attribution], rowCount: 1 };
      }
      if (text.includes('UPDATE affiliate_referral_handoffs')) {
        state.handoffUpdates += 1;
        return { rows: [], rowCount: 1 };
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


test('automatic handoffs can only match purchases inside the handoff validity window', async () => {
  const source = await readFile(
    new URL('../lib/affiliateSubscriptionAttributionService.js', import.meta.url),
    'utf8'
  );

  const matches = source.match(/AND \$3 <= handoff\.expires_at/g) || [];
  assert.equal(matches.length, 2);
});


test('automatic handoffs require an active affiliate and active creator code at purchase time', async () => {
  const handoff = {
    id: 'abababab-abab-4bab-8bab-abababababab',
    affiliate_id: AFF_MAX,
    normalized_code: 'MAXAGORA',
    installation_id: INSTALLATION_ONE,
    account_id: null,
    status: 'claimed',
    claimed_at: new Date('2026-08-14T20:01:00Z'),
    redemption_started_at: new Date('2026-08-14T19:59:00Z'),
    normalized_apple_offer_identifier: SHARED_OFFER,
    affiliate_status: 'inactive',
    code_status: 'active',
  };

  const { state, client, pool } = makeHarness({
    claim: false,
    handoffs: [handoff],
  });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    installationId: INSTALLATION_ONE,
    transaction: offerTransaction(),
  });

  assert.equal(result.attributed, false);
  assert.equal(state.attribution, null);
});

test('claimed installation handoff takes priority and attributes without manual creator-code entry', async () => {
  const handoff = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    affiliate_id: AFF_MAX,
    normalized_code: 'MAXAGORA',
    installation_id: INSTALLATION_ONE,
    account_id: null,
    status: 'claimed',
    claimed_at: new Date('2026-08-14T20:01:00Z'),
    redemption_started_at: new Date('2026-08-14T19:59:00Z'),
    normalized_apple_offer_identifier: SHARED_OFFER,
  };

  const { state, client, pool } = makeHarness({
    claim: false,
    handoffs: [handoff],
  });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    installationId: INSTALLATION_ONE,
    transaction: offerTransaction(),
  });

  assert.equal(result.status, 'attributed_new');
  assert.equal(result.affiliateId, AFF_MAX);
  assert.equal(result.normalizedCode, 'MAXAGORA');
  assert.equal(result.referralHandoffId, handoff.id);
  assert.equal(state.attribution.attribution_source, 'referral_handoff');
  assert.equal(state.attribution.attribution_installation_id, INSTALLATION_ONE);
  assert.equal(state.handoffUpdates, 1);
});

test('a handoff consumed by a same-affiliate attribution race is marked attributed and cannot be reused', async () => {
  const handoff = {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    affiliate_id: AFF_MAX,
    normalized_code: 'MAXAGORA',
    installation_id: INSTALLATION_ONE,
    account_id: null,
    status: 'claimed',
    claimed_at: new Date('2026-08-14T20:01:00Z'),
    redemption_started_at: new Date('2026-08-14T19:59:00Z'),
    normalized_apple_offer_identifier: SHARED_OFFER,
  };
  const raceAttribution = {
    id: 'attr-race',
    affiliate_id: AFF_MAX,
    account_id: null,
    normalized_code: 'MAXAGORA',
    original_transaction_id: 'orig-1',
    environment: 'Production',
  };

  const { state, client, pool } = makeHarness({
    claim: false,
    handoffs: [handoff],
    raceAttribution,
  });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    installationId: INSTALLATION_ONE,
    transaction: offerTransaction(),
  });

  assert.equal(result.status, 'inherited_existing');
  assert.equal(result.affiliateId, AFF_MAX);
  assert.equal(state.handoffUpdates, 1);
});

test('a handoff that loses a different-affiliate attribution race is superseded and cannot be reused', async () => {
  const handoff = {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    affiliate_id: AFF_MAX,
    normalized_code: 'MAXAGORA',
    installation_id: INSTALLATION_ONE,
    account_id: null,
    status: 'claimed',
    claimed_at: new Date('2026-08-14T20:01:00Z'),
    redemption_started_at: new Date('2026-08-14T19:59:00Z'),
    normalized_apple_offer_identifier: SHARED_OFFER,
  };
  const raceAttribution = {
    id: 'attr-race-levi',
    affiliate_id: AFF_LEVI,
    account_id: null,
    normalized_code: 'LEVI99',
    original_transaction_id: 'orig-1',
    environment: 'Production',
  };

  const { state, client, pool } = makeHarness({
    claim: false,
    handoffs: [handoff],
    raceAttribution,
  });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    installationId: INSTALLATION_ONE,
    transaction: offerTransaction(),
  });

  assert.equal(result.status, 'conflict_preserved_existing');
  assert.equal(result.affiliateId, AFF_LEVI);
  assert.equal(state.handoffUpdates, 1);
  assert.equal(state.alerts.length, 1);
});

test('conflicting account-level handoffs are left unassigned for review instead of guessed', async () => {
  const { state, client, pool } = makeHarness({
    claim: false,
    handoffs: [
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        affiliate_id: AFF_MAX,
        normalized_code: 'MAXAGORA',
        installation_id: 'install-one-1234',
        account_id: ACCOUNT_MAX,
        status: 'claimed',
        claimed_at: new Date('2026-08-14T20:01:00Z'),
        redemption_started_at: new Date('2026-08-14T19:58:00Z'),
        normalized_apple_offer_identifier: SHARED_OFFER,
      },
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        affiliate_id: AFF_LEVI,
        normalized_code: 'LEVI99',
        installation_id: 'install-two-5678',
        account_id: ACCOUNT_MAX,
        status: 'claimed',
        claimed_at: new Date('2026-08-14T20:02:00Z'),
        redemption_started_at: new Date('2026-08-14T19:59:00Z'),
        normalized_apple_offer_identifier: SHARED_OFFER,
      },
    ],
  });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    accountId: ACCOUNT_MAX,
    transaction: offerTransaction(),
  });

  assert.equal(result.status, 'handoff_ambiguous_needs_review');
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


test('production Apple transactions cannot be attributed to sandbox/test affiliate handoffs', async () => {
  const handoff = {
    id: 'abababab-abab-4bab-8bab-abababababab',
    affiliate_id: AFF_MAX,
    normalized_code: 'MAXAGORA',
    installation_id: INSTALLATION_ONE,
    account_id: null,
    status: 'claimed',
    claimed_at: new Date('2026-08-14T20:01:00Z'),
    redemption_started_at: new Date('2026-08-14T19:59:00Z'),
    expires_at: new Date('2026-08-21T19:59:00Z'),
    normalized_apple_offer_identifier: SHARED_OFFER,
    affiliate_status: 'active',
    code_status: 'active',
    affiliate_is_test: true,
  };

  const { state, client, pool } = makeHarness({
    claim: false,
    handoffs: [handoff],
  });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    installationId: INSTALLATION_ONE,
    transaction: offerTransaction(),
  });

  assert.equal(result.attributed, false);
  assert.equal(state.attribution, null);
});


test('sandbox Apple transactions can use test affiliate handoffs but production handoffs are excluded', async () => {
  const testHandoff = {
    id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
    affiliate_id: AFF_MAX,
    normalized_code: 'MAXAGORA',
    installation_id: INSTALLATION_ONE,
    account_id: null,
    status: 'claimed',
    claimed_at: new Date('2026-08-14T20:01:00Z'),
    redemption_started_at: new Date('2026-08-14T19:59:00Z'),
    expires_at: new Date('2026-08-21T19:59:00Z'),
    normalized_apple_offer_identifier: SHARED_OFFER,
    affiliate_status: 'active',
    code_status: 'active',
    affiliate_is_test: true,
  };

  const { state, client, pool } = makeHarness({
    claim: false,
    handoffs: [testHandoff],
  });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Sandbox',
    installationId: INSTALLATION_ONE,
    transaction: offerTransaction(),
  });

  assert.equal(result.status, 'attributed_new');
  assert.equal(result.affiliateId, AFF_MAX);
  assert.equal(state.attribution.environment, 'Sandbox');
});


test('legacy manual creator-code claims cannot cross production and sandbox environments', async () => {
  const { state, client, pool } = makeHarness({
    claim: true,
    claimIsTest: true,
    handoffs: [],
  });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    accountId: ACCOUNT_MAX,
    transaction: offerTransaction(),
  });

  assert.equal(result.status, 'affiliate_environment_mismatch');
  assert.equal(result.attributed, false);
  assert.equal(state.attribution, null);
  assert.equal(state.alerts.length, 1);
});


test('rolling deploy before migration 023 falls back to existing account-claim attribution instead of breaking entitlement-side processing', async () => {
  const { state, client, pool } = makeHarness({
    handoffTableMissing: true,
    claim: true,
  });
  const service = createAffiliateSubscriptionAttributionService({ pool });

  const result = await service.observeVerifiedTransaction({
    client,
    environment: 'Production',
    accountId: ACCOUNT_MAX,
    installationId: INSTALLATION_ONE,
    transaction: offerTransaction(),
  });

  assert.equal(result.status, 'attributed_new');
  assert.equal(result.affiliateId, AFF_MAX);
  assert.equal(state.attribution.attribution_source, 'account_creator_code');
});


test('public App Clip rollout refuses legacy account-claim-only ownership for new shared-offer purchases', async () => {
  const { state, client, pool } = makeHarness({
    accountId: ACCOUNT_MAX,
    code: 'MAXAGORA',
    affiliateId: AFF_MAX,
    claim: true,
    handoffs: [],
  });

  const service = createAffiliateSubscriptionAttributionService({
    pool,
    requireReferralHandoffForNewAttribution: true,
  });

  const result = await service.observeVerifiedTransaction({
    client,
    transaction: offerTransaction(),
    environment: 'Production',
    accountId: ACCOUNT_MAX,
    installationId: INSTALLATION_ONE,
  });

  assert.equal(result.status, 'awaiting_referral_handoff');
  assert.equal(result.attributed, false);
  assert.equal(state.attribution, null);
  assert.ok(
    state.alerts.some(({ params }) =>
      params.includes('affiliate_handoff_missing')
    )
  );
});


test('exact installation context never falls back to another device account handoff', async () => {
  const OTHER_INSTALLATION = '22222222-bbbb-4bbb-8bbb-222222222222';
  const { state, client, pool } = makeHarness({
    accountId: ACCOUNT_MAX,
    claim: true,
    handoffs: [{
      id: 'handoff-other-device',
      affiliate_id: AFF_MAX,
      normalized_code: 'MAXAGORA',
      installation_id: OTHER_INSTALLATION,
      account_id: ACCOUNT_MAX,
      status: 'claimed',
      claimed_at: new Date('2026-08-14T19:59:00Z'),
      redemption_started_at: new Date('2026-08-14T19:58:00Z'),
      expires_at: new Date('2026-08-21T19:58:00Z'),
      superseded_at: null,
      attributed_original_transaction_id: null,
      affiliate_status: 'active',
      code_status: 'active',
      affiliate_is_test: false,
      normalized_apple_offer_identifier: SHARED_OFFER,
    }],
  });

  const service = createAffiliateSubscriptionAttributionService({
    pool,
    requireReferralHandoffForNewAttribution: true,
  });

  const result = await service.observeVerifiedTransaction({
    client,
    transaction: offerTransaction(),
    environment: 'Production',
    accountId: ACCOUNT_MAX,
    installationId: INSTALLATION_ONE,
  });

  assert.equal(result.status, 'awaiting_referral_handoff');
  assert.equal(result.attributed, false);
  assert.equal(state.attribution, null);
});

test('public App Clip rollout never auto-attributes from account-only handoff evidence when installation context is unavailable', async () => {
  const { state, client, pool } = makeHarness({
    accountId: ACCOUNT_MAX,
    claim: true,
    handoffs: [{
      id: 'handoff-account-only-candidate',
      affiliate_id: AFF_MAX,
      normalized_code: 'MAXAGORA',
      installation_id: INSTALLATION_ONE,
      account_id: ACCOUNT_MAX,
      status: 'claimed',
      claimed_at: new Date('2026-08-14T19:59:00Z'),
      redemption_started_at: new Date('2026-08-14T19:58:00Z'),
      expires_at: new Date('2026-08-21T19:58:00Z'),
      superseded_at: null,
      attributed_original_transaction_id: null,
      affiliate_status: 'active',
      code_status: 'active',
      affiliate_is_test: false,
      normalized_apple_offer_identifier: SHARED_OFFER,
    }],
  });

  const service = createAffiliateSubscriptionAttributionService({
    pool,
    requireReferralHandoffForNewAttribution: true,
  });

  const result = await service.observeVerifiedTransaction({
    client,
    transaction: offerTransaction(),
    environment: 'Production',
    accountId: ACCOUNT_MAX,
    installationId: null,
  });

  assert.equal(result.status, 'awaiting_referral_handoff');
  assert.equal(result.attributed, false);
  assert.equal(state.attribution, null);
});
