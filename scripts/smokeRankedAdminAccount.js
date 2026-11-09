// One-time, opt-in live smoke test. Runs only when a specific account ID and
// run ID are provided. Restores the original ladder position and checks the
// immutable audit events before exiting successfully.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createRankedAdminService } from '../lib/rankedAdminService.js';

const accountId = process.env.RANKED_ADMIN_SMOKE_ACCOUNT_ID;
const runId = process.env.RANKED_ADMIN_SMOKE_RUN_ID;
if (!accountId || !runId || !/^[a-zA-Z0-9_-]{8,80}$/.test(runId)) {
  console.error('[RankedAdminSmoke] Missing account ID or valid smoke run ID.');
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway')
      ? { rejectUnauthorized: false } : false,
    max: 3,
  });
  const admin = createRankedAdminService(pool);
  const reasonAdd = 'Temporary +10 RP smoke test ' + runId;
  const reasonUndo = 'Revert +10 RP smoke test ' + runId;
  const samePosition = (a, b) =>
    a?.rankKey === b?.rankKey && a?.division === b?.division && a?.rp === b?.rp;
  let original = null;
  let addApplied = false;
  let reversed = false;

  try {
    const already = await pool.query(
      `SELECT formula_components->>'reason' AS reason
       FROM account_ranked_rating_events
       WHERE account_id=$1 AND event_type='admin_adjustment'
         AND formula_components->>'reason' IN ($2,$3)`,
      [accountId, reasonAdd, reasonUndo]
    );
    if (already.rows.length) {
      throw new Error('This smoke test run ID already exists in audit history; refusing replay.');
    }
    const state = await admin.read(accountId);
    original = state.profile.current;
    if (state.profile.placementStatus !== 'completed' || !original) {
      throw new Error('Target account has not completed ranked placements; no rating was altered.');
    }
    if (state.profile.activeDebates) {
      throw new Error('Target account has an active ranked debate; no rating was altered.');
    }
    if (original.rankKey === 'alchemist' && original.rp > 89) {
      throw new Error('Target account is too close to the RP cap for a +10 test.');
    }
    console.log('[RankedAdminSmoke] Original rank:', original);
    const plus = await admin.mutate(accountId, {
      action: 'adjust', points: 10,
      reason: reasonAdd, expectedVersion: state.profile.stateVersion,
      requestId: randomUUID(),
    });
    addApplied = true;
    const afterPlus = await admin.read(accountId);
    if (!samePosition(plus.after, afterPlus.profile.current)) {
      throw new Error('The +10 RP operation did not persist to the profile.');
    }
    console.log('[RankedAdminSmoke] +10 RP verified:', afterPlus.profile.current);
    const undo = await admin.mutate(accountId, {
      action: 'adjust', points: -10,
      reason: reasonUndo, expectedVersion: afterPlus.profile.stateVersion,
      requestId: randomUUID(),
    });
    reversed = true;
    const afterUndo = await admin.read(accountId);
    if (!samePosition(original, afterUndo.profile.current)) {
      throw new Error('The -10 RP reversal did not restore the original rank.');
    }
    const audit = await pool.query(
      `SELECT formula_components->>'reason' AS reason, rp_delta
       FROM account_ranked_rating_events
       WHERE account_id=$1 AND event_type='admin_adjustment'
         AND formula_components->>'reason' IN ($2,$3)`,
      [accountId, reasonAdd, reasonUndo]
    );
    if (audit.rows.length !== 2 ||
        !audit.rows.some(x => x.reason === reasonAdd && x.rp_delta === 10) ||
        !audit.rows.some(x => x.reason === reasonUndo && x.rp_delta === -10)) {
      throw new Error('Expected +10 and -10 adjustment audit events are missing.');
    }
    console.log('[RankedAdminSmoke] PASS: original rank restored; 2 audit events verified.');
  } catch (error) {
    console.error('[RankedAdminSmoke] FAILED:', error?.message || error);
    // If the second operation failed, attempt a safe compensating correction.
    if (addApplied && !reversed && original) {
      try {
        const current = (await admin.read(accountId)).profile;
        if (!samePosition(current.current, original)) {
          await admin.mutate(accountId, {
            action: 'set',
            rankKey: original.rankKey,
            division: original.division,
            rp: original.rp,
            reason: 'Emergency rollback smoke test ' + runId,
            expectedVersion: current.stateVersion,
            requestId: randomUUID(),
          });
          console.error('[RankedAdminSmoke] Original rating restored via emergency correction.');
        }
      } catch (rollbackError) {
        console.error('[RankedAdminSmoke] URGENT: rollback failed:', rollbackError?.message);
      }
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
