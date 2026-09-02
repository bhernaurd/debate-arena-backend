const chainVerifications = new Map();

let configuration = {
  enabled: false,
  schedule: null,
  limitPerRun: null,
  bundleId: null,
};

let lastRun = null;

function isoDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function setAppleSubscriptionVerificationConfiguration(next = {}) {
  configuration = {
    ...configuration,
    ...next,
    enabled: Boolean(next.enabled),
  };
}

export function recordAppleAutoRenewVerification({
  originalTransactionId,
  verifiedAt = new Date(),
  source = 'unknown',
  autoRenewEnabled = null,
  status = null,
} = {}) {
  const key = String(originalTransactionId || '').trim();
  const verifiedIso = isoDate(verifiedAt);
  if (!key || !verifiedIso) return null;

  const previous = chainVerifications.get(key);
  if (
    previous?.verifiedAt &&
    new Date(previous.verifiedAt).getTime() > new Date(verifiedIso).getTime()
  ) {
    return previous;
  }

  const record = Object.freeze({
    originalTransactionId: key,
    verifiedAt: verifiedIso,
    source: String(source || 'unknown'),
    autoRenewEnabled:
      autoRenewEnabled === true
        ? true
        : autoRenewEnabled === false
          ? false
          : null,
    status: status == null ? null : String(status),
  });
  chainVerifications.set(key, record);
  return record;
}

export function recordAppleSubscriptionReconciliationRun({
  reason = 'scheduled',
  startedAt = new Date(),
  completedAt = new Date(),
  summary = null,
  error = null,
} = {}) {
  const completedIso = isoDate(completedAt) || new Date().toISOString();
  const verified = Array.isArray(summary?.verified) ? summary.verified : [];

  for (const row of verified) {
    recordAppleAutoRenewVerification({
      originalTransactionId: row.originalTransactionId,
      verifiedAt: row.verifiedAt || completedIso,
      source: 'apple_status_reconcile',
      autoRenewEnabled: row.autoRenewEnabled,
      status: row.status,
    });
  }

  lastRun = Object.freeze({
    reason: String(reason || 'scheduled'),
    startedAt: isoDate(startedAt),
    completedAt: completedIso,
    success: !error,
    checked: Number(summary?.checked || 0),
    updated: Number(summary?.updated || 0),
    autoRenewChanges: Number(summary?.autoRenewChanges || 0),
    failed: Number(summary?.failed || (error ? 1 : 0)),
    error: error ? String(error?.message || error) : null,
  });
  return lastRun;
}

export function getAppleSubscriptionVerificationState() {
  return {
    configuration: { ...configuration },
    lastRun: lastRun ? { ...lastRun } : null,
    chains: Object.fromEntries(
      [...chainVerifications.entries()].map(([key, value]) => [
        key,
        { ...value },
      ])
    ),
  };
}

export function resetAppleSubscriptionVerificationStateForTests() {
  chainVerifications.clear();
  configuration = {
    enabled: false,
    schedule: null,
    limitPerRun: null,
    bundleId: null,
  };
  lastRun = null;
}
