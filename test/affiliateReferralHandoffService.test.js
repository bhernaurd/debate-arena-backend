import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAppleOfferRedemptionUrl,
  buildDefaultAppClipUrl,
  createAffiliateReferralHandoffService,
} from '../lib/affiliateReferralHandoffService.js';

const AFFILIATE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID = '11111111-aaaa-4aaa-8aaa-111111111111';

function makePool() {
  const state = {
    affiliate: {
      id: AFFILIATE_ID,
      display_name: 'Max',
      normalized_code: 'MAXAGORA',
      status: 'active',
      code_status: 'active',
      is_test: false,
      apple_offer_identifier: 'Affiliate First Month $0.99',
      normalized_apple_offer_identifier: 'AFFILIATE FIRST MONTH $0.99',
    },
    click: null,
    handoff: null,
    superseded: [],
  };

  const client = {
    async query(sql, params = []) {
      const text = String(sql).trim();

      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      if (text.includes('SELECT *') && text.includes('FROM affiliates')) {
        return {
          rows:
            params[0] === state.affiliate.normalized_code
              ? [state.affiliate]
              : [],
          rowCount:
            params[0] === state.affiliate.normalized_code
              ? 1
              : 0,
        };
      }

      if (text.includes('INSERT INTO affiliate_referral_clicks')) {
        state.click = {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          affiliate_id: params[0],
          normalized_code: params[1],
          environment: params[2],
          referrer_host: params[3],
        };
        return { rows: [{ id: state.click.id }], rowCount: 1 };
      }

      if (text.includes('INSERT INTO affiliate_referral_handoffs')) {
        state.handoff = {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          affiliate_id: params[0],
          creator_code: params[1],
          normalized_code: params[1],
          token_hash: params[2],
          environment: params[3],
          referral_click_id: params[4],
          referrer_host: params[5],
          created_at: new Date(),
          expires_at: params[6],
          status: 'pending',
          first_opened_at: null,
          last_opened_at: null,
          open_count: 0,
          redemption_started_at: null,
          last_redemption_started_at: null,
          redemption_start_count: 0,
          installation_id: null,
          account_id: null,
          claimed_at: null,
          attributed_original_transaction_id: null,
        };
        return { rows: [state.handoff], rowCount: 1 };
      }

      if (
        text.includes('FROM affiliate_referral_handoffs handoff') &&
        text.includes('handoff.token_hash = $1')
      ) {
        if (!state.handoff || state.handoff.token_hash !== params[0]) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{
            ...state.handoff,
            display_name: state.affiliate.display_name,
            affiliate_status: state.affiliate.status,
            code_status: state.affiliate.code_status,
            apple_offer_identifier: state.affiliate.apple_offer_identifier,
            normalized_apple_offer_identifier:
              state.affiliate.normalized_apple_offer_identifier,
            is_test: state.affiliate.is_test,
          }],
          rowCount: 1,
        };
      }

      if (
        text.includes('UPDATE affiliate_referral_handoffs') &&
        text.includes('open_count = open_count + 1')
      ) {
        state.handoff.first_opened_at =
          state.handoff.first_opened_at || new Date();
        state.handoff.last_opened_at = new Date();
        state.handoff.open_count += 1;
        return { rows: [state.handoff], rowCount: 1 };
      }

      if (
        text.includes('UPDATE affiliate_referral_handoffs') &&
        text.includes('redemption_start_count = redemption_start_count + 1')
      ) {
        state.handoff.status =
          state.handoff.status === 'pending'
            ? 'redemption_started'
            : state.handoff.status;
        state.handoff.redemption_started_at =
          state.handoff.redemption_started_at || new Date();
        state.handoff.last_redemption_started_at = new Date();
        state.handoff.redemption_start_count += 1;
        return { rows: [state.handoff], rowCount: 1 };
      }

      if (
        text.includes('UPDATE affiliate_referral_handoffs') &&
        text.includes("status = 'superseded'") &&
        text.includes('WHERE id = $1')
      ) {
        state.handoff.status = 'superseded';
        state.handoff.superseded_at = new Date();
        return { rows: [state.handoff], rowCount: 1 };
      }

      if (
        text.includes('UPDATE affiliate_referral_handoffs') &&
        text.includes("status = 'superseded'")
      ) {
        state.superseded.push({
          installationId: params[0],
          winningHandoffId: params[1],
        });
        return { rows: [], rowCount: 0 };
      }

      if (
        text.includes('UPDATE affiliate_referral_handoffs') &&
        text.includes("status = 'attributed'") &&
        text.includes('account_id = $2::uuid')
      ) {
        state.handoff.account_id = params[1];
        return { rows: [state.handoff], rowCount: 1 };
      }

      if (
        text.includes('UPDATE affiliate_referral_handoffs') &&
        text.includes("ELSE 'claimed'")
      ) {
        state.handoff.status = 'claimed';
        state.handoff.installation_id =
          state.handoff.installation_id || params[1];
        state.handoff.account_id =
          state.handoff.account_id || params[2] || null;
        state.handoff.claimed_at =
          state.handoff.claimed_at || new Date();
        return { rows: [state.handoff], rowCount: 1 };
      }

      throw new Error(`Unexpected SQL: ${text}`);
    },
    release() {},
  };

  return {
    state,
    pool: {
      async connect() {
        return client;
      },
    },
  };
}

