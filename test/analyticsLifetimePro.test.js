import assert from 'node:assert/strict';
import test from 'node:test';

import { isEntitlementUsable } from '../analytics.js';

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

test('active Lifetime Pro is usable without an expiration date', () => {
  assert.equal(
    isEntitlementUsable({
      product_id: 'agora_pro_lifetime',
      is_lifetime_pro: true,
      status: 'active',
      revocation_date: null,
      expires_date: null,
      grace_period_expires_date: null,
    }),
    true
  );
});

test('revoked Lifetime Pro is not usable', () => {
  assert.equal(
    isEntitlementUsable({
      product_id: 'agora_pro_lifetime',
      is_lifetime_pro: true,
      status: 'active',
      revocation_date: new Date().toISOString(),
      expires_date: null,
      grace_period_expires_date: null,
    }),
    false
  );
});

test('recurring Pro still requires a future expiration', () => {
  assert.equal(
    isEntitlementUsable({
      product_id: 'agora_pro_monthly',
      is_lifetime_pro: false,
      status: 'active',
      revocation_date: null,
      expires_date: FUTURE,
      grace_period_expires_date: null,
    }),
    true
  );

  assert.equal(
    isEntitlementUsable({
      product_id: 'agora_pro_monthly',
      is_lifetime_pro: false,
      status: 'active',
      revocation_date: null,
      expires_date: PAST,
      grace_period_expires_date: null,
    }),
    false
  );
});
