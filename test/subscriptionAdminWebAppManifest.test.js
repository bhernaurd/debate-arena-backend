import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('subscription admin manifest requests standalone mode and dedicated SVG icon', () => {
  const manifest = JSON.parse(fs.readFileSync('public/subscription-admin.webmanifest', 'utf8'));
  assert.equal(manifest.start_url, '/subscription-admin/');
  assert.equal(manifest.scope, '/subscription-admin/');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.display_override, ['standalone']);
  assert.deepEqual(manifest.icons, [{
    src: '/subscription-admin-icon.svg?v=5',
    sizes: 'any',
    type: 'image/svg+xml',
    purpose: 'any',
  }]);
  const svg = fs.readFileSync('public/subscription-admin-icon.svg', 'utf8');
  assert.match(svg, /<svg/);
  assert.match(svg, /Agora Admin/);
  assert.match(svg, /#DDB65A/);
});
