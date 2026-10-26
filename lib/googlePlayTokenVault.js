import crypto from 'node:crypto';

// AES-256-GCM, with the purchase-token hash used as associated data.
export function createGooglePlayTokenVault({ pool, keyHex = process.env.GOOGLE_PLAY_RECONCILIATION_KEY } = {}) {
  const key = /^[a-f0-9]{64}$/i.test(keyHex || '') ? Buffer.from(keyHex, 'hex') : null;
  const enabled = Boolean(key && pool);
  function seal(token, hash) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(hash));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [nonce, cipher.getAuthTag(), encrypted].map(x => x.toString('base64')).join('.');
  }
  function open(sealed, hash) {
    const parts = String(sealed).split('.');
    if (parts.length !== 3) throw new Error('Invalid encrypted purchase token');
    const [nonce, tag, encrypted] = parts.map(x => Buffer.from(x, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(hash));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
  async function save({ token, hash, accountId, productId, testPurchase }) {
    if (!enabled) return false;
    await pool.query(`
      INSERT INTO google_play_reconciliation_tokens
        (purchase_token_sha256, encrypted_purchase_token, account_id, product_id, test_purchase, last_seen_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (purchase_token_sha256) DO UPDATE SET
        encrypted_purchase_token = EXCLUDED.encrypted_purchase_token,
        account_id = EXCLUDED.account_id,
        product_id = EXCLUDED.product_id,
        test_purchase = EXCLUDED.test_purchase,
        last_seen_at = NOW()
    `, [hash, seal(token, hash), accountId, productId, testPurchase]);
    return true;
  }
  async function candidates(limit = 250) {
    if (!enabled) return [];
    const result = await pool.query(`
      SELECT vault.purchase_token_sha256, vault.encrypted_purchase_token,
             vault.account_id, vault.product_id, ent.package_name,
             ent.pricing_cohort, ent.pricing_cohort_paywall_session_id
      FROM google_play_reconciliation_tokens vault
      JOIN google_play_subscription_entitlements ent
        ON ent.purchase_token_sha256 = vault.purchase_token_sha256
       AND ent.account_id = vault.account_id
      WHERE ent.expires_date > NOW() - INTERVAL '30 days'
        AND vault.test_purchase = FALSE
      ORDER BY ent.last_verified_at ASC NULLS FIRST
      LIMIT $1
    `, [limit]);
    return result.rows.map(row => ({
      ...row,
      purchaseToken: open(row.encrypted_purchase_token, row.purchase_token_sha256),
    }));
  }
  return Object.freeze({ enabled, save, candidates });
}
