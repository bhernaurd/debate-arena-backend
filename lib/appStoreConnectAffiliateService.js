// PARTNER_PRICING_V5: resolves preserved current prices correctly before scheduled increases.
import crypto from 'crypto';

function statusError(statusCode, message, code = 'app_store_connect_error', details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details != null) error.details = details;
  return error;
}

function cleanText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeAppleOfferIdentifier(value) {
  const text = cleanText(value);
  return text ? text.toUpperCase() : '';
}

function normalizeAffiliateCode(value) {
  return cleanText(value).toUpperCase();
}

function base64url(input) {
  const source = Buffer.isBuffer(input)
    ? input
    : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input), 'utf8');
  return source.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function derToJose(signature, outputLength = 64) {
  const buffer = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
  let offset = 0;

  if (buffer[offset++] !== 0x30) {
    throw statusError(500, 'Invalid DER signature.', 'app_store_connect_invalid_signature');
  }

  let seqLength = buffer[offset++];
  if (seqLength & 0x80) {
    const lengthBytes = seqLength & 0x7f;
    seqLength = 0;
    for (let i = 0; i < lengthBytes; i += 1) {
      seqLength = (seqLength << 8) + buffer[offset++];
    }
  }

  if (buffer[offset++] !== 0x02) {
    throw statusError(500, 'Invalid DER signature.', 'app_store_connect_invalid_signature');
  }

  let rLength = buffer[offset++];
  let r = buffer.slice(offset, offset + rLength);
  offset += rLength;

  if (buffer[offset++] !== 0x02) {
    throw statusError(500, 'Invalid DER signature.', 'app_store_connect_invalid_signature');
  }

  let sLength = buffer[offset++];
  let s = buffer.slice(offset, offset + sLength);

  while (r.length > 0 && r[0] === 0x00) r = r.slice(1);
  while (s.length > 0 && s[0] === 0x00) s = s.slice(1);

  const rawLength = Math.floor(outputLength / 2);
  if (r.length > rawLength || s.length > rawLength) {
    throw statusError(500, 'Invalid DER signature size.', 'app_store_connect_invalid_signature');
  }

  const jose = Buffer.concat([
    Buffer.concat([Buffer.alloc(rawLength - r.length), r]),
    Buffer.concat([Buffer.alloc(rawLength - s.length), s]),
  ]);

  return base64url(jose);
}

function readPrivateKey(rawValue) {
  const text = cleanText(rawValue);
  if (!text) return '';
  return text.includes('-----BEGIN') ? text.replace(/\\n/g, '\n') : text;
}