test('URL builders preserve opaque handoff separately from the Apple custom creator code', () => {
  const token = 'AbCdEf0123456789_-AbCdEf0123456789';
  const clip = new URL(
    buildDefaultAppClipUrl({
      appClipBundleId: 'com.bhernaurd.TheAgora.Clip',
      handoffToken: token,
    })
  );
  assert.equal(clip.hostname, 'appclip.apple.com');
  assert.equal(clip.searchParams.get('p'), 'com.bhernaurd.TheAgora.Clip');
  assert.equal(clip.searchParams.get('handoff'), token);
  assert.equal(clip.searchParams.get('code'), null);

  const redeem = new URL(
    buildAppleOfferRedemptionUrl({
      appAppleId: '6762416967',
      creatorCode: 'maxagora',
    })
  );
  assert.equal(redeem.hostname, 'apps.apple.com');
  assert.equal(redeem.searchParams.get('ctx'), 'offercodes');
  assert.equal(redeem.searchParams.get('id'), '6762416967');
  assert.equal(redeem.searchParams.get('code'), 'MAXAGORA');
});


test('owner TestFlight handoff creation does not inflate referral-click analytics', async () => {
  const { state, pool } = makePool();
  const service = createAffiliateReferralHandoffService({
    pool,
    appAppleId: '6762416967',
    appClipBundleId: 'com.bhernaurd.TheAgora.Clip',
  });

  const created = await service.createForTesting({
    code: 'MAXAGORA',
  });

  assert.equal(state.click, null);
  assert.equal(state.handoff.referral_click_id, null);
  assert.equal(state.handoff.referrer_host, 'admin_testflight');

  const invocation = new URL(created.redirectUrl);
  assert.equal(invocation.hostname, 'appclip.apple.com');
  assert.equal(invocation.searchParams.get('p'), 'com.bhernaurd.TheAgora.Clip');
  assert.ok(created.handoffToken);
  assert.equal(invocation.searchParams.get('handoff'), created.handoffToken);
});


test('referral creates a hashed pending handoff; open does not claim it; redeem-start then claim binds the installation/account', async () => {
  const { state, pool } = makePool();
  const accountAuthService = {
    async authorizeAccessToken({ installationId, accessToken }) {
      assert.equal(installationId, INSTALLATION_ID);
      assert.equal(accessToken, 'valid-access-token');
      return { accountId: ACCOUNT_ID };
    },
  };

  const service = createAffiliateReferralHandoffService({
    pool,
    accountAuthService,
    appAppleId: '6762416967',
    appClipBundleId: 'com.bhernaurd.TheAgora.Clip',
  });

  const created = await service.createForReferral({
    code: 'maxagora',
    referrerHost: 'tiktok.com',
  });

  const clipURL = new URL(created.redirectUrl);
  const rawToken = clipURL.searchParams.get('handoff');
  assert.ok(rawToken);
  assert.match(state.handoff.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(state.handoff.token_hash, rawToken);
  assert.equal(state.handoff.status, 'pending');
  assert.equal(state.handoff.installation_id, null);
  assert.equal(state.handoff.account_id, null);

  const opened = await service.openHandoff(rawToken);
  assert.equal(opened.status, 'pending');
  assert.equal(opened.installationBound, false);
  assert.equal(state.handoff.open_count, 1);

  await assert.rejects(
    service.claimHandoff({
      rawToken,
      installationId: INSTALLATION_ID,
    }),
    error => error?.code === 'affiliate_handoff_not_redeemed'
  );

  const redemption = await service.beginRedemption(rawToken);
  assert.equal(redemption.handoff.status, 'redemption_started');
  assert.equal(
    new URL(redemption.redemptionUrl).searchParams.get('code'),
    'MAXAGORA'
  );

  const claimed = await service.claimHandoff({
    rawToken,
    installationId: INSTALLATION_ID,
    accessToken: 'valid-access-token',
  });

  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.installationBound, true);
  assert.equal(claimed.accountBound, true);
  assert.equal(state.handoff.installation_id, INSTALLATION_ID);
  assert.equal(state.handoff.account_id, ACCOUNT_ID);
  assert.equal(state.superseded.length, 1);
});


