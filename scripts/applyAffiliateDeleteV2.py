from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return source.replace(old, new, 1)


routes_path = Path('affiliateRoutes.js')
routes = routes_path.read_text()

# Keep the existing owner-authentication code completely untouched. All UI changes
# below are scoped to the affiliate rows, Apple import rendering, and delete action.
routes = replace_once(
    routes,
    "    function productionAffiliates() { return affiliates.filter(a => !a.is_test); }",
    "    function productionAffiliates() { return affiliates.filter(a => !a.is_test && a.status !== 'archived'); }",
    'production summary archive filter',
)

routes = replace_once(
    routes,
    "        if (query && !String(a.display_name || '').toLowerCase().includes(query) && !String(a.normalized_code || '').toLowerCase().includes(query)) return false;\n\n        // Keep Sandbox/Test affiliates out of every normal production view.",
    "        if (query && !String(a.display_name || '').toLowerCase().includes(query) && !String(a.normalized_code || '').toLowerCase().includes(query)) return false;\n        if (a.status === 'archived') return false;\n\n        // Keep Sandbox/Test affiliates out of every normal production view.",
    'affiliate row archive filter',
)

routes = replace_once(
    routes,
    "            (canToggle ? '<button class=\"button small ' + (operationalActive ? 'danger' : 'gold') + '\" data-action=\"toggle\" data-id=\"' + html(a.id) + '\" data-active=\"' + (operationalActive ? 'false' : 'true') + '\">' + (operationalActive ? 'Pause' : 'Activate') + '</button>' : '') +\n          '</div></td>' +",
    "            (canToggle ? '<button class=\"button small ' + (operationalActive ? 'danger' : 'gold') + '\" data-action=\"toggle\" data-id=\"' + html(a.id) + '\" data-active=\"' + (operationalActive ? 'false' : 'true') + '\">' + (operationalActive ? 'Pause' : 'Activate') + '</button>' : '') +\n            '<button class=\"button small danger\" data-action=\"delete\" data-id=\"' + html(a.id) + '\">Delete</button>' +\n          '</div></td>' +",
    'affiliate delete button',
)

routes = replace_once(
    routes,
    "      const linkedRows = appleLinked.map(item => renderAppleImportRow(item, 'linked'));",
    "      const linkedRows = appleLinked.filter(item => item.linkedAffiliate?.status !== 'archived').map(item => renderAppleImportRow(item, 'linked'));",
    'Apple linked-row archive filter',
)

delete_ui = r'''    async function deleteAffiliate(id) {
      const a = affiliateById(id);
      if (!a) return;
      const appleNotice = a.is_test
        ? 'This removes the affiliate from the active website view while preserving historical records.'
        : 'This deactivates the Apple creator code, removes the affiliate from the active website view, revokes its private dashboard link, and preserves referral and payout history.';
      if (!confirm('Delete ' + a.display_name + '? ' + appleNotice)) return;
      try {
        const payload = await adminFetch('/api/admin/affiliates/' + encodeURIComponent(id), { method:'DELETE' });
        const apple = payload.appleDeactivation || {};
        const message = a.is_test
          ? 'Affiliate deleted from active views.'
          : apple.status === 'deactivated'
            ? 'Affiliate deleted and Apple creator code deactivated.'
            : 'Affiliate deleted. Apple creator code was already inactive.';
        toast(message);
        await Promise.all([loadAffiliates(false), loadAppleImports(false), loadAlerts(false)]);
      } catch (error) { toast(error.message, true); }
    }

'''

routes = replace_once(
    routes,
    "    function openCreateAffiliate(prefill = null) {",
    delete_ui + "    function openCreateAffiliate(prefill = null) {",
    'delete affiliate browser action',
)

routes = replace_once(
    routes,
    "      if (button.dataset.action === 'toggle') toggleAffiliate(id, button.dataset.active === 'true');",
    "      if (button.dataset.action === 'toggle') toggleAffiliate(id, button.dataset.active === 'true');\n      if (button.dataset.action === 'delete') deleteAffiliate(id);",
    'delete affiliate click handler',
)

