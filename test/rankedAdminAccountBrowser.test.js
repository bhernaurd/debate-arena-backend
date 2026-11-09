import test from 'node:test';
import assert from 'node:assert/strict';
import { createRankedAdminService } from '../lib/rankedAdminService.js';

test('ranked account browser provides a paginated list when search is empty', async () => {
  const queries = [];
  const pool = {
    connect() { throw new Error('not needed for read'); },
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('COUNT(*)::int AS total FROM accounts')) {
        return { rows: [{ total: 55 }] };
      }
      return { rows: [
        { account_id: '12345678-1234-4123-8123-123456789012',
          display_name: 'Example account', placement_status: 'completed',
          current_rank_key: 'student', current_division: 3, current_rp: 49 },
      ] };
    },
  };
  const service = createRankedAdminService(pool);
  const result = await service.list({ limit: 25, offset: 25 });
  assert.equal(result.total, 55);
  assert.equal(result.offset, 25);
  assert.equal(result.limit, 25);
  assert.equal(result.accounts.length, 1);
  assert.deepEqual(queries[0].params, [25, 25]);
  assert.match(queries[0].sql, /ORDER BY a\.created_at DESC, a\.id DESC/);
});

test('ranked account browser validates the page size and offset', async () => {
  const service = createRankedAdminService({
    connect() {},
    async query() { throw new Error('Should not query'); },
  });
  await assert.rejects(() => service.list({ limit: 101, offset: 0 }),
    (error) => error.code === 'invalid_limit');
  await assert.rejects(() => service.list({ limit: 25, offset: -1 }),
    (error) => error.code === 'invalid_offset');
});
