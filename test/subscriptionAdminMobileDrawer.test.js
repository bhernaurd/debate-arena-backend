import test from 'node:test';
import assert from 'node:assert/strict';

import { enhanceSubscriptionAdminMobileHtml } from '../lib/subscriptionAdminMobileUi.js';

test('mobile subscriber drawer is forced into a single full-width column', () => {
  const source = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /><style></style></head><body><div class="shell"></div></body></html>`;
  const html = enhanceSubscriptionAdminMobileHtml(source);

  assert.match(html, /\.drawerback\.open \.drawer\{display:block!important/);
  assert.match(html, /\.drawer>\.drawerhead\{display:flex!important/);
  assert.match(html, /\.drawer>\.detailgrid,\.drawer>\.timeline\{width:100%!important/);
  assert.match(html, /\.drawerhead \.sub\{[^}]*text-overflow:ellipsis/);
  assert.match(html, /\.detail span\{[^}]*overflow-wrap:anywhere/);
});
