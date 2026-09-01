import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('history tracks month-end subscriptions separately from Lifetime Pro', () => {
  const source = fs.readFileSync(new URL('../lib/subscriptionAdminHistoryService.js', import.meta.url), 'utf8');
  assert.match(source, /activeSubscriptionsAtMonthEnd: null/);
  assert.match(source, /AS active_subscriptions_at_month_end/);
  assert.match(source, /product_id IN \('agora_pro_monthly', 'agora_pro_yearly'\)/);
  assert.match(source, /activeSubscriptionsAtMonthEnd = numberValue\(row\.active_subscriptions_at_month_end\)/);
});

test('history counts each recurring customer once in the month their relationship begins', () => {
  const source = fs.readFileSync(new URL('../lib/subscriptionAdminHistoryService.js', import.meta.url), 'utf8');
  assert.match(source, /first_relationship AS/);
  assert.match(source, /'new_subscriber'::text AS kind FROM first_relationship/);
  assert.match(source, /AS new_subscribers/);
  assert.match(source, /month\.newSubscribers \+= numberValue\(row\.new_subscribers\)/);
});