delete_route = r'''  router.delete('/api/admin/affiliates/:id', adminOnly, async (req, res) => {
    try {
      const affiliates = await service.listAffiliates();
      const affiliate = affiliates.find(
        item => String(item?.id || '') === String(req.params.id || '')
      );

      if (!affiliate) {
        const error = new Error('Affiliate not found.');
        error.statusCode = 404;
        error.code = 'affiliate_not_found';
        throw error;
      }

      if (affiliate.status === 'archived') {
        return res.json({
          success: true,
          affiliate,
          alreadyArchived: true,
          appleDeactivation: {
            status: 'already_inactive',
            deactivatedCount: 0,
          },
        });
      }

      let appleDeactivation = {
        status: 'skipped',
        reason: 'test_affiliate',
        deactivatedCount: 0,
      };

      // Apple is deactivated first. If Apple rejects the request, Agora keeps
      // the affiliate visible instead of hiding a creator code that is still redeemable.
      if (!affiliate.is_test) {
        if (typeof appStoreConnectService?.deactivateCustomCode !== 'function') {
          const error = new Error('App Store Connect custom-code deactivation is unavailable.');
          error.statusCode = 503;
          error.code = 'app_store_connect_custom_code_deactivation_unavailable';
          throw error;
        }
        appleDeactivation = await appStoreConnectService.deactivateCustomCode({
          offerReferenceName: affiliate.apple_offer_identifier,
          customCode: affiliate.normalized_code,
        });
      }

      const client = await pool.connect();
      let archivedAffiliate = null;
      try {
        await client.query('BEGIN');
        const archived = await client.query(
          `
          UPDATE affiliates
          SET status = 'archived',
              code_status = 'disabled',
              archived_at = COALESCE(archived_at, NOW()),
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [affiliate.id]
        );
        archivedAffiliate = archived.rows[0] || affiliate;

        await client.query(
          `
          UPDATE affiliate_dashboard_tokens
          SET status = 'revoked',
              revoked_at = COALESCE(revoked_at, NOW())
          WHERE affiliate_id = $1
            AND status = 'active'
          `,
          [affiliate.id]
        );
        await client.query('COMMIT');
      } catch (databaseError) {
        await client.query('ROLLBACK');
        throw databaseError;
      } finally {
        client.release();
      }

      return res.json({
        success: true,
        affiliate: archivedAffiliate,
        appleDeactivation,
      });
    } catch (error) {
      return jsonError(res, error);
    }
  });

'''

routes = replace_once(
    routes,
    "  router.post('/api/admin/affiliates/:id/operational-status', adminOnly, async (req, res) => {",
    delete_route + "  router.post('/api/admin/affiliates/:id/operational-status', adminOnly, async (req, res) => {",
    'delete affiliate API route',
)

routes_path.write_text(routes)


apple_path = Path('lib/appStoreConnectAffiliateService.js')
apple = apple_path.read_text()

deactivate_service = r'''  async function deactivateCustomCode({
    offerReferenceName,
    customCode,
  } = {}) {
    assertConfigured();

    const normalizedOfferName = normalizeAppleOfferIdentifier(offerReferenceName);
    const normalizedCustomCode = normalizeAffiliateCode(customCode);

    if (!normalizedOfferName) {
      throw statusError(
        400,
        'An App Store Connect offer reference name is required.',
        'app_store_connect_offer_reference_required'
      );
    }

    if (!normalizedCustomCode) {
      throw statusError(
        400,
        'A creator code is required.',
        'app_store_connect_custom_code_required'
      );
    }

    const offers = await listOfferCodes();
    const matchingOffers = offers.filter(
      offer => offer.normalizedName === normalizedOfferName
    );

    if (!matchingOffers.length) {
      throw statusError(
        404,
        `No App Store Connect offer matches “${cleanText(offerReferenceName)}”.`,
        'app_store_connect_offer_not_found'
      );
    }

    const activeOffers = matchingOffers.filter(offer => offer.active === true);
    const offer = activeOffers.length === 1
      ? activeOffers[0]
      : matchingOffers.length === 1
        ? matchingOffers[0]
        : null;

    if (!offer) {
      throw statusError(
        409,
        `More than one App Store Connect offer matches “${cleanText(offerReferenceName)}”.`,
        'app_store_connect_offer_ambiguous'
      );
    }

    const activeBatches = (offer.customCodes || []).filter(
      item => item.customCode === normalizedCustomCode && item.active === true
    );

    if (!activeBatches.length) {
      return {
        status: 'already_inactive',
        offerId: offer.id,
        offerName: offer.name,
        customCode: normalizedCustomCode,
        deactivatedCount: 0,
        customCodeIds: [],
      };
    }

    const customCodeIds = [];
    for (const batch of activeBatches) {
      await apiFetch(`/subscriptionOfferCodeCustomCodes/${encodeURIComponent(batch.id)}`, {
        method: 'PATCH',
        body: {
          data: {
            type: 'subscriptionOfferCodeCustomCodes',
            id: batch.id,
            attributes: { active: false },
          },
        },
      });
      customCodeIds.push(batch.id);
    }

    return {
      status: 'deactivated',
      offerId: offer.id,
      offerName: offer.name,
      customCode: normalizedCustomCode,
      deactivatedCount: customCodeIds.length,
      customCodeIds,
    };
  }

'''

apple = replace_once(
    apple,
    "  function affiliateSummary(affiliate) {",
    deactivate_service + "  function affiliateSummary(affiliate) {",
    'App Store Connect deactivation service',
)

