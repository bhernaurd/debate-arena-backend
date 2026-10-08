const CREATOR_OFFER_ID = 'creator-seven-day-trial';

function clean(value, max = 255) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text.length > max) return null;
  return text;
}

export function createAffiliateGooglePlayAttributionService({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('Google Play affiliate attribution service requires a PostgreSQL pool.');
  }

  async function loadCurrentAttribution(client, purchaseTokenSha256) {
    const result = await client.query(
      `
      SELECT *
      FROM affiliate_google_play_subscription_attributions
      WHERE purchase_token_sha256 = $1
      LIMIT 1
      `,
      [purchaseTokenSha256]
    );
    return result.rows[0] || null;
  }

  async function loadLinkedAttribution(client, linkedPurchaseTokenSha256) {
    if (!linkedPurchaseTokenSha256) return null;
    const result = await client.query(
      `
      SELECT *
      FROM affiliate_google_play_subscription_attributions
      WHERE purchase_token_sha256 = $1
      LIMIT 1
      `,
      [linkedPurchaseTokenSha256]
    );
    return result.rows[0] || null;
  }

  async function loadAccountClaim(client, accountId) {
    const result = await client.query(
      `
      SELECT
        claim.affiliate_id,
        claim.creator_code,
        claim.normalized_code,
        affiliate.status,
        affiliate.code_status
      FROM affiliate_account_referrals claim
      JOIN affiliates affiliate
        ON affiliate.id = claim.affiliate_id
      WHERE claim.account_id = $1
      LIMIT 1
      `,
      [accountId]
    );
    return result.rows[0] || null;
  }

  async function recordVerifiedPurchase({
    client,
    accountId,
    purchaseTokenSha256,
    linkedPurchaseTokenSha256 = null,
    verifiedOfferId = null,
    productId,
    basePlanId = null,
    latestOrderId = null,
    isTrial = false,
    testPurchase = false,
    autoRenewEnabled = null,
    normalizedStatus = null,
    attributedAt,
    billingEventAt = null,
  } = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('Google Play affiliate attribution requires a transaction client.');
    }

    const current = await loadCurrentAttribution(client, purchaseTokenSha256);
    let attribution = current;

    if (!attribution) {
      const linked = await loadLinkedAttribution(client, linkedPurchaseTokenSha256);

      if (linked) {
        const inserted = await client.query(
          `
          INSERT INTO affiliate_google_play_subscription_attributions (
            purchase_token_sha256,
            affiliate_id,
            account_id,
            creator_code,
            normalized_creator_code,
            attribution_offer_id,
            attribution_source,
            inherited_from_purchase_token_sha256,
            root_purchase_token_sha256,
            product_id,
            base_plan_id,
            attributed_at,
            first_observed_at,
            last_observed_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            'linked_google_play_purchase',
            $7, $8, $9, $10, $11, $11, $11, $11
          )
          ON CONFLICT (purchase_token_sha256) DO NOTHING
          RETURNING *
          `,
          [
            purchaseTokenSha256,
            linked.affiliate_id,
            accountId,
            linked.creator_code,
            linked.normalized_creator_code,
            linked.attribution_offer_id,
            linkedPurchaseTokenSha256,
            linked.root_purchase_token_sha256 || linkedPurchaseTokenSha256,
            productId,
            basePlanId,
            attributedAt,
          ]
        );
        attribution = inserted.rows[0] || await loadCurrentAttribution(client, purchaseTokenSha256);
      } else if (clean(verifiedOfferId, 255) === CREATOR_OFFER_ID) {
        const claim = await loadAccountClaim(client, accountId);
        if (
          claim &&
          claim.status === 'active' &&
          claim.code_status === 'active'
        ) {
          const inserted = await client.query(
            `
            INSERT INTO affiliate_google_play_subscription_attributions (
              purchase_token_sha256,
              affiliate_id,
              account_id,
              creator_code,
              normalized_creator_code,
              attribution_offer_id,
              attribution_source,
              root_purchase_token_sha256,
              product_id,
              base_plan_id,
              attributed_at,
              first_observed_at,
              last_observed_at,
              updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6,
              'account_creator_code',
              $7, $8, $9, $10, $10, $10, $10
            )
            ON CONFLICT (purchase_token_sha256) DO NOTHING
            RETURNING *
            `,
            [
              purchaseTokenSha256,
              claim.affiliate_id,
              accountId,
              claim.creator_code,
              claim.normalized_code,
              CREATOR_OFFER_ID,
              purchaseTokenSha256,
              productId,
              basePlanId,
              attributedAt,
            ]
          );
          attribution = inserted.rows[0] || await loadCurrentAttribution(client, purchaseTokenSha256);
        }
      }
    }

    if (!attribution) {
      return Object.freeze({
        attributed: false,
        billingEventCreated: false,
      });
    }

    await client.query(
      `
      UPDATE affiliate_google_play_subscription_attributions
      SET
        product_id = COALESCE($2, product_id),
        base_plan_id = COALESCE($3, base_plan_id),
        last_observed_at = $4,
        updated_at = $4
      WHERE purchase_token_sha256 = $1
      `,
      [purchaseTokenSha256, productId, basePlanId, attributedAt]
    );

    let billingEventCreated = false;
    const orderId = clean(latestOrderId, 255);
    if (orderId) {
      const eventResult = await client.query(
        `
        INSERT INTO affiliate_google_play_billing_events (
          affiliate_id,
          account_id,
          purchase_token_sha256,
          event_key,
          google_order_id,
          product_id,
          base_plan_id,
          offer_id,
          event_type,
          event_at,
          test_purchase,
          auto_renew_enabled,
          normalized_status,
          observed_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14
        )
        ON CONFLICT (event_key) DO NOTHING
        RETURNING id
        `,
        [
          attribution.affiliate_id,
          accountId,
          purchaseTokenSha256,
          'order:' + orderId,
          orderId,
          productId,
          basePlanId,
          verifiedOfferId,
          isTrial ? 'trial_start' : 'paid_order',
          billingEventAt || attributedAt,
          Boolean(testPurchase),
          autoRenewEnabled,
          normalizedStatus,
          attributedAt,
        ]
      );
      billingEventCreated = Boolean(eventResult.rows[0]);
    }

    return Object.freeze({
      attributed: true,
      affiliateId: attribution.affiliate_id,
      creatorCode: attribution.normalized_creator_code,
      attributionSource: attribution.attribution_source,
      billingEventCreated,
    });
  }

  async function recordVoidedPurchase({
    purchaseTokenSha256,
    googleOrderId,
    eventAt,
  } = {}) {
    const orderId = clean(googleOrderId, 255);
    if (!purchaseTokenSha256 || !orderId) {
      return Object.freeze({
        attributed: false,
        billingEventCreated: false,
      });
    }

    const result = await pool.query(
      `
      WITH owned AS (
        SELECT
          attribution.affiliate_id,
          attribution.account_id,
          entitlement.product_id,
          entitlement.base_plan_id,
          entitlement.offer_id,
          entitlement.test_purchase,
          entitlement.auto_renew_enabled,
          entitlement.normalized_status
        FROM affiliate_google_play_subscription_attributions attribution
        JOIN google_play_subscription_entitlements entitlement
          ON entitlement.purchase_token_sha256 =
             attribution.purchase_token_sha256
        WHERE attribution.purchase_token_sha256 = $1
        LIMIT 1
      )
      INSERT INTO affiliate_google_play_billing_events (
        affiliate_id,
        account_id,
        purchase_token_sha256,
        event_key,
        google_order_id,
        product_id,
        base_plan_id,
        offer_id,
        event_type,
        event_at,
        test_purchase,
        auto_renew_enabled,
        normalized_status,
        observed_at
      )
      SELECT
        affiliate_id,
        account_id,
        $1,
        $2,
        $3,
        product_id,
        base_plan_id,
        offer_id,
        'reversal',
        $4,
        test_purchase,
        auto_renew_enabled,
        normalized_status,
        NOW()
      FROM owned
      ON CONFLICT (event_key) DO NOTHING
      RETURNING affiliate_id, test_purchase
      `,
      [
        purchaseTokenSha256,
        'reversal:' + orderId,
        orderId,
        eventAt,
      ]
    );

    const row = result.rows[0];
    return Object.freeze({
      attributed: Boolean(row),
      affiliateId: row?.affiliate_id || null,
      testPurchase: Boolean(row?.test_purchase),
      billingEventCreated: Boolean(row),
    });
  }

  return Object.freeze({
    recordVerifiedPurchase,
    recordVoidedPurchase,
  });
}

export { CREATOR_OFFER_ID };
