const TIME_ZONE = 'America/Chicago';

// Planning estimates for Apple's 2026 fiscal periods. Apple does not publish
// a guaranteed payment-date calendar. The dashboard labels these dates as
// estimates and keeps imported financial settlements as the source of truth.
const APPLE_FISCAL_PERIODS = Object.freeze([
  { fiscalMonth: '2026-01', periodStart: '2025-12-28', periodEnd: '2026-01-31', estimatedPaymentDate: '2026-03-05' },
  { fiscalMonth: '2026-02', periodStart: '2026-02-01', periodEnd: '2026-02-28', estimatedPaymentDate: '2026-04-02' },
  { fiscalMonth: '2026-03', periodStart: '2026-03-01', periodEnd: '2026-03-28', estimatedPaymentDate: '2026-04-30' },
  { fiscalMonth: '2026-04', periodStart: '2026-03-29', periodEnd: '2026-05-02', estimatedPaymentDate: '2026-06-04' },
  { fiscalMonth: '2026-05', periodStart: '2026-05-03', periodEnd: '2026-05-30', estimatedPaymentDate: '2026-07-02' },
  { fiscalMonth: '2026-06', periodStart: '2026-05-31', periodEnd: '2026-06-27', estimatedPaymentDate: '2026-07-30' },
  { fiscalMonth: '2026-07', periodStart: '2026-06-28', periodEnd: '2026-08-01', estimatedPaymentDate: '2026-09-03' },
  { fiscalMonth: '2026-08', periodStart: '2026-08-02', periodEnd: '2026-08-29', estimatedPaymentDate: '2026-10-01' },
  { fiscalMonth: '2026-09', periodStart: '2026-08-30', periodEnd: '2026-09-26', estimatedPaymentDate: '2026-10-29' },
  { fiscalMonth: '2026-10', periodStart: '2026-09-27', periodEnd: '2026-10-31', estimatedPaymentDate: '2026-12-03' },
  { fiscalMonth: '2026-11', periodStart: '2026-11-01', periodEnd: '2026-11-28', estimatedPaymentDate: '2026-12-31' },
  { fiscalMonth: '2026-12', periodStart: '2026-11-29', periodEnd: '2026-12-26', estimatedPaymentDate: '2027-01-28' },
]);

function dateKeyInTimeZone(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export function getAppleFiscalPayoutCalendar({ asOf = new Date(), limit = 7 } = {}) {
  const today = dateKeyInTimeZone(asOf) || new Date().toISOString().slice(0, 10);
  const periods = APPLE_FISCAL_PERIODS.map((period) => ({ ...period }));
  const current = periods.find(
    (period) => period.periodStart <= today && today <= period.periodEnd
  ) || null;
  const nextPayoutIndex = periods.findIndex(
    (period) => period.estimatedPaymentDate >= today
  );
  const nextPayout = nextPayoutIndex >= 0 ? periods[nextPayoutIndex] : null;
  const safeLimit = Math.max(1, Math.min(12, Number(limit) || 7));
  const startIndex = nextPayoutIndex >= 0
    ? Math.max(0, nextPayoutIndex - 1)
    : Math.max(0, periods.length - safeLimit);

  return {
    asOf: today,
    timeZone: TIME_ZONE,
    source: 'planning_estimate',
    isEstimated: true,
    paymentRule: 'Apple states payments are made within 45 days after the last day of the fiscal month; exact issue and bank dates can vary.',
    current,
    nextPayout,
    periods: periods.slice(startIndex, startIndex + safeLimit),
  };
}

export default getAppleFiscalPayoutCalendar;
