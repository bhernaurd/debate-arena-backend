import test from 'node:test';
import assert from 'node:assert/strict';
import { createGooglePlayTokenVault } from '../lib/googlePlayTokenVault.js';

test('token vault is disabled without an encryption key', async () => {
  const vault = createGooglePlayTokenVault({ pool: { query: async () => { throw new Error('must not query'); } }, keyHex: '' });
  assert.equal(vault.enabled, false);
  assert.equal(await vault.save({ token: 'secret', hash: 'a'.repeat(64) }), false);
  assert.deepEqual(await vault.candidates(), []);
});

test('token vault encrypts purchase tokens and decrypts only with matching hash', async () => {
  const token = 'a-sensitive-google-purchase-token';
  const hash = 'a'.repeat(64);
  let ciphertext;
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push(sql);
      if (sql.includes('INSERT INTO google_play_reconciliation_tokens')) {
        ciphertext = values[1];
        assert.notEqual(ciphertext, token);
        assert.equal(ciphertext.includes(token), false);
        assert.equal(values[0], hash);
        return { rowCount: 1 };
      }
      return { rows: [{
        purchase_token_sha256: hash,
        encrypted_purchase_token: ciphertext,
        account_id: '00000000-0000-4000-8000-000000000000',
        product_id: 'agora_pro_yearly',
        package_name: 'com.bhernaurd.theagora',
        pricing_cohort: 'standard',
        pricing_cohort_paywall_session_id: null,
      }] };
    },
  };
  const vault = createGooglePlayTokenVault({ pool, keyHex: 'fe'.repeat(32) });
  await vault.save({
    token, hash, accountId: '00000000-0000-4000-8000-000000000000',
    productId: 'agora_pro_yearly', testPurchase: false,
  });
  const rows = await vault.candidates();
  assert.equal(rows[0].purchaseToken, token);
  assert.ok(queries.some(sql => sql.includes('JOIN google_play_subscription_entitlements')));
});
