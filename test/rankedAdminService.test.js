import test from 'node:test';
import assert from 'node:assert/strict';
import { createRankedAdminService } from '../lib/rankedAdminService.js';

const ACCOUNT = '12345678-1234-4123-8123-123456789012';
const DEBATE = '87654321-1234-4123-8123-123456789012';

function fixture() {
  const state = {
    profile: {
      account_id: ACCOUNT,
      placement_status: 'completed', placement_trials_completed: 5,
      current_rank_key: 'initiate', current_division: 3, current_rp: 95,
      peak_rank_key: 'initiate', peak_division: 3,
      demotion_protection_debates_remaining: 0, state_version: 1,
    },
    active: false, events: [],
    debate: { id: DEBATE, debate_kind: 'ladder', status: 'forfeited', rp_delta: -25 },
  };
  const connection = {
    async query(sql, params = []) {
      if (['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('FROM account_ranked_profiles WHERE account_id=$1 FOR UPDATE')) {
        return { rows: [{ ...state.profile }] };
      }
      if (sql.includes("FROM account_ranked_debates WHERE account_id=$1 AND status='active'")) {
        return { rows: state.active ? [{ id: 'active' }] : [] };
      }
      if (sql.includes("formula_components->>'adminRequestId'")) {
        return { rows: state.events.some(x => x.adminRequestId === params[1]) ? [{ id: 'duplicate' }] : [] };
      }
      if (sql.includes('SELECT id, debate_kind, status, rp_delta FROM account_ranked_debates')) {
        return { rows: [state.debate] };
      }
      if (sql.includes("formula_components->>'restoredDebateId'")) {
        return { rows: state.events.some(x => x.restoredDebateId === params[1]) ? [{ id: 'restored' }] : [] };
      }
      if (sql.startsWith('UPDATE account_ranked_profiles')) {
        Object.assign(state.profile, {
          current_rank_key: params[1], current_division: params[2],
          current_rp: params[3], state_version: state.profile.state_version + 1,
        });
        return { rows: [] };
      }
      if (sql.includes('FROM ranked_system_configuration')) {
        return { rows: [{ ranked_rules_version: 'test', rp_formula_version: 'test' }] };
      }
      if (sql.includes('INSERT INTO account_ranked_rating_events')) {
        state.events.push(JSON.parse(params[13]));
        return { rows: [{ id: 'new-event', occurred_at: new Date() }] };
      }
      throw new Error('Unexpected SQL: ' + sql.slice(0, 100));
    },
    release() {},
  };
  const service = createRankedAdminService({ connect: async () => connection });
  let sequence = 1;
  function apply(action, options = {}) {
    return service.mutate(ACCOUNT, {
      action,
      reason: 'Manual correction test',
      expectedVersion: state.profile.state_version,
      requestId: '12345678-1234-4123-8123-' + String(sequence++).padStart(12, '0'),
      ...options,
    });
  }
  return { state, apply };
}

test('adjust crosses divisions and records the before/after rating', async () => {
  const { apply, state } = fixture();
  const result = await apply('adjust', { points: 10 });
  assert.deepEqual(result.after, { rankKey: 'initiate', division: 2, rp: 5 });
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].reason, 'Manual correction test');
  assert.equal(state.profile.state_version, 2);
});

test('restore compensates each failed ladder debate at most once', async () => {
  const { apply } = fixture();
  const first = await apply('restore', { debateId: DEBATE });
  assert.deepEqual(first.after, { rankKey: 'student', division: 3, rp: 20 });
  await assert.rejects(
    () => apply('restore', { debateId: DEBATE }),
    (error) => error.code === 'already_restored'
  );
});

test('set rank, then reset ladder rating without removing placements', async () => {
  const { apply, state } = fixture();
  const changed = await apply('set', { rankKey: 'scholar', division: 1, rp: 80 });
  assert.deepEqual(changed.after, { rankKey: 'scholar', division: 1, rp: 80 });
  const reset = await apply('reset');
  assert.deepEqual(reset.after, { rankKey: 'initiate', division: 3, rp: 0 });
  assert.equal(state.profile.placement_trials_completed, 5);
});

test('refuses to mutate during an active debate', async () => {
  const { apply, state } = fixture();
  state.active = true;
  await assert.rejects(
    () => apply('adjust', { points: 5 }),
    (error) => error.code === 'active_debate'
  );
  assert.equal(state.events.length, 0);
});

test('refuses to mutate a stale profile version', async () => {
  const { apply, state } = fixture();
  await assert.rejects(
    () => apply('adjust', { points: 5, expectedVersion: 0 }),
    (error) => error.code === 'invalid_expectedVersion'
  );
  assert.equal(state.events.length, 0);
});
