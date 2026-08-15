import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAffiliateAppleImportPreferencesService,
} from '../lib/affiliateAppleImportPreferencesService.js';

function createMockPool() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/RETURNING \*/.test(sql)) {
        return {
          rows: [{
            normalized_code: params[0],
            disposition: /'ignored'/.test(sql) ? 'ignored' : 'pending',
            canonical_offer_id: params[1] || null,
            canonical_custom_code_id: params[2] || null,
          }],
        };
      }
      if (/SELECT\s+normalized_code/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

test('canonical selection is persisted by normalized creator code and audited', async () => {
  const pool = createMockPool();
  const service = createAffiliateAppleImportPreferencesService({ pool });

  await service.selectCanonical({
    customCode: 'maxagora',
    offerId: 'offer-1',
    customCodeId: 'max-new',
    actor: 'owner_admin',
  });

  assert.equal(pool.calls.length, 2);
  assert.equal(pool.calls[0].params[0], 'MAXAGORA');
  assert.match(pool.calls[0].sql, /canonical_offer_id/);
  assert.match(pool.calls[1].sql, /affiliate_apple_import_canonical_selected/);
});

test('ignoring a creator code is non-destructive and separately audited', async () => {
  const pool = createMockPool();
  const service = createAffiliateAppleImportPreferencesService({ pool });

  await service.ignoreCode({ customCode: 'BHERNAURD', actor: 'owner_admin' });

  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].sql, /disposition = 'ignored'/);
  assert.match(pool.calls[1].sql, /affiliate_apple_import_ignored/);
  assert.doesNotMatch(pool.calls[0].sql, /DELETE FROM/i);
});
