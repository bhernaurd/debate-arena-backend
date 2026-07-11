// apnsService.js
// Token-based APNs authentication using the 'apn' npm package.

import apn from 'apn';

let provider = null;

function getProvider() {
    if (provider) return provider;

    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APNS_TEAM_ID;
    const rawKey = process.env.APNS_PRIVATE_KEY;

    if (!keyId || !teamId || !rawKey) {
        console.error('[APNs] Missing required env vars: APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY');
        return null;
    }

    const privateKey = rawKey.replace(/\\n/g, '\n');
    const isProduction = process.env.APNS_PRODUCTION === 'true';

    provider = new apn.Provider({
        token: {
            key: privateKey,
            keyId,
            teamId,
        },
        production: isProduction,
    });

    console.log(`[APNs] Provider initialized — production: ${isProduction}`);
    return provider;
}

/**
 * Send a push notification to a single device.
 *
 * Returns an object instead of only true/false so the scheduler can disable
 * bad APNs tokens when Apple returns BadDeviceToken, Unregistered, etc.
 */
export async function sendPush(deviceToken, title, body, data = {}) {
    const p = getProvider();

    if (!p) {
        return {
            ok: false,
            reason: 'APNs provider unavailable',
        };
    }

    const bundleId = process.env.APNS_BUNDLE_ID || 'com.bhernaurd.TheAgora';

    const note = new apn.Notification();

    // Keep notification valid for 1 hour.
    note.expiry = Math.floor(Date.now() / 1000) + 3600;

    // Explicit visible-alert delivery settings.
    // This makes the push an immediate visible notification instead of relying
    // on APNs/package defaults.
    note.priority = 10;
    note.pushType = 'alert';

    note.badge = 1;
    note.sound = 'default';
    note.alert = {
        title,
        body,
    };

    note.topic = bundleId;
    note.payload = {
        ...data,
        source: 'daily_challenge',
    };

    try {
        const result = await p.send(note, deviceToken);

        if (result.failed && result.failed.length > 0) {
            const failure = result.failed[0];
            const reason =
                failure?.response?.reason ||
                failure?.error?.reason ||
                failure?.error?.message ||
                'Unknown APNs failure';

            console.error(`[APNs] Failed to send to ${deviceToken.slice(0, 8)}...: ${reason}`);

            return {
                ok: false,
                reason,
            };
        }

        console.log(`[APNs] Sent to ${deviceToken.slice(0, 8)}...`);

        return {
            ok: true,
            reason: null,
        };
    } catch (err) {
        const reason = err?.reason || err?.message || 'Unknown APNs exception';

        console.error(`[APNs] Send error to ${deviceToken.slice(0, 8)}...: ${reason}`);

        return {
            ok: false,
            reason,
        };
    }
}

export default { sendPush };
