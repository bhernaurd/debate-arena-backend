import '../env.js';
import pg from 'pg';

import {
  loadSubscriptionAdminHistory,
} from '../lib/subscriptionAdminHistoryService.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

try {
  const history = await loadSubscriptionAdminHistory(pool);
  console.log('[SubscriptionHistory] Readiness:', {
    ready: true,
    timeZone: history.timeZone,
    currentMonth: history.currentMonth,
    allTime: history.allTime,
    months: history.months,
  });
} catch (error) {
  console.error('[SubscriptionHistory] Readiness failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
