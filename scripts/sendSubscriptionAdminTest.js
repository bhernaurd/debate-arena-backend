import '../env.js';

import pg from 'pg';
import {
    createSubscriptionAdminNotificationService,
} from '../lib/subscriptionAdminNotificationService.js';
import {
    createSubscriptionAdminDatabaseAdapter,
} from '../lib/subscriptionAdminDatabaseAdapter.js';

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
});

async function main() {
    if (
        String(process.env.SUBSCRIPTION_ADMIN_ALERTS_ENABLED || '')
            .trim()
            .toLowerCase() !== 'true'
    ) {
        throw new Error(
            'SUBSCRIPTION_ADMIN_ALERTS_ENABLED must be true before sending a test alert.'
        );
    }

    const notificationPool =
        createSubscriptionAdminDatabaseAdapter(pool);

    const service = createSubscriptionAdminNotificationService({
        pool: notificationPool,
    });

    const queued = await service.enqueueTestNotification({
        title: '🎉 Agora subscription alerts are connected',
        body: 'APNs is primary. Telegram is configured as fallback.',
    });

    await service.kick();

    const result = await pool.query(
        `
        SELECT
            status,
            delivered_via,
            apns_status,
            apns_error,
            telegram_status,
            telegram_error
        FROM subscription_admin_notifications
        WHERE id = $1
        LIMIT 1
        `,
        [queued.id]
    );

    console.log(
        '[SubscriptionAdminAlerts] Test result:',
        result.rows[0] || null
    );
}

main()
    .catch((error) => {
        console.error(
            '[SubscriptionAdminAlerts] Test failed:',
            error?.message || error
        );
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
