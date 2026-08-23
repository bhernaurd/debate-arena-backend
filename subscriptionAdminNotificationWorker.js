// subscriptionAdminNotificationWorker.js
// Owner-facing subscription lifecycle alerts.
//
// Apple subscription state is persisted by appStoreSubscriptionRoutes first.
// This independent worker scans those committed subscription_events and sends
// APNs alerts with Telegram fallback, so notification delivery can never make
// Apple's webhook processing fail.

import './env.js';

import pg from 'pg';
import {
    createSubscriptionAdminNotificationService,
} from './lib/subscriptionAdminNotificationService.js';

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
});

pool.on('error', (error) => {
    console.error(
        '[SubscriptionAdminAlerts] Postgres pool error:',
        error.message
    );
});

export const subscriptionAdminNotificationService =
    createSubscriptionAdminNotificationService({
        pool,
    });

subscriptionAdminNotificationService.start();
