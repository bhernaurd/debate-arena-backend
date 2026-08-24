import crypto from 'node:crypto';
import zlib from 'node:zlib';

function cleanText(value, maxLength = 100000) {
  if (value == null) return '';
  return String(value).trim().slice(0, maxLength);
}

function statusError(statusCode, message, code = 'app_store_connect_reports_error', details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details != null) error.details = details;
  return error;
}

function base64url(input) {
  const source = Buffer.isBuffer(input)
    ? input
    : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input), 'utf8');
  return source
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function derToJose(signature, outputLength = 64) {
  const buffer = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
  let offset = 0;

  if (buffer[offset++] !== 0x30) {
    throw statusError(500, 'Invalid DER signature.', 'app_store_connect_invalid_signature');
  }

  let sequenceLength = buffer[offset++];
  if (sequenceLength & 0x80) {
    const lengthBytes = sequenceLength & 0x7f;
    sequenceLength = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      sequenceLength = (sequenceLength << 8) + buffer[offset++];
    }
  }

  if (buffer[offset++] !== 0x02) {
    throw statusError(500, 'Invalid DER signature.', 'app_store_connect_invalid_signature');
  }

  const rLength = buffer[offset++];
  let r = buffer.slice(offset, offset + rLength);
  offset += rLength;

  if (buffer[offset++] !== 0x02) {
    throw statusError(500, 'Invalid DER signature.', 'app_store_connect_invalid_signature');
  }

  const sLength = buffer[offset++];
  let s = buffer.slice(offset, offset + sLength);

  while (r.length > 0 && r[0] === 0x00) r = r.slice(1);
  while (s.length > 0 && s[0] === 0x00) s = s.slice(1);

  const rawLength = Math.floor(outputLength / 2);
  if (r.length > rawLength || s.length > rawLength) {
    throw statusError(500, 'Invalid DER signature size.', 'app_store_connect_invalid_signature');
  }

  return base64url(
    Buffer.concat([
      Buffer.concat([Buffer.alloc(rawLength - r.length), r]),
      Buffer.concat([Buffer.alloc(rawLength - s.length), s]),
    ])
  );
}

function readPrivateKey(rawValue) {
  const text = cleanText(rawValue);
  if (!text) return '';
  return text.includes('-----BEGIN') ? text.replace(/\\n/g, '\n') : text;
}

function isGzip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function decompressReport(buffer) {
  let current = Buffer.from(buffer);
  let passes = 0;

  while (isGzip(current) && passes < 3) {
    current = zlib.gunzipSync(current);
    passes += 1;
  }

  return current.toString('utf8').replace(/^\uFEFF/, '');
}

function parseTsv(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line) => line.length > 0);

  if (lines.length === 0) return [];

  const headers = lines[0].split('\t').map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = line.split('\t');
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return row;
  });
}

