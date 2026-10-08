import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREATOR_OFFER_ID,
  createAffiliateGooglePlayAttributionService,
} from '../lib/affiliateGooglePlayAttributionService.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const AFFILIATE_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const EVENT_AT = new Date('2026-10-08T04:00:00.000Z');

function createDatabase() {
  const attributions = new Map();
  const orders = new Set();
  const billingEvents = [];

  const client = {
    async query(text, values = []) {
      const sql = String(text);

      if (
        sql.includes('FROM affiliate_google_play_subscription_attributions') &&
        sql.includes('WHERE purchase_token_sha256 = $1')
      ) {
        const row = attributions.get(values[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      if (sql.includes('FROM affiliate_account_referrals claim')) {
        return {
          rows: [{
            affiliate_id: AFFILIATE_ID,
            creator_code: 'CREATOR123',
            normalized_code: 'CREATOR123',
            status: 'active',
            code_status: 'active',
          }],
          rowCount: 1,
        };
      }

      if (
        sql.includes('INSERT INTO affiliate_google_play_subscription_attributions') &&
        sql.includes("'account_creator_code'")
      ) {
        const row = {
          purchase_token_sha256: values[0],
          affiliate_id: values[1],
          account_id: values[2],
          creator_code: values[3],
          normalized_creator_code: values[4],
          attribution_offer_id: values[5],
          attribution_source: 'account_creator_code',
          root_purchase_token_sha256: values[6],
          product_id: values[7],
          base_plan_id: values[8],
          attributed_at: values[9],
        };
        attributions.set(values[0], row);
        return { rows: [row], rowCount: 1 };
      }

      if (
        sql.includes('INSERT INTO affiliate_google_play_subscription_attributions') &&
        sql.includes("'linked_google_play_purchase'")
      ) {
        const row = {
          purchase_token_sha256: values[0],
          affiliate_id: values[1],
          account_id: values[2],
          creator_code: values[3],
          normalized_creator_code: values[4],
          attribution_offer_id: values[5],
          attribution_source: 'linked_google_play_purchase',
          inherited_from_purchase_token_sha256: values[6],
          root_purchase_token_sha256: values[7],
          product_id: values[8],
          base_plan_id: values[9],
          attributed_at: values[10],
        };
        attributions.set(values[0], row);
        return { rows: [row], rowCount: 1 };
      }

      if (sql.includes('UPDATE affiliate_google_play_subscription_attributions')) {
        const row = attributions.get(values[0]);
        if (row) {
          row.product_id = values[1] || row.product_id;
          row.base_plan_id = values[2] || row.base_plan_id;
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      if (sql.includes('INSERT INTO affiliate_google_play_billing_events')) {
        const orderId = values[3];
        if (orders.has(orderId)) {
          return { rows: [], rowCount: 0 };
        }
        orders.add(orderId);
        billingEvents.push({
          affiliateId: values[0],
          accountId: values[1],
          tokenHash: values[2],
          orderId,
          productId: values[4],
          offerId: values[6],
          eventType: values[7],
          eventAt: values[8],
          testPurchase: values[9],
        });
        return { rows: [{ id: String(orders.size) }], rowCount: 1 };
      }

      throw new Error('Unexpected SQL: ' + sql.trim().slice(0, 120));
    },
  };

  return {
    attributions,
    orders,
    billingEvents,
    client,
    pool: {
      query: async () => ({ rows: [] }),
    },
  };
}

function purchase(overrides = {}) {
  return {
    accountId: ACCOUNT_ID,
    purchaseTokenSha256: TOKEN_A,
    linkedPurchaseTokenSha256: null,
    verifiedOfferId: CREATOR_OFFER_ID,
    productId: 'agora_pro_monthly',
    basePlanId: 'monthly',
    latestOrderId: 'GPA.TRIAL',
    isTrial: true,
    testPurchase: false,
    autoRenewEnabled: true,
    normalizedStatus: 'trial',
    attributedAt: EVENT_AT,
    billingEventAt: EVENT_AT,
    ...overrides,
  };
}

test('creator offer permanently binds the verified Google token to the locked account affiliate', async () => {
  const db = createDatabase();
  const service = createAffiliateGooglePlayAttributionService({
    pool: db.pool,
  });

  const result = await service.recordVerifiedPurchase({
    client: db.client,
    ...purchase(),
  });

  assert.equal(result.attributed, true);
  assert.equal(result.affiliateId, AFFILIATE_ID);
  assert.equal(result.creatorCode, 'CREATOR123');
  assert.equal(result.attributionSource, 'account_creator_code');
  assert.equal(result.billingEventCreated, true);

  const attribution = db.attributions.get(TOKEN_A);
  assert.equal(attribution.root_purchase_token_sha256, TOKEN_A);
  assert.equal(attribution.attribution_offer_id, CREATOR_OFFER_ID);
  assert.equal(db.billingEvents[0].eventType, 'trial_start');
});

test('trial conversion and renewals become idempotent paid billing events', async () => {
  const db = createDatabase();
  const service = createAffiliateGooglePlayAttributionService({
    pool: db.pool,
  });

  await service.recordVerifiedPurchase({
    client: db.client,
    ...purchase(),
  });

  const paid = await service.recordVerifiedPurchase({
    client: db.client,
    ...purchase({
      latestOrderId: 'GPA.PAID.0',
      isTrial: false,
      normalizedStatus: 'active',
      billingEventAt: new Date('2026-10-15T04:00:00.000Z'),
    }),
  });
  assert.equal(paid.billingEventCreated, true);

  const duplicate = await service.recordVerifiedPurchase({
    client: db.client,
    ...purchase({
      latestOrderId: 'GPA.PAID.0',
      isTrial: false,
      normalizedStatus: 'active',
      billingEventAt: new Date('2026-10-15T04:01:00.000Z'),
    }),
  });
  assert.equal(duplicate.billingEventCreated, false);

  const renewal = await service.recordVerifiedPurchase({
    client: db.client,
    ...purchase({
      latestOrderId: 'GPA.PAID.1',
      isTrial: false,
      normalizedStatus: 'active',
      billingEventAt: new Date('2026-11-15T04:00:00.000Z'),
    }),
  });
  assert.equal(renewal.billingEventCreated, true);

  assert.deepEqual(
    db.billingEvents.map((event) => event.eventType),
    ['trial_start', 'paid_order', 'paid_order']
  );
});

test('replacement Google purchase token inherits permanent affiliate ownership', async () => {
  const db = createDatabase();
  const service = createAffiliateGooglePlayAttributionService({
    pool: db.pool,
  });

  await service.recordVerifiedPurchase({
    client: db.client,
    ...purchase(),
  });

  const result = await service.recordVerifiedPurchase({
    client: db.client,
    ...purchase({
      purchaseTokenSha256: TOKEN_B,
      linkedPurchaseTokenSha256: TOKEN_A,
      verifiedOfferId: null,
      latestOrderId: 'GPA.REPLACEMENT.0',
      isTrial: false,
      normalizedStatus: 'active',
    }),
  });

  assert.equal(result.attributed, true);
  assert.equal(result.attributionSource, 'linked_google_play_purchase');
  const inherited = db.attributions.get(TOKEN_B);
  assert.equal(inherited.affiliate_id, AFFILIATE_ID);
  assert.equal(inherited.root_purchase_token_sha256, TOKEN_A);
  assert.equal(inherited.inherited_from_purchase_token_sha256, TOKEN_A);
});

test('ordinary Google subscription without creator offer or linked ownership is not attributed', async () => {
  const db = createDatabase();
  const service = createAffiliateGooglePlayAttributionService({
    pool: db.pool,
  });

  const result = await service.recordVerifiedPurchase({
    client: db.client,
    ...purchase({
      verifiedOfferId: null,
      latestOrderId: 'GPA.NORMAL',
      isTrial: false,
    }),
  });

  assert.deepEqual(result, {
    attributed: false,
    billingEventCreated: false,
  });
  assert.equal(db.attributions.size, 0);
  assert.equal(db.billingEvents.length, 0);
});
