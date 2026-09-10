import { sendPush as sendApnsPush } from '../apnsService.js';
import { sendFcmPush } from './fcmPushService.js';

export function normalizePushPlatform(value) {
    const platform = String(value || '').trim().toLowerCase();
    return platform === 'android' ? 'android' : 'ios';
}

export function isPermanentPushFailure(outcome) {
    if (!outcome || typeof outcome !== 'object') return false;
    if (outcome.permanent === true) return true;

    const reason = String(outcome.reason || '').trim();
    return new Set([
        'BadDeviceToken',
        'Unregistered',
        'DeviceTokenNotForTopic',
        'BadCertificateEnvironment',
    ]).has(reason);
}

export async function sendPushForPlatform({
    platform,
    deviceToken,
    title,
    body,
    data = {},
} = {}) {
    const normalizedPlatform = normalizePushPlatform(platform);

    if (normalizedPlatform === 'android') {
        return sendFcmPush(deviceToken, title, body, data);
    }

    const outcome = await sendApnsPush(deviceToken, title, body, data);
    if (outcome && typeof outcome === 'object') {
        return {
            ...outcome,
            permanent: isPermanentPushFailure(outcome),
            retryable: outcome.retryable === true,
            provider: 'apns',
        };
    }

    return {
        ok: outcome === true,
        reason: outcome === true ? null : 'APNS_SEND_FAILED',
        permanent: false,
        retryable: outcome !== true,
        provider: 'apns',
    };
}

export default { sendPushForPlatform, normalizePushPlatform, isPermanentPushFailure };
