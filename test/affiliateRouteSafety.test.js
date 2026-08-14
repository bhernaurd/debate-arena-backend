import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(
  fileURLToPath(import.meta.url)
);
const repositoryRoot = path.resolve(testDirectory, '..');
const source = fs.readFileSync(
  path.join(repositoryRoot, 'affiliateRoutes.js'),
  'utf8'
);

test('admin affiliate creation distinguishes duplicate creator codes from duplicate Apple offer references', () => {
  assert.match(
    source,
    /affiliates_offer_identifier_unique_idx[\s\S]*?affiliate_offer_identifier_already_exists/
  );
  assert.match(
    source,
    /affiliates_normalized_code_unique[\s\S]*?affiliate_code_already_exists/
  );
});


test('partner dashboard stays read-only and presents anonymous subscriber activity', () => {
  assert.match(source, /Anonymous Subscriber Activity/);
  assert.match(source, /Subscriber<\/th>/);
  assert.match(source, /Commission-Earning Subscribers/);
  assert.match(source, /Eligible Revenue Generated/);
  assert.doesNotMatch(source, /Search creators/i);
  assert.doesNotMatch(source, /document\.cookie/);
});
