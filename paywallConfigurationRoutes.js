import express from 'express';

const CONFIG_VERSION = 'founding_paywall_phases_v1';

const FOUNDING_OFFER_START_LOCAL_DATE = '2026-07-22';
const FOUNDING_OFFER_DEADLINE_LOCAL_DATE = '2026-08-31';
const STANDARD_PAYWALL_START_LOCAL_DATE = '2026-09-01';
const FINAL_TWO_WEEKS_START_LOCAL_DATE = '2026-08-18';
const FINAL_WEEK_START_LOCAL_DATE = '2026-08-25';
const FINAL_DAY_LOCAL_DATE = '2026-08-31';

function cleanString(value, maxLength = 100) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function isValidTimeZone(timeZone) {
  if (!timeZone) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function dateKeyInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function daysBetweenDateKeys(startDateKey, endDateKey) {
  const [startYear, startMonth, startDay] = startDateKey
    .split('-')
    .map(Number);
  const [endYear, endMonth, endDay] = endDateKey
    .split('-')
    .map(Number);

  const startUTC = Date.UTC(startYear, startMonth - 1, startDay);
  const endUTC = Date.UTC(endYear, endMonth - 1, endDay);

  return Math.round((endUTC - startUTC) / 86_400_000);
}

export function buildPaywallConfiguration({
  now = new Date(),
  timeZone,
}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    const error = new Error('A valid server date is required.');
    error.statusCode = 500;
    throw error;
  }

  if (!isValidTimeZone(timeZone)) {
    const error = new Error('A valid IANA time zone is required.');
    error.statusCode = 400;
    throw error;
  }

  const localDate = dateKeyInTimeZone(now, timeZone);
  const foundingOfferActive =
    localDate >= FOUNDING_OFFER_START_LOCAL_DATE &&
    localDate < STANDARD_PAYWALL_START_LOCAL_DATE;

  let paywallVariant = 'standard';
  let urgencyPhase = 'none';
  let daysRemaining = null;
  let pricingCohortHint = 'standard';

  if (foundingOfferActive) {
    paywallVariant = 'founding_2026';
    pricingCohortHint = 'founding_2026';
    daysRemaining = Math.max(
      1,
      daysBetweenDateKeys(
        localDate,
        FOUNDING_OFFER_DEADLINE_LOCAL_DATE
      ) + 1
    );

    if (localDate >= FINAL_DAY_LOCAL_DATE) {
      urgencyPhase = 'final_day';
    } else if (localDate >= FINAL_WEEK_START_LOCAL_DATE) {
      urgencyPhase = 'final_week';
    } else if (localDate >= FINAL_TWO_WEEKS_START_LOCAL_DATE) {
      urgencyPhase = 'final_two_weeks';
    } else {
      urgencyPhase = 'regular';
    }
  }

  return {
    success: true,
    configVersion: CONFIG_VERSION,
    serverTime: now.toISOString(),
    timeZone,
    localDate,
    foundingOfferActive,
    paywallVariant,
    urgencyPhase,
    daysRemaining,
    offerStartLocalDate: FOUNDING_OFFER_START_LOCAL_DATE,
    deadlineLocalDate: FOUNDING_OFFER_DEADLINE_LOCAL_DATE,
    pricingCohortHint,
  };
}

export function createPaywallConfigurationRouter() {
  const router = express.Router();

  router.get('/api/paywall/configuration', (req, res) => {
    const timeZone = cleanString(req.query?.timeZone, 100);

    res.setHeader('Cache-Control', 'no-store');

    try {
      const configuration = buildPaywallConfiguration({
        now: new Date(),
        timeZone,
      });

      return res.json(configuration);
    } catch (error) {
      return res.status(Number(error?.statusCode || 500)).json({
        success: false,
        error: error?.message || 'Unable to determine paywall configuration.',
      });
    }
  });

  return router;
}