function normalizeHeaderKey(value) {
  return cleanText(value, 200)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function field(row, ...names) {
  const normalized = new Map(
    Object.entries(row || {}).map(([key, value]) => [normalizeHeaderKey(key), value])
  );

  for (const name of names) {
    const value = normalized.get(normalizeHeaderKey(name));
    if (value !== undefined) return cleanText(value);
  }

  return '';
}

function numeric(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function reportDate(value) {
  const text = cleanText(value, 32);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) return null;
  return `${match[3]}-${String(match[1]).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`;
}

function signedAggregate(perUnitValue, unitsValue, fallbackSignValue = null) {
  const perUnit = numeric(perUnitValue);
  const units = numeric(unitsValue);
  const fallback = numeric(fallbackSignValue);

  if (perUnit == null) return null;
  if (units != null && units !== 0) {
    return Math.sign(units) * Math.abs(units) * Math.abs(perUnit);
  }

  if (fallback != null && fallback !== 0) {
    return Math.sign(fallback) * Math.abs(perUnit);
  }

  return perUnit;
}

function normalizeSalesRow(row) {
  const title = field(row, 'Title');
  const units = numeric(field(row, 'Units'));
  const customerPrice = numeric(field(row, 'Customer Price'));
  const proceedsPerUnit = numeric(field(row, 'Developer Proceeds', 'Developer Proceeds (per unit)'));

  return {
    productId: title || null,
    sku: field(row, 'SKU') || null,
    title: title || null,
    productTypeIdentifier: field(row, 'Product Type Identifier') || null,
    units,
    customerCurrency: field(row, 'Customer Currency')?.toUpperCase() || null,
    customerPrice,
    grossCustomerAmount: signedAggregate(customerPrice, units, customerPrice),
    countryCode: field(row, 'Country Code')?.toUpperCase() || null,
    proceedsCurrency: field(row, 'Currency of Proceeds')?.toUpperCase() || null,
    developerProceedsPerUnit: proceedsPerUnit,
    developerProceedsAmount: signedAggregate(proceedsPerUnit, units, customerPrice),
    subscription: field(row, 'Subscription') || null,
    period: field(row, 'Period') || null,
    promoCode: field(row, 'Promo Code') || null,
    orderType: field(row, 'Order Type') || null,
    proceedsReason: field(row, 'Proceeds Reason') || null,
    preservedPricing: field(row, 'Preserved Pricing') || null,
    appleIdentifier: field(row, 'Apple Identifier') || null,
    beginDate: reportDate(field(row, 'Begin Date')),
    endDate: reportDate(field(row, 'End Date')),
    rawRow: row,
  };
}

function normalizeFinanceRow(row) {
  const productId = field(row, 'Vendor Identifier', 'ISRC / ISBN', 'Title');
  const quantity = numeric(field(row, 'Quantity'));
  const partnerShare = numeric(field(row, 'Partner Share'));
  const extendedPartnerShare = numeric(field(row, 'Extended Partner Share'));

  return {
    periodStart: reportDate(field(row, 'Start Date')),
    periodEnd: reportDate(field(row, 'End Date')),
    productId: productId || null,
    title: field(row, 'Title') || null,
    productTypeIdentifier: field(row, 'Product Type Identifier') || null,
    countryOfSale: field(row, 'Country of Sale', 'Country')?.toUpperCase() || null,
    quantity,
    customerCurrency: field(row, 'Customer Currency')?.toUpperCase() || null,
    customerPrice: numeric(field(row, 'Customer Price')),
    partnerShareCurrency: field(row, 'Partner Share Currency')?.toUpperCase() || null,
    partnerSharePerUnit: partnerShare,
    extendedPartnerShare:
      extendedPartnerShare ??
      (partnerShare != null && quantity != null ? partnerShare * quantity : null),
    saleOrReturn: field(row, 'Sale or Return') || null,
    promoCode: field(row, 'Promo Code') || null,
    orderType: field(row, 'Order Type') || null,
    rawRow: row,
  };
}

export function createAppStoreConnectReportsService({
  issuerId =
    process.env.APP_STORE_CONNECT_REPORTS_ISSUER_ID ||
    process.env.APP_STORE_CONNECT_ISSUER_ID,
  keyId =
    process.env.APP_STORE_CONNECT_REPORTS_KEY_ID ||
    process.env.APP_STORE_CONNECT_KEY_ID,
  privateKey =
    process.env.APP_STORE_CONNECT_REPORTS_PRIVATE_KEY ||
    process.env.APP_STORE_CONNECT_PRIVATE_KEY,
  vendorNumber = process.env.APP_STORE_CONNECT_VENDOR_NUMBER,
  baseUrl = 'https://api.appstoreconnect.apple.com/v1',
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = {
    issuerId: cleanText(issuerId),
    keyId: cleanText(keyId),
    privateKey: readPrivateKey(privateKey),
    vendorNumber: cleanText(vendorNumber),
  };

  function isConfigured() {
    return Boolean(
      config.issuerId &&
      config.keyId &&
      config.privateKey &&
      config.vendorNumber &&
      typeof fetchImpl === 'function'
    );
  }

  function assertConfigured() {
    if (!isConfigured()) {
      throw statusError(
        503,
        'Apple proceeds reporting is not configured. Add APP_STORE_CONNECT_VENDOR_NUMBER and either the APP_STORE_CONNECT_REPORTS_* reporting key variables or the existing APP_STORE_CONNECT_* team key variables.',
        'apple_proceeds_not_configured'
      );
    }
  }

  function createToken() {
    assertConfigured();
    const now = Math.floor(Date.now() / 1000);
    const encodedHeader = base64url({ alg: 'ES256', kid: config.keyId, typ: 'JWT' });
    const encodedPayload = base64url({
      iss: config.issuerId,
      aud: 'appstoreconnect-v1',
      iat: now,
      exp: now + 15 * 60,
    });
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = crypto.sign(
      'sha256',
      Buffer.from(signingInput, 'utf8'),
      config.privateKey
    );
    return `${signingInput}.${derToJose(signature, 64)}`;
  }

  async function download(path, query) {
    assertConfigured();
    const url = new URL(path.replace(/^\//, ''), `${baseUrl.replace(/\/$/, '')}/`);
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value == null || value === '') return;
      url.searchParams.set(key, String(value));
    });

    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${createToken()}`,
        Accept: 'application/a-gzip',
      },
    });

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      let details = null;
      let message = `App Store Connect report request failed (${response.status}).`;
      try {
        const text = decompressReport(bytes);
        details = JSON.parse(text);
        const firstError = Array.isArray(details?.errors) ? details.errors[0] : null;
        message = firstError?.detail || firstError?.title || message;
      } catch {
        const text = bytes.toString('utf8').trim();
        if (text && text.length < 500) message = text;
      }

      const error = statusError(
        response.status,
        message,
        response.status === 404 ? 'apple_report_not_available' : 'apple_report_request_failed',
        details
      );
      if (response.status === 404) error.noReport = true;
      throw error;
    }

    const sourceSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const text = decompressReport(bytes);
    return { rows: parseTsv(text), sourceSha256, text };
  }

  async function downloadDailySalesReport({ reportDate: date }) {
    const cleanDate = cleanText(date, 32);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
      throw statusError(400, 'reportDate must be YYYY-MM-DD.', 'invalid_report_date');
    }

    const result = await download('/salesReports', {
      'filter[frequency]': 'DAILY',
      'filter[reportDate]': cleanDate,
      'filter[reportType]': 'SALES',
      'filter[reportSubType]': 'SUMMARY',
      'filter[vendorNumber]': config.vendorNumber,
    });

    return {
      reportDate: cleanDate,
      vendorNumber: config.vendorNumber,
      sourceSha256: result.sourceSha256,
      rows: result.rows.map(normalizeSalesRow),
    };
  }

  async function downloadFinanceReport({
    reportDate: date,
    regionCode = 'ZZ',
    reportType = 'FINANCIAL',
  }) {
    const cleanDate = cleanText(date, 16);
    const cleanRegion = cleanText(regionCode, 8).toUpperCase();
    const cleanType = cleanText(reportType, 32).toUpperCase();

    if (!/^\d{4}-\d{2}$/.test(cleanDate)) {
      throw statusError(400, 'Finance reportDate must be YYYY-MM.', 'invalid_finance_report_date');
    }
    if (!/^[A-Z0-9]{2}$/.test(cleanRegion)) {
      throw statusError(400, 'regionCode must be a two-character Apple finance region.', 'invalid_finance_region');
    }

    const result = await download('/financeReports', {
      'filter[reportDate]': cleanDate,
      'filter[reportType]': cleanType,
      'filter[regionCode]': cleanRegion,
      'filter[vendorNumber]': config.vendorNumber,
    });

    return {
      reportDate: cleanDate,
      vendorNumber: config.vendorNumber,
      regionCode: cleanRegion,
      reportType: cleanType,
      sourceSha256: result.sourceSha256,
      rows: result.rows.map(normalizeFinanceRow),
    };
  }

  return Object.freeze({
    isConfigured,
    vendorNumber: config.vendorNumber,
    downloadDailySalesReport,
    downloadFinanceReport,
  });
}

export default createAppStoreConnectReportsService;