apple = replace_once(
    apple,
    "      isTest: Boolean(affiliate.is_test),\n    };",
    "      isTest: Boolean(affiliate.is_test),\n      status: cleanText(affiliate.status),\n    };",
    'linked affiliate status projection',
)

apple = replace_once(
    apple,
    "    ensureCustomCode,\n    getSubscriptionPricingSummary,",
    "    ensureCustomCode,\n    deactivateCustomCode,\n    getSubscriptionPricingSummary,",
    'App Store Connect service export',
)

apple_path.write_text(apple)


test_path = Path('test/affiliateDeleteAdminV2.test.js')
test_path.write_text(r'''import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { createAppStoreConnectAffiliateService } from '../lib/appStoreConnectAffiliateService.js';

function privateKeyPem() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body == null ? '' : JSON.stringify(body); },
  };
}

function offer(id, name, active = true) {
  return {
    type: 'subscriptionOfferCodes', id,
    attributes: { name, active, customerEligibilities: [] },
  };
}

function customCode(id, code, active = true) {
  return {
    type: 'subscriptionOfferCodeCustomCodes', id,
    attributes: { customCode: code, active, numberOfCodes: 1000 },
  };
}

test('deactivateCustomCode deactivates every active Apple batch for a creator code', async () => {
  const calls = [];
  const service = createAppStoreConnectAffiliateService({
    issuerId: 'issuer-id',
    keyId: 'key-id',
    privateKey: privateKeyPem(),
    subscriptionId: 'subscription-id',
    fetchImpl: async (url, options = {}) => {
      const call = {
        url: String(url),
        method: options.method || 'GET',
        body: options.body ? JSON.parse(options.body) : null,
      };
      calls.push(call);
      const parsed = new URL(call.url);
      if (call.method === 'GET' && parsed.pathname.endsWith('/subscriptions/subscription-id/offerCodes')) {
        return response(200, { data: [offer('offer-1', 'Affiliate First Month $0.99')], links: {} });
      }
      if (call.method === 'GET' && parsed.pathname.endsWith('/subscriptionOfferCodes/offer-1/customCodes')) {
        return response(200, {
          data: [
            customCode('batch-1', 'DELETECODE', true),
            customCode('batch-2', 'DELETECODE', true),
            customCode('old-batch', 'DELETECODE', false),
            customCode('other', 'OTHERCODE', true),
          ],
          links: {},
        });
      }
      if (call.method === 'PATCH' && parsed.pathname.includes('/subscriptionOfferCodeCustomCodes/')) {
        const id = parsed.pathname.split('/').pop();
        return response(200, { data: customCode(id, 'DELETECODE', false) });
      }
      throw new Error(`Unexpected request: ${call.method} ${parsed.pathname}`);
    },
  });

  const result = await service.deactivateCustomCode({
    offerReferenceName: 'Affiliate First Month $0.99',
    customCode: 'deletecode',
  });

  assert.equal(result.status, 'deactivated');
  assert.equal(result.deactivatedCount, 2);
  assert.deepEqual(result.customCodeIds.sort(), ['batch-1', 'batch-2']);

  const patches = calls.filter(call => call.method === 'PATCH');
  assert.equal(patches.length, 2);
  for (const patch of patches) {
    assert.equal(patch.body.data.type, 'subscriptionOfferCodeCustomCodes');
    assert.equal(patch.body.data.id, patch.url.split('/').pop());
    assert.deepEqual(patch.body.data.attributes, { active: false });
  }
});

test('Affiliate Admin delete stays isolated from owner unlock and hides archived affiliates', () => {
  const source = fs.readFileSync(new URL('../affiliateRoutes.js', import.meta.url), 'utf8');
  assert.match(source, /data-action="delete"/);
  assert.match(source, /router\.delete\('\/api\/admin\/affiliates\/:id'/);
  assert.match(source, /deactivateCustomCode/);
  assert.match(source, /status = 'archived'/);
  assert.match(source, /code_status = 'disabled'/);
  assert.match(source, /linkedAffiliate\?\.status !== 'archived'/);
  assert.match(source, /a\.status === 'archived'\) return false/);
  assert.match(source, /confirm\('Delete ' \+ a\.display_name \+ '\? ' \+ appleNotice\)/);
  assert.doesNotMatch(source, /Delete ' \+ a\.display_name \+ '\?\\n/);

  // The existing unlock wiring must remain present and unmodified by this feature.
  assert.match(source, /\$\('unlockAdmin'\)\.addEventListener\('click'/);
  assert.match(source, /sessionStorage\.setItem\('agoraAffiliateAdminKey', adminKey\)/);
});
''')

print('Affiliate Delete v2 patch applied.')
