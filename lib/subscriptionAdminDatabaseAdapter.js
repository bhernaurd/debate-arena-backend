// Compatibility adapter for subscription-admin notification delivery.
//
// PushTokenService registers identifierForVendor UUID strings exactly as iOS
// sends them (normally uppercase), while the subscription-admin configuration
// normalizes UUIDs to lowercase. PostgreSQL text equality is case-sensitive,
// so the admin APNs lookup must compare UUID-shaped push user IDs without
// regard to letter case.
//
// Keep the behavior narrowly scoped to the one APNs target lookup. All other
// database operations pass straight through to the underlying pg Pool.

export function createSubscriptionAdminDatabaseAdapter(pool) {
    if (
        !pool ||
        typeof pool.query !== 'function' ||
        typeof pool.connect !== 'function'
    ) {
        throw new Error(
            'A PostgreSQL pool is required for the subscription admin database adapter.'
        );
    }

    return Object.freeze({
        query(text, values) {
            if (typeof text !== 'string') {
                return pool.query(text, values);
            }

            const isAdminPushTargetLookup =
                text.includes('FROM push_tokens') &&
                text.includes('WHERE user_id = $1') &&
                text.includes('apns_environment = $2');

            const queryText = isAdminPushTargetLookup
                ? text.replace(
                    'WHERE user_id = $1',
                    'WHERE LOWER(user_id) = LOWER($1)'
                )
                : text;

            return pool.query(queryText, values);
        },

        connect(...args) {
            return pool.connect(...args);
        },
    });
}

export default createSubscriptionAdminDatabaseAdapter;
