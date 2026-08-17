import crypto from 'node:crypto';

const CODE_RE = /^[A-Z0-9]{2,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,192}$/;
const INSTALLATION_RE = /^[A-Za-z0-9-]{8,128}$/;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function fail(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.status = statusCode;
  error.code = code;
  return error;
}

function normalizeCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!CODE_RE.test(code)) {
    throw fail(400, 'invalid_affiliate_code', 'Invalid creator code.');
  }
  return code;
}

function requireToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!TOKEN_RE.test(token)) {
    throw fail(404, 'affiliate_handoff_not_found', 'This creator offer is unavailable.');
  }
  return token;
}

function requireInstallationId(value) {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!INSTALLATION_RE.test(clean)) {
    throw fail(401, 'invalid_installation_id', 'A valid installation ID is required.');
  }
  return clean;
}

function cleanHost(value) {
  const clean = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return clean ? clean.slice(0, 255) : null;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function createOpaqueToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function cleanAppClipBundleId(value) {
  const clean = String(value || '').trim();
  if (!/^[A-Za-z0-9.-]{3,255}$/.test(clean)) {
    throw fail(
      500,
      'affiliate_app_clip_bundle_id_invalid',
      'AFFILIATE_APP_CLIP_BUNDLE_ID is not configured correctly.'
    );
  }
  return clean;
}

function cleanAppAppleId(value) {
  const clean = String(value || '').trim();
  if (!/^\d{5,20}$/.test(clean)) {
    throw fail(
      500,
      'affiliate_apple_app_id_invalid',
      'AFFILIATE_APPLE_APP_ID is not configured correctly.'
    );
  }
  return clean;
}

export function buildDefaultAppClipUrl({ appClipBundleId, handoffToken } = {}) {
  const bundleId = cleanAppClipBundleId(appClipBundleId);
  const token = requireToken(handoffToken);
  const url = new URL('https://appclip.apple.com/id');
  url.searchParams.set('p', bundleId);
  url.searchParams.set('handoff', token);
  return url.toString();
}

export function buildAppleOfferRedemptionUrl({ appAppleId, creatorCode } = {}) {
  const appleId = cleanAppAppleId(appAppleId);
  const code = normalizeCode(creatorCode);
  const url = new URL('https://apps.apple.com/redeem');
  url.searchParams.set('ctx', 'offercodes');
  url.searchParams.set('id', appleId);
  url.searchParams.set('code', code);
  return url.toString();
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function publicHandoff(row) {
  return {
    id: row.id,
    creatorCode: row.normalized_code,
    status: row.status,
    expiresAt: row.expires_at,
    accountBound: Boolean(row.account_id),
    installationBound: Boolean(row.installation_id),
  };
}

export function createAffiliateReferralHandoffService({
  pool,
  accountAuthService = null,
  appAppleId,
  appClipBundleId = 'com.bhernaurd.TheAgora.Clip',
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('Affiliate referral handoff service requires a PostgreSQL pool.');
  }

  const safeTtlMs = Number(ttlMs);
  if (!Number.isFinite(safeTtlMs) || safeTtlMs < 60_000) {
    throw new Error('Affiliate referral handoff ttlMs must be at least one minute.');
  }

  const cleanBundleId = cleanAppClipBundleId(appClipBundleId);
  const cleanAppleId = cleanAppAppleId(appAppleId);

  async function loadByToken(client, rawToken, { forUpdate = false } = {}) {
    const hash = tokenHash(requireToken(rawToken));
    const result = await client.query(
      `
      SELECT
        handoff.*,
        affiliate.display_name,
        affiliate.status AS affiliate_status,
        affiliate.code_status,
        affiliate.apple_offer_identifier,
        affiliate.normalized_apple_offer_identifier,
        affiliate.is_test
      FROM affiliate_referral_handoffs handoff
      JOIN affiliates affiliate
        ON affiliate.id = handoff.affiliate_id
      WHERE handoff.token_hash = $1
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE OF handoff' : ''}
      `,
      [hash]
    );
    return result.rows[0] || null;
  }

  function requireUsable(row, { requireRedemptionStart = false } = {}) {
    if (!row) {
      throw fail(404, 'affiliate_handoff_not_found', 'This creator offer is unavailable.');
    }
    if (row.status === 'superseded') {
      throw fail(409, 'affiliate_handoff_superseded', 'A newer creator offer is active on this device.');
    }
    if (row.status === 'expired' || new Date(row.expires_at).getTime() <= Date.now()) {
      throw fail(410, 'affiliate_handoff_expired', 'This creator offer link has expired.');
    }
    if (row.affiliate_status !== 'active' || row.code_status !== 'active') {
      throw fail(409, 'affiliate_handoff_inactive', 'This creator offer is no longer active.');
    }
    if (requireRedemptionStart && !row.redemption_started_at) {
      throw fail(409, 'affiliate_handoff_not_redeemed', 'Continue with Apple before installing the full app.');
    }
    return row;
  }

  async function createHandoff({
    code,
    referrerHost = null,
    recordReferralClick = true,
  } = {}) {
    const normalizedCode = normalizeCode(code);
    const rawToken = createOpaqueToken();
    const hash = tokenHash(rawToken);
    const expiresAt = new Date(Date.now() + safeTtlMs);
    const host = cleanHost(referrerHost);

    const result = await withTransaction(pool, async (client) => {
      const affiliateResult = await client.query(
        `
        SELECT *
        FROM affiliates
        WHERE normalized_code = $1
        LIMIT 1
        `,
        [normalizedCode]
      );
      const affiliate = affiliateResult.rows[0] || null;
      if (!affiliate || affiliate.status !== 'active' || affiliate.code_status !== 'active') {
        throw fail(404, 'affiliate_referral_not_active', 'Referral link is not active.');
      }

      let referralClickId = null;
      if (recordReferralClick) {
        const clickResult = await client.query(
          `
          INSERT INTO affiliate_referral_clicks (
            affiliate_id,
            normalized_code,
            environment,
            referrer_host
          )
          VALUES ($1, $2, $3, $4)
          RETURNING id
          `,
          [
            affiliate.id,
            affiliate.normalized_code,
            affiliate.is_test ? 'test' : 'production',
            host,
          ]
        );
        referralClickId = clickResult.rows[0]?.id || null;
      }

      const handoffResult = await client.query(
        `
        INSERT INTO affiliate_referral_handoffs (
          affiliate_id,
          creator_code,
          normalized_code,
          token_hash,
          environment,
          referral_click_id,
          referrer_host,
          expires_at
        )
        VALUES ($1, $2, $2, $3, $4, $5, $6, $7)
        RETURNING *
        `,
        [
          affiliate.id,
          affiliate.normalized_code,
          hash,
          affiliate.is_test ? 'test' : 'production',
          referralClickId,
          host,
          expiresAt,
        ]
      );

      return { affiliate, handoff: handoffResult.rows[0] };
    });

    return {
      affiliate: result.affiliate,
      handoff: publicHandoff(result.handoff),
      handoffToken: rawToken,
      redirectUrl: buildDefaultAppClipUrl({
        appClipBundleId: cleanBundleId,
        handoffToken: rawToken,
      }),
    };
  }

  async function createForReferral({ code, referrerHost = null } = {}) {
    return createHandoff({
      code,
      referrerHost,
      recordReferralClick: true,
    });
  }

  // Owner-only pre-release helper. It creates a real handoff token for
  // TestFlight/App Clip invocation testing without inflating referral-click
  // analytics. It never creates commission by itself.
  async function createForTesting({ code } = {}) {
    return createHandoff({
      code,
      referrerHost: 'admin_testflight',
      recordReferralClick: false,
    });
  }

  async function openHandoff(rawToken) {
    return withTransaction(pool, async (client) => {
      const row = requireUsable(await loadByToken(client, rawToken, { forUpdate: true }));
      const result = await client.query(
        `
        UPDATE affiliate_referral_handoffs
        SET
          first_opened_at = COALESCE(first_opened_at, NOW()),
          last_opened_at = NOW(),
          open_count = open_count + 1,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [row.id]
      );
      return publicHandoff({ ...row, ...result.rows[0] });
    });
  }

  async function beginRedemption(rawToken) {
    return withTransaction(pool, async (client) => {
      const row = requireUsable(await loadByToken(client, rawToken, { forUpdate: true }));

      if (row.status === 'attributed') {
        throw fail(
          409,
          'affiliate_handoff_already_attributed',
          'This creator offer has already been completed.'
        );
      }

      const result = await client.query(
        `
        UPDATE affiliate_referral_handoffs
        SET
          status = CASE
            WHEN status = 'pending' THEN 'redemption_started'
            ELSE status
          END,
          redemption_started_at = COALESCE(redemption_started_at, NOW()),
          last_redemption_started_at = NOW(),
          redemption_start_count = redemption_start_count + 1,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [row.id]
      );

      const updated = { ...row, ...result.rows[0] };
      return {
        handoff: publicHandoff(updated),
        redemptionUrl: buildAppleOfferRedemptionUrl({
          appAppleId: cleanAppleId,
          creatorCode: updated.normalized_code,
        }),
      };
    });
  }

  async function authorizeOptionalAccount({ installationId, accessToken }) {
    const cleanToken = typeof accessToken === 'string' ? accessToken.trim() : '';
    if (!cleanToken) return null;
    if (!accountAuthService || typeof accountAuthService.authorizeAccessToken !== 'function') {
      throw fail(503, 'affiliate_handoff_account_binding_unavailable', 'Account binding is temporarily unavailable.');
    }
    try {
      return await accountAuthService.authorizeAccessToken({
        installationId,
        accessToken: cleanToken,
      });
    } catch (error) {
      throw fail(
        Number.isInteger(error?.status) ? error.status : 401,
        error?.code || 'invalid_account_session',
        error?.message || 'The Agora account session is invalid or expired.'
      );
    }
  }

  async function abandonHandoff({ rawToken, installationId } = {}) {
    const cleanInstallationId = requireInstallationId(installationId);

    return withTransaction(pool, async (client) => {
      const row = await loadByToken(client, rawToken, { forUpdate: true });

      if (!row) {
        throw fail(404, 'affiliate_handoff_not_found', 'This creator offer is unavailable.');
      }

      if (row.installation_id && row.installation_id !== cleanInstallationId) {
        throw fail(
          409,
          'affiliate_handoff_device_conflict',
          'This creator offer is already bound to another installation.'
        );
      }

      // Permanent subscription-chain ownership is immutable. Abandoning a
      // still-local token after attribution is therefore only a client cleanup
      // operation and must not change the canonical row.
      if (row.status === 'attributed') {
        return publicHandoff(row);
      }

      // Already terminal rows are idempotent for cleanup. Expired rows cannot
      // participate in automatic attribution because purchase time must be
      // inside the handoff validity window.
      if (row.status === 'superseded' || row.status === 'expired') {
        return publicHandoff(row);
      }

      const result = await client.query(
        `
        UPDATE affiliate_referral_handoffs
        SET
          status = 'superseded',
          superseded_at = NOW(),
          superseded_by_handoff_id = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND attributed_original_transaction_id IS NULL
          AND status IN ('pending', 'redemption_started', 'claimed')
        RETURNING *
        `,
        [row.id]
      );

      return publicHandoff({
        ...row,
        ...(result.rows[0] || {}),
      });
    });
  }

  async function claimHandoff({ rawToken, installationId, accessToken = null } = {}) {
    const cleanInstallationId = requireInstallationId(installationId);
    const authorization = await authorizeOptionalAccount({
      installationId: cleanInstallationId,
      accessToken,
    });

    return withTransaction(pool, async (client) => {
      const row = requireUsable(
        await loadByToken(client, rawToken, { forUpdate: true }),
        { requireRedemptionStart: true }
      );

      if (row.installation_id && row.installation_id !== cleanInstallationId) {
        throw fail(409, 'affiliate_handoff_device_conflict', 'This creator offer is already bound to another installation.');
      }
      if (row.account_id && authorization?.accountId && row.account_id !== authorization.accountId) {
        throw fail(409, 'affiliate_handoff_account_conflict', 'This creator offer is already bound to another Agora account.');
      }

      if (row.status === 'attributed') {
        // An already-consumed handoff is idempotent evidence. It may still bind
        // the same installation's Agora account after sign-in, but it must never
        // supersede a newer pending redemption path.
        if (authorization?.accountId && !row.account_id) {
          const bound = await client.query(
            `
            UPDATE affiliate_referral_handoffs
            SET
              account_id = $2::uuid,
              updated_at = NOW()
            WHERE id = $1
              AND status = 'attributed'
              AND installation_id = $3
              AND account_id IS NULL
            RETURNING *
            `,
            [row.id, authorization.accountId, cleanInstallationId]
          );

          return publicHandoff({
            ...row,
            ...(bound.rows[0] || {}),
          });
        }

        return publicHandoff(row);
      }

      // The newest successfully claimed redemption path wins among still-pending
      // handoffs on this installation. Permanently attributed handoffs are never
      // changed or superseded.
      await client.query(
        `
        UPDATE affiliate_referral_handoffs
        SET
          status = 'superseded',
          superseded_at = NOW(),
          superseded_by_handoff_id = $2,
          updated_at = NOW()
        WHERE installation_id = $1
          AND id <> $2
          AND attributed_original_transaction_id IS NULL
          AND status IN ('redemption_started', 'claimed')
        `,
        [cleanInstallationId, row.id]
      );

      const result = await client.query(
        `
        UPDATE affiliate_referral_handoffs
        SET
          status = CASE
            WHEN status = 'attributed' THEN status
            ELSE 'claimed'
          END,
          installation_id = COALESCE(installation_id, $2),
          account_id = COALESCE(account_id, $3::uuid),
          claimed_at = COALESCE(claimed_at, NOW()),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [row.id, cleanInstallationId, authorization?.accountId || null]
      );

      return publicHandoff({ ...row, ...result.rows[0] });
    });
  }

  return Object.freeze({
    createForReferral,
    createForTesting,
    openHandoff,
    beginRedemption,
    abandonHandoff,
    claimHandoff,
  });
}
