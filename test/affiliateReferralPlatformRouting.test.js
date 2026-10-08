import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGooglePlayListingUrl,
  classifyAffiliateReferralPlatform,
  renderReferralStoreLandingPage,
} from '../affiliateRoutes.js';

test('classifies Android referral traffic from user agent or client hint', () => {
  assert.equal(
    classifyAffiliateReferralPlatform({
      userAgent:
        'Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 Chrome/153 Mobile Safari/537.36',
    }),
    'android'
  );

  assert.equal(
    classifyAffiliateReferralPlatform({
      userAgent: 'Mozilla/5.0',
      clientPlatform: '"Android"',
    }),
    'android'
  );
});

test('classifies iPhone and iPad referral traffic as iOS', () => {
  assert.equal(
    classifyAffiliateReferralPlatform({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile Safari/604.1',
    }),
    'ios'
  );

  assert.equal(
    classifyAffiliateReferralPlatform({
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile Safari/604.1',
    }),
    'ios'
  );
});

test('desktop and unknown referral traffic stays on the store-choice path', () => {
  assert.equal(
    classifyAffiliateReferralPlatform({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/153 Safari/537.36',
    }),
    'other'
  );

  assert.equal(
    classifyAffiliateReferralPlatform({ userAgent: '' }),
    'other'
  );
});

test('builds the canonical Google Play listing URL', () => {
  assert.equal(
    buildGooglePlayListingUrl('com.bhernaurd.theagora'),
    'https://play.google.com/store/apps/details?id=com.bhernaurd.theagora'
  );
});

test('desktop landing page exposes both stores and preserves visible creator identity', () => {
  const html = renderReferralStoreLandingPage({
    creatorCode: 'MAXAGORA',
    appleUrl:
      'https://apps.apple.com/redeem?ctx=offercodes&id=6762416967&code=MAXAGORA',
    googlePlayUrl:
      'https://play.google.com/store/apps/details?id=com.bhernaurd.theagora',
  });

  assert.match(html, /MAXAGORA/);
  assert.match(html, /Download on the App Store/);
  assert.match(html, /Get it on Google Play/);
  assert.match(html, /apps\.apple\.com\/redeem/);
  assert.match(html, /play\.google\.com\/store\/apps\/details/);
  assert.match(html, /navigator\.maxTouchPoints > 1/);
});
