const CODE_RE = /^[A-Z0-9]{2,64}$/;

function statusError(statusCode, message, code = 'affiliate_apple_import_preference_error') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    throw statusError(400, 'Invalid creator code.', 'invalid_affiliate_code');
  }
  return code;
}

function cleanRequiredId(value, fieldName) {
  const text = String(value || '').trim();
  if (!text || text.length > 300) {
    throw statusError(400, `${fieldName} is required.`, 'invalid_apple_import_identifier');
  }
  return text;
}

function cleanNote(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 1000) : null;
}

export function createAffiliateAppleImportPreferencesService({ pool } = {}) {
  if (!pool) throw new Error('Affiliate Apple import preferences service requires a PostgreSQL pool.');

  async function listPreferences() {
    const result = await pool.query(
      `
      SELECT
        normalized_code,
        disposition,
        canonical_offer_id,
        canonical_custom_code_id,
        note,
        updated_by,
        created_at,
        updated_at
      FROM affiliate_apple_import_preferences
      ORDER BY normalized_code ASC
      `
    );
    return result.rows;
  }

  async function selectCanonical({
    customCode,
    offerId,
    customCodeId,
    actor = 'owner_admin',
    note = null,
  } = {}) {
    const code = cleanCode(customCode);
    const cleanOfferId = cleanRequiredId(offerId, 'offerId');
    const cleanCustomCodeId = cleanRequiredId(customCodeId, 'customCodeId');
    const cleanActor = String(actor || 'owner_admin').trim().slice(0, 200) || 'owner_admin';
    const cleanPreferenceNote = cleanNote(note);

    const result = await pool.query(
      `
      INSERT INTO affiliate_apple_import_preferences (
        normalized_code,
        disposition,
        canonical_offer_id,
        canonical_custom_code_id,
        note,
        updated_by
      )
      VALUES ($1, 'pending', $2, $3, $4, $5)
      ON CONFLICT (normalized_code)
      DO UPDATE SET
        disposition = 'pending',
        canonical_offer_id = EXCLUDED.canonical_offer_id,
        canonical_custom_code_id = EXCLUDED.canonical_custom_code_id,
        note = COALESCE(EXCLUDED.note, affiliate_apple_import_preferences.note),
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING *
      `,
      [code, cleanOfferId, cleanCustomCodeId, cleanPreferenceNote, cleanActor]
    );

    await pool.query(
      `
      INSERT INTO affiliate_admin_audit_log (
        admin_actor,
        action_type,
        related_record_type,
        related_record_id,
        after_value,
        reason
      )
      VALUES ($1, 'affiliate_apple_import_canonical_selected', 'apple_creator_code', $2, $3::jsonb, $4)
      `,
      [
        cleanActor,
        code,
        JSON.stringify({ offerId: cleanOfferId, customCodeId: cleanCustomCodeId }),
        cleanPreferenceNote,
      ]
    );

    return result.rows[0];
  }

  async function ignoreCode({ customCode, actor = 'owner_admin', note = null } = {}) {
    const code = cleanCode(customCode);
    const cleanActor = String(actor || 'owner_admin').trim().slice(0, 200) || 'owner_admin';
    const cleanPreferenceNote = cleanNote(note);

    const result = await pool.query(
      `
      INSERT INTO affiliate_apple_import_preferences (
        normalized_code,
        disposition,
        canonical_offer_id,
        canonical_custom_code_id,
        note,
        updated_by
      )
      VALUES ($1, 'ignored', NULL, NULL, $2, $3)
      ON CONFLICT (normalized_code)
      DO UPDATE SET
        disposition = 'ignored',
        canonical_offer_id = NULL,
        canonical_custom_code_id = NULL,
        note = COALESCE(EXCLUDED.note, affiliate_apple_import_preferences.note),
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING *
      `,
      [code, cleanPreferenceNote, cleanActor]
    );

    await pool.query(
      `
      INSERT INTO affiliate_admin_audit_log (
        admin_actor,
        action_type,
        related_record_type,
        related_record_id,
        after_value,
        reason
      )
      VALUES ($1, 'affiliate_apple_import_ignored', 'apple_creator_code', $2, $3::jsonb, $4)
      `,
      [cleanActor, code, JSON.stringify({ disposition: 'ignored' }), cleanPreferenceNote]
    );

    return result.rows[0];
  }

  async function restoreCode({ customCode, actor = 'owner_admin' } = {}) {
    const code = cleanCode(customCode);
    const cleanActor = String(actor || 'owner_admin').trim().slice(0, 200) || 'owner_admin';

    const result = await pool.query(
      `
      INSERT INTO affiliate_apple_import_preferences (
        normalized_code,
        disposition,
        canonical_offer_id,
        canonical_custom_code_id,
        updated_by
      )
      VALUES ($1, 'pending', NULL, NULL, $2)
      ON CONFLICT (normalized_code)
      DO UPDATE SET
        disposition = 'pending',
        canonical_offer_id = NULL,
        canonical_custom_code_id = NULL,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING *
      `,
      [code, cleanActor]
    );

    await pool.query(
      `
      INSERT INTO affiliate_admin_audit_log (
        admin_actor,
        action_type,
        related_record_type,
        related_record_id,
        after_value
      )
      VALUES ($1, 'affiliate_apple_import_restored', 'apple_creator_code', $2, $3::jsonb)
      `,
      [cleanActor, code, JSON.stringify({ disposition: 'pending' })]
    );

    return result.rows[0];
  }

  return Object.freeze({
    listPreferences,
    selectCanonical,
    ignoreCode,
    restoreCode,
  });
}