test('an already attributed handoff cannot restart Apple redemption', async () => {
  const { state, pool } = makePool();
  const service = createAffiliateReferralHandoffService({
    pool,
    appAppleId: '6762416967',
    appClipBundleId: 'com.bhernaurd.TheAgora.Clip',
  });

  const created = await service.createForTesting({ code: 'MAXAGORA' });
  const rawToken = created.handoffToken;

  state.handoff.status = 'attributed';
  state.handoff.redemption_started_at = new Date();
  state.handoff.last_redemption_started_at = new Date();
  state.handoff.redemption_start_count = 1;
  state.handoff.installation_id = INSTALLATION_ID;
  state.handoff.claimed_at = new Date();
  state.handoff.attributed_original_transaction_id = 'orig-attributed';

  await assert.rejects(
    service.beginRedemption(rawToken),
    error => error?.code === 'affiliate_handoff_already_attributed'
  );
});


test('reclaiming an attributed handoff can bind the same account without superseding a newer pending flow', async () => {
  const { state, pool } = makePool();
  const accountAuthService = {
    async authorizeAccessToken({ installationId, accessToken }) {
      assert.equal(installationId, INSTALLATION_ID);
      assert.equal(accessToken, 'valid-access-token');
      return { accountId: ACCOUNT_ID };
    },
  };
  const service = createAffiliateReferralHandoffService({
    pool,
    accountAuthService,
    appAppleId: '6762416967',
    appClipBundleId: 'com.bhernaurd.TheAgora.Clip',
  });

  const created = await service.createForTesting({ code: 'MAXAGORA' });
  const rawToken = created.handoffToken;

  state.handoff.status = 'attributed';
  state.handoff.redemption_started_at = new Date();
  state.handoff.last_redemption_started_at = new Date();
  state.handoff.redemption_start_count = 1;
  state.handoff.installation_id = INSTALLATION_ID;
  state.handoff.claimed_at = new Date();
  state.handoff.account_id = null;
  state.handoff.attributed_original_transaction_id = 'orig-attributed';

  const claimed = await service.claimHandoff({
    rawToken,
    installationId: INSTALLATION_ID,
    accessToken: 'valid-access-token',
  });

  assert.equal(claimed.status, 'attributed');
  assert.equal(claimed.accountBound, true);
  assert.equal(state.handoff.account_id, ACCOUNT_ID);
  assert.equal(state.superseded.length, 0);
});


test('manual code redemption abandons a pending automatic handoff but never rewrites permanent attribution', async () => {
  const { state, pool } = makePool();
  const service = createAffiliateReferralHandoffService({
    pool,
    appAppleId: '6762416967',
    appClipBundleId: 'com.bhernaurd.TheAgora.Clip',
  });

  const created = await service.createForTesting({ code: 'MAXAGORA' });
  const rawToken = created.handoffToken;
  await service.beginRedemption(rawToken);
  const claimed = await service.claimHandoff({
    rawToken,
    installationId: INSTALLATION_ID,
  });
  assert.equal(claimed.status, 'claimed');

  const abandoned = await service.abandonHandoff({
    rawToken,
    installationId: INSTALLATION_ID,
  });
  assert.equal(abandoned.status, 'superseded');
  assert.equal(state.handoff.status, 'superseded');

  // Permanent ownership is immutable. A stale local token can be cleaned up,
  // but the server must not downgrade an already attributed handoff.
  state.handoff.status = 'attributed';
  state.handoff.superseded_at = null;
  state.handoff.attributed_original_transaction_id = 'orig-permanent';
  const permanent = await service.abandonHandoff({
    rawToken,
    installationId: INSTALLATION_ID,
  });
  assert.equal(permanent.status, 'attributed');
  assert.equal(state.handoff.status, 'attributed');
});
