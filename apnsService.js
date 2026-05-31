// apnsService.js
// Token-based APNs authentication using the 'apn' npm package.
// Install: npm install apn
//
// Environment variables required (set in Railway dashboard):
//   APNS_KEY_ID      — 10-character key ID from Apple Developer
//   APNS_TEAM_ID     — 10-character Team ID from Apple Developer
//   APNS_BUNDLE_ID   — com.bhernaurd.TheAgora
//   APNS_PRIVATE_KEY — contents of the .p8 file, with literal \n for newlines
//                      Railway stores it as a single-line string; we restore newlines below.
//
// APNs environment:
//   production: false  → Development / Simulator
//   production: true   → TestFlight AND App Store
//
// ⚠️  TestFlight uses the PRODUCTION APNs environment.
//     Set APNS_PRODUCTION=true in Railway for TestFlight builds.
//     During local Simulator testing only, use false.

import apn from 'apn';

let provider = null;

function getProvider() {
    if (provider) return provider;

    const keyId    = process.env.APNS_KEY_ID;
    const teamId   = process.env.APNS_TEAM_ID;
    const rawKey   = process.env.APNS_PRIVATE_KEY;

    if (!keyId || !teamId || !rawKey) {
        console.error('[APNs] Missing required env vars: APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY');
        return null;
    }

    // Railway stores the .p8 content with literal \n — restore real newlines
    const privateKey = rawKey.replace(/\\n/g, '\n');

    // production: true for TestFlight + App Store
    // production: false for Simulator / development certificates
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
 * @param {string} deviceToken — hex device token string
 * @param {string} title
 * @param {string} body
 * @param {object} data — optional extra payload (for future deep-linking)
 * @returns {boolean} true if accepted by APNs, false otherwise
 */
export async function sendPush(deviceToken, title, body, data = {}) {
    const p = getProvider();
    if (!p) return false;

    const bundleId = process.env.APNS_BUNDLE_ID || 'com.bhernaurd.TheAgora';

    const note = new apn.Notification();
    note.expiry       = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL
    note.badge        = 1;
    note.sound        = 'default';
    note.alert        = { title, body };
    note.topic        = bundleId;
    note.payload      = { ...data, source: 'daily_challenge' };

    try {
        const result = await p.send(note, deviceToken);
        if (result.failed && result.failed.length > 0) {
            const reason = result.failed[0]?.response?.reason ?? 'Unknown';
            console.error(`[APNs] Failed to send to ${deviceToken.slice(0, 8)}...: ${reason}`);
            return false;
        }
        console.log(`[APNs] Sent to ${deviceToken.slice(0, 8)}...`);
        return true;
    } catch (err) {
        console.error('[APNs] Send error:', err.message);
        return false;
    }
}

export default { sendPush };
