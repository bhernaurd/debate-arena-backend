import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(
  path.join(root, 'migrations', '023_affiliate_referral_handoffs.sql'),
  'utf8'
);

test('migration 023 adds auditable referral handoffs without rewriting prior migrations or payout history', () => {
  assert.match(sql, /CREATE TABLE affiliate_referral_handoffs/);
  assert.match(sql, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(sql, /redemption_started_at TIMESTAMPTZ/);
  assert.match(sql, /installation_id TEXT/);
  assert.match(sql, /account_id UUID/);
  assert.match(sql, /attributed_original_transaction_id TEXT/);
  assert.match(sql, /ADD COLUMN referral_handoff_id UUID/);
  assert.match(sql, /ADD COLUMN attribution_installation_id TEXT/);
  assert.match(sql, /'referral_handoff'/);
  assert.doesNotMatch(sql, /DELETE FROM affiliate_subscription_attributions/i);
  assert.doesNotMatch(sql, /TRUNCATE/i);
});

test('migration 023 stores only a one-way token hash and preserves permanent subscription-chain ownership', () => {
  assert.match(sql, /token_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.doesNotMatch(sql, /\braw_token\b/i);
  assert.match(sql, /original_transaction_id/);
  assert.match(sql, /environment/);
  assert.match(sql, /status IN \([\s\S]*?'attributed'/);
});
