import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('subscription admin manifest requests standalone mode and PNG install icons', () => {
  const manifest = JSON.parse(fs.readFileSync('public/subscription-admin.webmanifest', 'utf8'));
  assert.equal(manifest.id, '/subscription-admin');
  assert.equal(manifest.start_url, '/subscription-admin');
  assert.equal(manifest.scope, '/subscription-admin');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.display_override, ['standalone']);
  assert.deepEqual(manifest.icons, [
    {
      src: '/subscription-admin-icon-192.png?v=6',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: '/subscription-admin-icon-512.png?v=6',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    },
  ]);
  for (const icon of [
    'public/apple-touch-icon.png',
    'public/subscription-admin-icon.png',
    'public/subscription-admin-icon-192.png',
    'public/subscription-admin-icon-512.png',
  ]) {
    const png = fs.readFileSync(icon);
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  }
});
