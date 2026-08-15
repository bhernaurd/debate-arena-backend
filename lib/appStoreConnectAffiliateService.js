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

  function mapOffer(offer, customCodes = []) {
    const attributes = offer?.attributes || {};
    const offerName = cleanText(attributes.referenceName || attributes.name || attributes.offerCodeName || '');
    return {
      id: cleanText(offer?.id),
      name: offerName,
      normalizedName: normalizeAppleOfferIdentifier(offerName),
      state: cleanText(attributes.state || attributes.status || 'unknown') || 'unknown',
      offerMode: cleanText(attributes.offerMode || ''),
      customerEligibilities: Array.isArray(attributes.customerEligibilities) ? attributes.customerEligibilities : [],
      duration: cleanText(attributes.duration || ''),
      numberOfPeriods: attributes.numberOfPeriods ?? null,
      customCodes,
    };
  }

  function mapCustomCode(code) {
    const attributes = code?.attributes || {};
    const customCode = normalizeAffiliateCode(attributes.customCode || attributes.code || '');
    return {
      id: cleanText(code?.id),
      customCode,
      state: cleanText(attributes.state || attributes.status || 'unknown') || 'unknown',
      expirationDate: cleanText(attributes.expirationDate || ''),
      numberOfCodes: attributes.numberOfCodes ?? null,
    };
  }

  async function listOfferCodes() {
    const offers = await collectAll(`/subscriptions/${normalizedConfig.subscriptionId}/offerCodes`);
    const results = [];

    for (const offer of offers) {
      const customCodes = await collectAll(`/subscriptionOfferCodes/${offer.id}/customCodes`);
      results.push(mapOffer(offer, customCodes.map(mapCustomCode)));
    }

    return results;
  }

  async function listImports({ existingAffiliates = [] } = {}) {
    assertConfigured();
    const offers = await listOfferCodes();
    const syncedAt = new Date().toISOString();

    const affiliatesByCode = new Map();
    const affiliatesByOffer = new Map();
    (Array.isArray(existingAffiliates) ? existingAffiliates : []).forEach(affiliate => {
      const code = normalizeAffiliateCode(affiliate?.normalized_code || affiliate?.custom_code || '');
      const offer = normalizeAppleOfferIdentifier(affiliate?.normalized_apple_offer_identifier || affiliate?.apple_offer_identifier || '');
      if (code) affiliatesByCode.set(code, affiliate);
      if (offer) affiliatesByOffer.set(offer, affiliate);
    });

    const imports = [];
    const linked = [];
    const warnings = [];

    offers.forEach(offer => {
      const codes = Array.isArray(offer.customCodes) ? offer.customCodes : [];

      if (!codes.length) {
        warnings.push({
          offerId: offer.id,
          offerName: offer.name,
          message: 'Offer exists in App Store Connect but has no custom creator code yet.',
        });
        return;
      }

      codes.forEach(code => {
        const linkedAffiliate = affiliatesByCode.get(code.customCode) || affiliatesByOffer.get(offer.normalizedName) || null;
        const row = {
          externalKey: `${offer.id}:${code.id || code.customCode}`,
          offerId: offer.id,
          offerName: offer.name,
          customCodeId: code.id,
          customCode: code.customCode,
          offerState: offer.state,
          customCodeState: code.state,
          expirationDate: code.expirationDate || null,
          customerEligibilities: offer.customerEligibilities,
          offerMode: offer.offerMode,
          duration: offer.duration,
          numberOfPeriods: offer.numberOfPeriods,
          linkedAffiliate: linkedAffiliate
            ? {
                id: linkedAffiliate.id,
                displayName: linkedAffiliate.display_name,
                normalizedCode: linkedAffiliate.normalized_code,
                appleOfferIdentifier: linkedAffiliate.apple_offer_identifier,
                isTest: Boolean(linkedAffiliate.is_test),
              }
            : null,
        };

        if (linkedAffiliate) {
          linked.push(row);
        } else {
          imports.push(row);
        }
      });
    });

    imports.sort((a, b) => `${a.offerName} ${a.customCode}`.localeCompare(`${b.offerName} ${b.customCode}`));
    linked.sort((a, b) => `${a.offerName} ${a.customCode}`.localeCompare(`${b.offerName} ${b.customCode}`));

    return {
      configured: true,
      syncedAt,
      imports,
      linked,
      warnings,
      counts: {
        imports: imports.length,
        linked: linked.length,
        warnings: warnings.length,
      },
    };
  }

  return {
    isConfigured,
    listOfferCodes,
    listImports,
  };
}
