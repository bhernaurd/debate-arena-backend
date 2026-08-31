import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSubscriptionUsdConverter,
} from '../lib/subscriptionUsdConversionService.js';

test('keeps USD and converts foreign revenue into one USD bag', async () => {
  const calls = [];
  const converter = createSubscriptionUsdConverter({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        async json() {
          return [
            {
              date: '2026-08-31',
              base: 'CAD',
              quote: 'USD',
              rate: 0.73,
            },
          ];
        },
      };
    },
    logger: { warn() {} },
  });

  const result = await converter.convertBag(
    {
      USD: 24.99,
      CAD: 10,
    },
    '2026-08'
  );

  assert.deepEqual(result.bag, { USD: 32.29 });
  assert.deepEqual(result.convertedCurrencies, ['CAD']);
  assert.deepEqual(result.fallbackCurrencies, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /base=CAD/);
  assert.match(calls[0], /quotes=USD/);
  assert.match(calls[0], /group=month/);
});

test('caches a currency-month rate across repeated conversions', async () => {
  let calls = 0;
  const converter = createSubscriptionUsdConverter({
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        async json() {
          return [{ quote: 'USD', rate: 1.2 }];
        },
      };
    },
    logger: { warn() {} },
  });

  await converter.convertBag({ EUR: 5 }, '2026-07');
  await converter.convertBag({ EUR: 10 }, '2026-07');

  assert.equal(calls, 1);
});

test('falls back to the latest rate when monthly FX data is unavailable', async () => {
  let calls = 0;
  const warnings = [];
  const converter = createSubscriptionUsdConverter({
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes('/rates?')) {
        return {
          ok: false,
          status: 503,
          async json() {
            return {};
          },
        };
      }

      return {
        ok: true,
        async json() {
          return {
            base: 'GBP',
            quote: 'USD',
            rate: 1.35,
          };
        },
      };
    },
    logger: {
      warn(message, detail) {
        warnings.push([message, detail]);
      },
    },
  });

  const result = await converter.convertBag({ GBP: 10 }, '2026-08');

  assert.deepEqual(result.bag, { USD: 13.5 });
  assert.deepEqual(result.convertedCurrencies, ['GBP']);
  assert.deepEqual(result.fallbackCurrencies, ['GBP']);
  assert.equal(calls, 2);
  assert.equal(warnings.length, 1);
});

test('does not call the FX provider for USD-only bags', async () => {
  const converter = createSubscriptionUsdConverter({
    fetchImpl: async () => {
      throw new Error('should not fetch');
    },
  });

  const result = await converter.convertBag({ USD: 7.99 }, '2026-08');

  assert.deepEqual(result.bag, { USD: 7.99 });
  assert.deepEqual(result.convertedCurrencies, []);
});
