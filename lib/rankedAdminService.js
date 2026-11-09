import { rankedRatingConstants } from './rankedRatingService.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LADDER = rankedRatingConstants.rankSequence;
const MAX_POINTS = (LADDER.length - 1) * 100 + 99;

export class RankedAdminError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
function requireUUID(value, field = 'accountId') {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new RankedAdminError('invalid_account', 'A valid ' + field + ' is required.');
  }
  return value.toLowerCase();
}
function requireReason(value) {
  if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 500) {
    throw new RankedAdminError('invalid_reason', 'Enter a reason between 8 and 500 characters.');
  }
  return value.trim();
}
function requireInteger(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RankedAdminError('invalid_' + field, field + ' must be an integer between ' + min + ' and ' + max + '.');
  }
  return value;
}
function indexOfPosition(position) {
  return LADDER.findIndex((r) => r.rankKey === position.rankKey && r.division === position.division);
}
function encode(position) {
  const index = indexOfPosition(position);
  if (index < 0 || !Number.isInteger(position.rp) || position.rp < 0 || position.rp > 99) {
    throw new RankedAdminError('invalid_position', 'Invalid rank, division, or RP.');
  }
  return index * 100 + position.rp;
}
function decode(score) {
  const capped = Math.max(0, Math.min(MAX_POINTS, score));
  const stage = Math.min(LADDER.length - 1, Math.floor(capped / 100));
  return { ...LADDER[stage], rp: capped - stage * 100 };
}
function position(row, prefix = 'current') {
  return {
    rankKey: row[prefix + '_rank_key'],
    division: row[prefix + '_division'],
    rp: row[prefix + '_rp'],
  };
}
function publicProfile(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    placementStatus: row.placement_status,
    placementTrialsCompleted: row.placement_trials_completed,
    current: row.current_rank_key ? position(row) : null,
    peak: row.peak_rank_key
      ? { rankKey: row.peak_rank_key, division: row.peak_division }
      : null,
    completedDebates: row.ranked_debates_completed,
    forfeits: row.ranked_forfeits,
    invalidResults: row.ranked_invalid_results,
    stateVersion: row.state_version,
    activeDebates: Number(row.active_debates || 0),
  };
}
export function createRankedAdminService(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('Ranked admin requires a PG pool.');

  async function list({ limit = 25, offset = 0, sort = 'newest' } = {}) {
    if (!['newest','highest','lowest'].includes(sort)) throw new RankedAdminError('invalid_sort', 'Unsupported account sort.');
    const cleanLimit = requireInteger(limit, 'limit', 1, 100);
    const cleanOffset = requireInteger(offset, 'offset', 0, 100000);
    const order = sort === 'newest' ? 'a.created_at DESC, a.id DESC' : sort === 'highest' ? 'CASE WHEN p.placement_status = \'completed\' THEN 0 ELSE 1 END ASC, rank_score DESC NULLS LAST, a.created_at DESC, a.id DESC' : 'CASE WHEN p.placement_status = \'completed\' THEN 0 ELSE 1 END ASC, rank_score ASC NULLS LAST, a.created_at DESC, a.id DESC';
    const [rows, count] = await Promise.all([
      pool.query(`SELECT a.id AS account_id, a.display_name,
                  COALESCE(ai.email,gi.email) AS email,
                  p.placement_status, p.current_rank_key, p.current_division,
                  p.current_rp, p.ranked_debates_completed, a.created_at,
                  CASE WHEN p.placement_status = 'completed' THEN
                    (CASE p.current_rank_key WHEN 'initiate' THEN 0 WHEN 'student' THEN 3
                      WHEN 'dialectician' THEN 6 WHEN 'logician' THEN 9 WHEN 'scholar' THEN 12
                      WHEN 'sage' THEN 15 WHEN 'philosopher' THEN 18 WHEN 'alchemist' THEN 21
                      ELSE NULL END + CASE WHEN p.current_rank_key='alchemist' THEN 0 ELSE 3-p.current_division END)*100 + p.current_rp
                  ELSE NULL END AS rank_score
        FROM accounts a
        LEFT JOIN LATERAL (
          SELECT email FROM account_apple_identities
          WHERE account_id=a.id ORDER BY last_authenticated_at DESC NULLS LAST LIMIT 1
        ) ai ON TRUE
        LEFT JOIN LATERAL (
          SELECT email FROM account_google_identities
          WHERE account_id=a.id ORDER BY last_authenticated_at DESC NULLS LAST LIMIT 1
        ) gi ON TRUE
        LEFT JOIN account_ranked_profiles p ON p.account_id=a.id
        ORDER BY ${order}
        LIMIT $1 OFFSET $2`, [cleanLimit, cleanOffset]),
      pool.query('SELECT COUNT(*)::int AS total FROM accounts'),
    ]);
    return {
      accounts: rows.rows,
      total: Number(count.rows[0]?.total || 0),
      limit: cleanLimit,
      offset: cleanOffset,
      sort,
    };
  }

  async function search(raw) {
    const q = typeof raw === 'string' ? raw.trim().slice(0, 160) : '';
    if (q.length < 3) throw new RankedAdminError('short_search', 'Enter at least three characters.');
    const result = await pool.query(
      `SELECT a.id AS account_id, a.display_name, COALESCE(ai.email,gi.email) AS email,
              p.placement_status, p.current_rank_key, p.current_division, p.current_rp
       FROM accounts a
       LEFT JOIN LATERAL (SELECT email FROM account_apple_identities WHERE account_id=a.id ORDER BY last_authenticated_at DESC NULLS LAST LIMIT 1) ai ON TRUE
       LEFT JOIN LATERAL (SELECT email FROM account_google_identities WHERE account_id=a.id ORDER BY last_authenticated_at DESC NULLS LAST LIMIT 1) gi ON TRUE
       LEFT JOIN account_ranked_profiles p ON p.account_id=a.id
       WHERE a.id::text ILIKE $1 OR a.display_name ILIKE $1 OR ai.email ILIKE $1 OR gi.email ILIKE $1
       ORDER BY a.created_at DESC LIMIT 25`,
      ['%' + q + '%']
    );
    return result.rows;
  }

  async function read(accountId) {
    const id = requireUUID(accountId);
    const [profile, events, debates] = await Promise.all([
      pool.query(`SELECT p.*, (SELECT COUNT(*) FROM account_ranked_debates d WHERE d.account_id=p.account_id AND d.status='active')::int AS active_debates
                  FROM account_ranked_profiles p WHERE p.account_id=$1`, [id]),
      pool.query(`SELECT id, event_type, before_rank_key, before_division, before_rp,
                           after_rank_key, after_division, after_rp, rp_delta, occurred_at,
                           formula_components->>'adminAction' AS admin_action,
                           formula_components->>'reason' AS reason,
                           formula_components->>'restoredDebateId' AS restored_debate_id
                    FROM account_ranked_rating_events WHERE account_id=$1
                    ORDER BY occurred_at DESC, id DESC LIMIT 30`, [id]),
      pool.query(`SELECT id, debate_kind, status, rp_delta, final_score_value, completed_at
                    FROM account_ranked_debates WHERE account_id=$1 AND status IN ('invalid','forfeited')
                    ORDER BY completed_at DESC LIMIT 20`, [id]),
    ]);
    if (!profile.rows.length) throw new RankedAdminError('profile_not_found', 'This account has no Ranked profile.', 404);
    return { profile: publicProfile(profile.rows[0]), events: events.rows, failedDebates: debates.rows };
  }

  async function mutate(accountId, body) {
    const id = requireUUID(accountId);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RankedAdminError('invalid_body', 'Invalid request body.');
    const action = body.action;
    if (!['adjust','set','reset','restore'].includes(action)) throw new RankedAdminError('invalid_action', 'Unknown ranked action.');
    const reason = requireReason(body.reason);
    const expectedVersion = requireInteger(body.expectedVersion, 'expectedVersion', 1, 2147483647);
    const requestId = requireUUID(body.requestId, 'requestId');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const profileResult = await client.query(
        `SELECT * FROM account_ranked_profiles WHERE account_id=$1 FOR UPDATE`, [id]
      );
      const profile = profileResult.rows[0];
      if (!profile) throw new RankedAdminError('profile_not_found', 'This account has no Ranked profile.', 404);
      if (profile.placement_status !== 'completed') {
        throw new RankedAdminError('placement_incomplete', 'Complete the five placements before editing ladder RP.', 409);
      }
      if (profile.state_version !== expectedVersion) {
        throw new RankedAdminError('stale_profile', 'Ranked state changed. Refresh and try again.', 409);
      }
      const active = await client.query(
        `SELECT id FROM account_ranked_debates WHERE account_id=$1 AND status='active' LIMIT 1`, [id]
      );
      if (active.rows.length) throw new RankedAdminError('active_debate', 'Finish or resolve the active Ranked debate first.', 409);
      const existing = await client.query(
        `SELECT id FROM account_ranked_rating_events WHERE account_id=$1 AND formula_components->>'adminRequestId'=$2 LIMIT 1`,
        [id, requestId]
      );
      if (existing.rows.length) throw new RankedAdminError('duplicate_request', 'This adjustment was already recorded.', 409);
      const before = position(profile);
      const beforePoints = encode(before);
      let after;
      let restoredDebateId = null;
      if (action === 'adjust') {
        const delta = requireInteger(body.points, 'points', -500, 500);
        if (delta === 0) throw new RankedAdminError('zero_adjustment', 'Points cannot be zero.');
        after = decode(beforePoints + delta);
      } else if (action === 'set') {
        const candidate = {
          rankKey: body.rankKey,
          division: body.rankKey === 'alchemist' ? null : body.division,
          rp: body.rp,
        };
        after = decode(encode(candidate));
      } else if (action === 'reset') {
        after = { rankKey: 'initiate', division: 3, rp: 0 };
      } else {
        restoredDebateId = requireUUID(body.debateId, 'debateId');
        const d = await client.query(
          `SELECT id, debate_kind, status, rp_delta FROM account_ranked_debates
           WHERE id=$1 AND account_id=$2 FOR UPDATE`, [restoredDebateId, id]
        );
        const debate = d.rows[0];
        if (!debate || debate.debate_kind !== 'ladder' ||
            !['invalid','forfeited'].includes(debate.status) ||
            !Number.isInteger(debate.rp_delta) || debate.rp_delta >= 0) {
          throw new RankedAdminError('not_restorable', 'Choose a completed ladder failure with lost RP.', 409);
        }
        const old = await client.query(
          `SELECT 1 FROM account_ranked_rating_events
           WHERE account_id=$1 AND event_type='admin_adjustment'
           AND formula_components->>'restoredDebateId'=$2 LIMIT 1`,
          [id, restoredDebateId]
        );
        if (old.rows.length) throw new RankedAdminError('already_restored', 'This debate was already compensated.', 409);
        after = decode(beforePoints - debate.rp_delta);
      }
      const afterPoints = encode(after);
      if (afterPoints === beforePoints) throw new RankedAdminError('no_change', 'The requested change would not alter RP.');
      const previousPeak = profile.peak_rank_key
        ? indexOfPosition({rankKey: profile.peak_rank_key, division: profile.peak_division})
        : -1;
      const newPeak = indexOfPosition(after) > previousPeak ? after : null;
      const rankChanged = indexOfPosition(after) !== indexOfPosition(before);
      const promoted = indexOfPosition(after) > indexOfPosition(before);
      const demoted = indexOfPosition(after) < indexOfPosition(before);
      await client.query(
        `UPDATE account_ranked_profiles
         SET current_rank_key=$2,current_division=$3,current_rp=$4,
             peak_rank_key=COALESCE($5,peak_rank_key),
             peak_division=CASE WHEN $5 IS NOT NULL THEN $6 ELSE peak_division END,
             peak_reached_at=CASE WHEN $5 IS NOT NULL THEN NOW() ELSE peak_reached_at END,
             state_version=state_version+1,updated_at=NOW()
         WHERE account_id=$1`,
        [id, after.rankKey, after.division, after.rp, newPeak?.rankKey || null, newPeak?.division ?? null]
      );
      const config = (await client.query(`SELECT ranked_rules_version, rp_formula_version FROM ranked_system_configuration WHERE configuration_key='global'`)).rows[0] || {};
      const metadata = { adminAction:action, adminRequestId: requestId, reason,
        restoredDebateId, rankChanged, beforePoints, afterPoints, recordedBy:'authenticated_subscription_admin' };
      const event = await client.query(
        `INSERT INTO account_ranked_rating_events (
          account_id,event_type,rp_delta,before_rank_key,before_division,before_rp,
          after_rank_key,after_division,after_rp,promoted,demoted,protection_before,
          protection_after,ranked_rules_version,rp_formula_version,formula_components
        ) VALUES ($1,'admin_adjustment',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14::jsonb)
        RETURNING id,occurred_at`,
        [id, afterPoints-beforePoints >= -500 && afterPoints-beforePoints <=500
          ? afterPoints-beforePoints : null,
         before.rankKey,before.division,before.rp,
         after.rankKey,after.division,after.rp,
         promoted,demoted,profile.demotion_protection_debates_remaining,
         config.ranked_rules_version || 'ranked-admin-v1',
         config.rp_formula_version || 'ranked-admin-v1',
         JSON.stringify(metadata)]
      );
      await client.query('COMMIT');
      return { before, after, event: event.rows[0], stateVersion: expectedVersion + 1 };
    } catch(error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return { list, search, read, mutate };
}