export function createAppStoreConnectAffiliateService({
  issuerId = process.env.APP_STORE_CONNECT_ISSUER_ID,
  keyId = process.env.APP_STORE_CONNECT_KEY_ID,
  privateKey = process.env.APP_STORE_CONNECT_PRIVATE_KEY,
  subscriptionId = process.env.AFFILIATE_APPLE_SUBSCRIPTION_ID,
  baseUrl = 'https://api.appstoreconnect.apple.com/v1',
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedConfig = {
    issuerId: cleanText(issuerId),
    keyId: cleanText(keyId),
    privateKey: readPrivateKey(privateKey),
    subscriptionId: cleanText(subscriptionId),
  };


  const subscriptionPricingCache = new Map();
  const SUBSCRIPTION_PRICING_CACHE_TTL_MS = 5 * 60 * 1000;

  function isConfigured() {
    return Boolean(
      normalizedConfig.issuerId &&
      normalizedConfig.keyId &&
      normalizedConfig.privateKey &&
      normalizedConfig.subscriptionId &&
      typeof fetchImpl === 'function'
    );
  }

  function assertConfigured() {
    if (!normalizedConfig.issuerId || !normalizedConfig.keyId || !normalizedConfig.privateKey || !normalizedConfig.subscriptionId) {
      throw statusError(
        503,
        'App Store Connect affiliate sync is not configured. Add APP_STORE_CONNECT_ISSUER_ID, APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_PRIVATE_KEY, and AFFILIATE_APPLE_SUBSCRIPTION_ID.',
        'app_store_connect_not_configured'
      );
    }
    if (typeof fetchImpl !== 'function') {
      throw statusError(500, 'Fetch is not available in this runtime.', 'app_store_connect_fetch_unavailable');
    }
  }

  function createToken() {
    assertConfigured();
    const header = {
      alg: 'ES256',
      kid: normalizedConfig.keyId,
      typ: 'JWT',
    };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: normalizedConfig.issuerId,
      aud: 'appstoreconnect-v1',
      exp: now + 60 * 15,
      iat: now,
    };
    const encodedHeader = base64url(header);
    const encodedPayload = base64url(payload);
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const derSignature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), normalizedConfig.privateKey);
    return `${signingInput}.${derToJose(derSignature, 64)}`;
  }

  async function apiFetch(path, { method = 'GET', query = null, body = null } = {}) {
    assertConfigured();

    const url = new URL(path.replace(/^\//, ''), `${baseUrl.replace(/\/$/, '')}/`);
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value == null || value === '') return;
        url.searchParams.set(key, String(value));
      });
    }

    const headers = {
      Authorization: `Bearer ${createToken()}`,
      Accept: 'application/json',
    };

    const options = {
      method,
      headers,
    };

    if (body != null) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const response = await fetchImpl(url, options);
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const firstError = Array.isArray(payload?.errors) ? payload.errors[0] : null;
      throw statusError(
        response.status,
        firstError?.detail || firstError?.title || `App Store Connect request failed (${response.status}).`,
        firstError?.code || 'app_store_connect_request_failed',
        payload
      );
    }

    return payload || {};
  }

  async function collectAll(path, query = {}) {
    const items = [];
    let nextPath = path;
    let nextQuery = { ...query, limit: query.limit || 200 };

    while (nextPath) {
      const payload = await apiFetch(nextPath, { query: nextQuery });
      const pageItems = Array.isArray(payload?.data) ? payload.data : [];
      items.push(...pageItems);

      const nextLink = payload?.links?.next;
      if (!nextLink) break;

      const nextUrl = new URL(nextLink);
      nextPath = `${nextUrl.pathname}${nextUrl.search}`.replace(/^\/v1/, '');
      nextQuery = null;
    }

    return items;
  }


  async function collectAllWithIncluded(path, query = {}) {
    const data = [];
    const includedByKey = new Map();
    let nextPath = path;
    let nextQuery = { ...query, limit: query.limit || 200 };

    while (nextPath) {
      const payload = await apiFetch(nextPath, { query: nextQuery });
      const pageItems = Array.isArray(payload?.data) ? payload.data : [];
      const included = Array.isArray(payload?.included) ? payload.included : [];
      data.push(...pageItems);

      included.forEach(item => {
        const type = cleanText(item?.type);
        const id = cleanText(item?.id);
        if (type && id) includedByKey.set(`${type}:${id}`, item);
      });

      const nextLink = payload?.links?.next;
      if (!nextLink) break;

      const nextUrl = new URL(nextLink);
      nextPath = `${nextUrl.pathname}${nextUrl.search}`.replace(/^\/v1/, '');
      nextQuery = null;
    }

    return { data, includedByKey };
  }

  function dateKey(value) {
    const text = cleanText(value);
    if (!text) return '';
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
    if (match) return match[1];
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }

  function todayKey(now = new Date()) {
    const date = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
    return date.toISOString().slice(0, 10);
  }

  function resourceFromRelationship(resource, relationshipName, includedByKey) {
    const relationship = resource?.relationships?.[relationshipName]?.data;
    const target = Array.isArray(relationship) ? relationship[0] : relationship;
    const type = cleanText(target?.type);
    const id = cleanText(target?.id);
    return type && id ? includedByKey.get(`${type}:${id}`) || null : null;
  }

  function mapSubscriptionPrice(price, includedByKey) {
    const attributes = price?.attributes || {};
    const pricePoint = resourceFromRelationship(
      price,
      'subscriptionPricePoint',
      includedByKey
    );
    const directTerritory = resourceFromRelationship(
      price,
      'territory',
      includedByKey
    );
    const pricePointTerritory = pricePoint
      ? resourceFromRelationship(pricePoint, 'territory', includedByKey)
      : null;
    const territory = directTerritory || pricePointTerritory;
    const customerPrice = cleanText(pricePoint?.attributes?.customerPrice);

    return {
      id: cleanText(price?.id),
      startDate: dateKey(attributes.startDate) || null,
      preserved: attributes.preserved === true,
      planType: cleanText(attributes.planType) || null,
      territory: cleanText(
        directTerritory?.id ||
        pricePointTerritory?.id ||
        price?.relationships?.territory?.data?.id ||
        pricePoint?.relationships?.territory?.data?.id
      ) || null,
      currency: cleanText(territory?.attributes?.currency).toUpperCase() || null,
      customerPrice: customerPrice || null,
      subscriptionPricePointId: cleanText(pricePoint?.id) || null,
    };
  }

  function uniquePriceEntries(items) {
    const seen = new Set();
    return items.filter(item => {
      if (!item?.customerPrice) return false;
      const key = [
        item.currency || '',
        item.customerPrice,
        item.startDate || '',
        item.preserved ? 'preserved' : 'standard',
        item.planType || '',
      ].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function getSubscriptionPricingSummary({
    territory = 'USA',
    forceRefresh = false,
    now = new Date(),
  } = {}) {
    assertConfigured();
    const cleanTerritory = cleanText(territory).toUpperCase() || 'USA';
    const cacheKey = cleanTerritory;
    const cached = subscriptionPricingCache.get(cacheKey);
    const nowMs = Date.now();

    if (
      !forceRefresh &&
      cached &&
      nowMs - cached.cachedAtMs < SUBSCRIPTION_PRICING_CACHE_TTL_MS
    ) {
      return cached.value;
    }

    const payload = await collectAllWithIncluded(
      `/subscriptions/${normalizedConfig.subscriptionId}/prices`,
      {
        'filter[territory]': cleanTerritory,
        'filter[planType]': 'UPFRONT',
        'fields[subscriptionPrices]':
          'startDate,preserved,planType,territory,subscriptionPricePoint',
        'fields[subscriptionPricePoints]': 'customerPrice,territory',
        'fields[territories]': 'currency',
        include: 'territory,subscriptionPricePoint',
        limit: 200,
      }
    );

    const prices = uniquePriceEntries(
      payload.data
        .map(item => mapSubscriptionPrice(item, payload.includedByKey))
        .filter(item => item.customerPrice)
    );
    const today = todayKey(now);
    const preservedPrices = prices
      .filter(item => item.preserved)
      .sort((left, right) =>
        String(right.startDate || '').localeCompare(String(left.startDate || ''))
      );

    // App Store Connect can mark the currently effective price as preserved
    // once a future increase is scheduled with existing-subscriber price
    // preservation. Do not discard preserved entries when resolving the price
    // that is effective today. A dated price that has already started wins;
    // if dates tie, prefer the non-preserved entry because that is the public
    // new-subscriber price for that date.
    const effective = prices
      .filter(item => !item.startDate || item.startDate <= today)
      .sort((left, right) => {
        const dateOrder = String(right.startDate || '').localeCompare(
          String(left.startDate || '')
        );
        if (dateOrder !== 0) return dateOrder;
        if (left.preserved !== right.preserved) {
          return left.preserved ? 1 : -1;
        }
        return String(left.id || '').localeCompare(String(right.id || ''));
      });

    // A preserved price is an existing-subscriber tier, not the next public
    // price change. Only non-preserved future entries can be "next".
    const future = prices
      .filter(item =>
        !item.preserved &&
        item.startDate &&
        item.startDate > today
      )
      .sort((left, right) =>
        String(left.startDate).localeCompare(String(right.startDate))
      );

    const current = effective[0] || null;
    const next = future[0] || null;
    const currency =
      current?.currency ||
      next?.currency ||
      preservedPrices.find(item => item.currency)?.currency ||
      prices.find(item => item.currency)?.currency ||
      null;

    const value = {
      source: 'app_store_connect',
      subscriptionId: normalizedConfig.subscriptionId,
      territory: cleanTerritory,
      currency,
      current,
      next,
      preservedPrices,
      prices,
      refreshedAt: new Date().toISOString(),
    };

    subscriptionPricingCache.set(cacheKey, {
      cachedAtMs: nowMs,
      value,
    });
    return value;
  }

  function mapOffer(offer, customCodes = []) {
    const attributes = offer?.attributes || {};
    const offerName = cleanText(attributes.referenceName || attributes.name || attributes.offerCodeName || '');
    return {
      id: cleanText(offer?.id),
      name: offerName,
      normalizedName: normalizeAppleOfferIdentifier(offerName),
      active: attributes.active === true,
      offerMode: cleanText(attributes.offerMode || ''),
      offerEligibility: cleanText(attributes.offerEligibility || ''),
      customerEligibilities: Array.isArray(attributes.customerEligibilities) ? attributes.customerEligibilities : [],
      duration: cleanText(attributes.duration || ''),
      numberOfPeriods: attributes.numberOfPeriods ?? null,
      totalNumberOfCodes: attributes.totalNumberOfCodes ?? null,
      productionCodeCount: attributes.productionCodeCount ?? null,
      sandboxCodeCount: attributes.sandboxCodeCount ?? null,
      autoRenewEnabled: attributes.autoRenewEnabled === true,
      customCodes,
    };
  }

  function mapCustomCode(code) {
    const attributes = code?.attributes || {};
    const customCode = normalizeAffiliateCode(attributes.customCode || attributes.code || '');
    return {
      id: cleanText(code?.id),
      customCode,
      active: attributes.active === true,
      createdDate: cleanText(attributes.createdDate || ''),
      expirationDate: cleanText(attributes.expirationDate || ''),
      numberOfCodes: attributes.numberOfCodes ?? null,
    };
  }

  async function listOfferCodes() {
    const offers = await collectAll(
      `/subscriptions/${normalizedConfig.subscriptionId}/offerCodes`,
      {
        'fields[subscriptionOfferCodes]': 'name,customerEligibilities,offerEligibility,duration,offerMode,numberOfPeriods,totalNumberOfCodes,productionCodeCount,sandboxCodeCount,active,autoRenewEnabled',
        limit: 200,
      }
    );
    const results = [];

    for (const offer of offers) {
      const customCodes = await collectAll(
        `/subscriptionOfferCodes/${offer.id}/customCodes`,
        {
          'fields[subscriptionOfferCodeCustomCodes]': 'customCode,numberOfCodes,createdDate,expirationDate,active',
          limit: 200,
        }
      );
      results.push(mapOffer(offer, customCodes.map(mapCustomCode)));
    }

    return results;
  }

  function normalizeCustomCodeCount(value, fallback = 1000) {
    const candidate = value == null || String(value).trim() === ''
      ? fallback
      : Number(value);

    if (!Number.isInteger(candidate) || candidate < 1 || candidate > 25000) {
      throw statusError(
        400,
        'Apple custom-code redemption limit must be an integer between 1 and 25,000.',
        'invalid_app_store_connect_custom_code_count'
      );
    }

    return candidate;
  }

  async function ensureCustomCode({
    offerReferenceName,
    customCode,
    numberOfCodes = 1000,
    expirationDate = null,
  } = {}) {
    assertConfigured();

    const normalizedOfferName = normalizeAppleOfferIdentifier(offerReferenceName);
    const normalizedCustomCode = normalizeAffiliateCode(customCode);
    const cleanNumberOfCodes = normalizeCustomCodeCount(numberOfCodes, 1000);
    const cleanExpirationDate = cleanText(expirationDate);

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

    if (cleanExpirationDate && !/^\d{4}-\d{2}-\d{2}$/.test(cleanExpirationDate)) {
      throw statusError(
        400,
        'Apple custom-code expiration date must be YYYY-MM-DD.',
        'invalid_app_store_connect_custom_code_expiration'
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

    const activeMatches = matchingOffers.filter(offer => offer.active === true);
    const offer = activeMatches.length === 1
      ? activeMatches[0]
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

    for (const candidateOffer of offers) {
      for (const candidateCode of candidateOffer.customCodes || []) {
        if (
          candidateCode.customCode !== normalizedCustomCode ||
          candidateCode.active !== true
        ) {
          continue;
        }

        if (candidateOffer.id === offer.id) {
          return {
            created: false,
            status: 'already_exists',
            offerId: offer.id,
            offerName: offer.name,
            customCodeId: candidateCode.id,
            customCode: normalizedCustomCode,
            numberOfCodes: candidateCode.numberOfCodes,
            active: candidateCode.active,
            expirationDate: candidateCode.expirationDate || null,
          };
        }

        throw statusError(
          409,
          `${normalizedCustomCode} is already active on a different App Store Connect offer (${candidateOffer.name || candidateOffer.id}).`,
          'app_store_connect_custom_code_conflict'
        );
      }
    }

    const attributes = {
      customCode: normalizedCustomCode,
      numberOfCodes: cleanNumberOfCodes,
    };
    if (cleanExpirationDate) attributes.expirationDate = cleanExpirationDate;

    const payload = await apiFetch('/subscriptionOfferCodeCustomCodes', {
      method: 'POST',
      body: {
        data: {
          type: 'subscriptionOfferCodeCustomCodes',
          attributes,
          relationships: {
            offerCode: {
              data: {
                type: 'subscriptionOfferCodes',
                id: offer.id,
              },
            },
          },
        },
      },
    });

    const createdCode = mapCustomCode(payload?.data || {});
    return {
      created: true,
      status: 'created',
      offerId: offer.id,
      offerName: offer.name,
      customCodeId: createdCode.id || null,
      customCode: createdCode.customCode || normalizedCustomCode,
      numberOfCodes: createdCode.numberOfCodes ?? cleanNumberOfCodes,
      active: createdCode.active,
      expirationDate: createdCode.expirationDate || cleanExpirationDate || null,
    };
  }

  async function deactivateCustomCode({
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

  function affiliateSummary(affiliate) {
    if (!affiliate) return null;
    return {
      id: affiliate.id,
      displayName: affiliate.display_name,
      normalizedCode: affiliate.normalized_code,
      appleOfferIdentifier: affiliate.apple_offer_identifier,
      isTest: Boolean(affiliate.is_test),
      status: cleanText(affiliate.status),
    };
  }

  function selectCanonicalConfiguration(configurations, preference) {
    if (!configurations.length) return null;

    const preferred = preference?.canonical_offer_id && preference?.canonical_custom_code_id
      ? configurations.find(item =>
          item.offerId === preference.canonical_offer_id &&
          item.customCodeId === preference.canonical_custom_code_id
        )
      : null;
    if (preferred) return preferred;

    if (configurations.length === 1) return configurations[0];

    const activeConfigurations = configurations.filter(item => item.customCodeActive === true);
    if (activeConfigurations.length === 1) return activeConfigurations[0];

    return null;
  }

  async function listImports({ existingAffiliates = [], importPreferences = [] } = {}) {
    assertConfigured();
    const offers = await listOfferCodes();
    const syncedAt = new Date().toISOString();

    // The creator code is the affiliate identity. Many affiliates may
    // intentionally share one Apple Offer Code campaign/reference, so never
    // infer an affiliate from the shared Apple offer name.
    const affiliatesByCode = new Map();
    (Array.isArray(existingAffiliates) ? existingAffiliates : []).forEach(affiliate => {
      const code = normalizeAffiliateCode(affiliate?.normalized_code || affiliate?.custom_code || '');
      if (code) affiliatesByCode.set(code, affiliate);
    });

    const preferencesByCode = new Map();
    (Array.isArray(importPreferences) ? importPreferences : []).forEach(preference => {
      const code = normalizeAffiliateCode(preference?.normalized_code || '');
      if (code) preferencesByCode.set(code, preference);
    });

    const warnings = [];
    const grouped = new Map();

    offers.forEach(offer => {
      const codes = Array.isArray(offer.customCodes) ? offer.customCodes : [];
      const distinctCodesOnOffer = new Set(codes.map(code => code.customCode).filter(Boolean)).size;

      if (!codes.length) {
        warnings.push({
          offerId: offer.id,
          offerName: offer.name,
          message: 'Offer exists in App Store Connect but has no custom creator code yet.',
        });
        return;
      }

      codes.forEach(code => {
        if (!code.customCode) return;
        const configuration = {
          externalKey: `${offer.id}:${code.id || code.customCode}`,
          offerId: offer.id,
          offerName: offer.name,
          normalizedOfferName: offer.normalizedName,
          offerActive: offer.active,
          offerMode: offer.offerMode,
          offerEligibility: offer.offerEligibility,
          customerEligibilities: offer.customerEligibilities,
          duration: offer.duration,
          numberOfPeriods: offer.numberOfPeriods,
          totalNumberOfCodes: offer.totalNumberOfCodes,
          productionCodeCount: offer.productionCodeCount,
          sandboxCodeCount: offer.sandboxCodeCount,
          autoRenewEnabled: offer.autoRenewEnabled,
          customCodeId: code.id,
          customCode: code.customCode,
          customCodeActive: code.active,
          createdDate: code.createdDate || null,
          expirationDate: code.expirationDate || null,
          numberOfCodes: code.numberOfCodes,
          distinctCustomCodesOnOffer: distinctCodesOnOffer,
        };

        if (!grouped.has(code.customCode)) grouped.set(code.customCode, []);
        grouped.get(code.customCode).push(configuration);
      });
    });

    const imports = [];
    const linked = [];
    const ignored = [];

    for (const [customCode, configurations] of grouped.entries()) {
      configurations.sort((left, right) => {
        const activeDiff = Number(right.customCodeActive) - Number(left.customCodeActive);
        if (activeDiff) return activeDiff;
        const rightDate = Date.parse(right.createdDate || '') || 0;
        const leftDate = Date.parse(left.createdDate || '') || 0;
        if (rightDate !== leftDate) return rightDate - leftDate;
        return String(right.externalKey).localeCompare(String(left.externalKey));
      });

      const preference = preferencesByCode.get(customCode) || null;
      const canonical = selectCanonicalConfiguration(configurations, preference);
      const linkedAffiliate = affiliatesByCode.get(customCode) || null;
      const needsCanonicalChoice = configurations.length > 1 && !canonical;

      const row = {
        customCode,
        configurations,
        configurationCount: configurations.length,
        canonical,
        needsCanonicalChoice,
        // A shared Apple campaign is the intended scalable architecture. The
        // exact affiliate is established by the authenticated Agora account's
        // locked creator-code claim, not by Apple offer-reference uniqueness.
        sharedOfferCodeCount: canonical?.distinctCustomCodesOnOffer ?? 0,
        ignored: preference?.disposition === 'ignored',
        linkedAffiliate: affiliateSummary(linkedAffiliate),
      };

      if (row.ignored) ignored.push(row);
      else if (linkedAffiliate) linked.push(row);
      else imports.push(row);
    }

    const sorter = (a, b) => a.customCode.localeCompare(b.customCode);
    imports.sort(sorter);
    linked.sort(sorter);
    ignored.sort(sorter);

    return {
      configured: true,
      syncedAt,
      imports,
      linked,
      ignored,
      warnings,
      counts: {
        imports: imports.length,
        linked: linked.length,
        ignored: ignored.length,
        warnings: warnings.length,
      },
    };
  }

  return {
    isConfigured,
    listOfferCodes,
    listImports,
    ensureCustomCode,
    deactivateCustomCode,
    getSubscriptionPricingSummary,
  };
}
