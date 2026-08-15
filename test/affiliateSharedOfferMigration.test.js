import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'migrations', '022_affiliate_shared_offer_account_attribution.sql'), 'utf8');

test('migration 022 removes one-offer-per-affiliate uniqueness without deleting affiliate history', () => {
  assert.match(sql, /DROP INDEX IF EXISTS affiliates_offer_identifier_unique_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS affiliates_offer_identifier_lookup_idx/);
  assert.doesNotMatch(sql, /DELETE FROM affiliates/i);
  assert.doesNotMatch(sql, /TRUNCATE/i);
});

test('migration 022 creates account creator-code evidence and keeps chain ownership keyed separately', () => {
  assert.match(sql, /CREATE TABLE affiliate_account_referrals/);
  assert.match(sql, /account_id UUID PRIMARY KEY/);
  assert.match(sql, /ADD COLUMN account_id UUID/);
  assert.match(sql, /ADD COLUMN creator_code TEXT/);
  assert.match(sql, /ADD COLUMN normalized_creator_code TEXT/);
  assert.match(sql, /'account_creator_code'/);
});
