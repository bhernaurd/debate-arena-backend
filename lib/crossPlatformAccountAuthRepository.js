import {
    AccountAuthError,
    createPostgresAccountAuthRepository,
} from './accountAuthService.js';

/**
 * Extends the existing account-auth repository so the native App ID and the
 * Sign in with Apple Services ID resolve to the same Agora account.
 *
 * Apple subjects are team-scoped. We still persist one identity row per
 * audience because Apple refresh-token material is audience-specific, but the
 * first identity for an issuer+subject becomes the canonical account owner for
 * every subsequent audience.
 */
export function createCrossPlatformAccountAuthRepository(pool) {
    if (!pool || typeof pool.query !== 'function') {
        throw new AccountAuthError(
            'invalid_configuration',
            'A PostgreSQL pool is required.',
            { status: 500 }
        );
    }

    const base = createPostgresAccountAuthRepository(pool);

    return Object.freeze({
        ...base,

        async acquireAppleIdentityLock(
            tx,
            { issuer, subject }
        ) {
            await tx.query(
                `
                    /* account-auth:lock-team-scoped-apple-identity */
                    SELECT pg_advisory_xact_lock(
                        hashtextextended($1, 0)
                    )
                `,
                [JSON.stringify([
                    'apple-team-subject',
                    issuer,
                    subject,
                ])]
            );
        },

        async findAppleIdentityForUpdate(
            tx,
            { issuer, audience, subject }
        ) {
            const exact = await base.findAppleIdentityForUpdate(
                tx,
                { issuer, audience, subject }
            );

            if (exact) {
                return exact;
            }

            const siblingResult = await tx.query(
                `
                    /* account-auth:find-team-scoped-apple-identity */
                    SELECT
                        ai.id AS identity_id,
                        ai.account_id,
                        ai.issuer,
                        ai.audience,
                        ai.subject,
                        a.status AS account_status,
                        a.auth_version,
                        a.display_name
                    FROM account_apple_identities ai
                    JOIN accounts a
                      ON a.id = ai.account_id
                    WHERE ai.issuer = $1
                      AND ai.subject = $2
                    ORDER BY ai.created_at ASC, ai.id ASC
                    FOR UPDATE OF ai, a
                `,
                [issuer, subject]
            );

            if (siblingResult.rowCount === 0) {
                return null;
            }

            const accountIds = new Set(
                siblingResult.rows.map((row) => row.account_id)
            );

            if (accountIds.size !== 1) {
                throw new AccountAuthError(
                    'apple_identity_account_conflict',
                    'This Apple identity is linked to conflicting Agora accounts.',
                    { status: 409 }
                );
            }

            const canonical = siblingResult.rows[0];

            await tx.query(
                `
                    /* account-auth:link-additional-apple-audience */
                    INSERT INTO account_apple_identities (
                        account_id,
                        issuer,
                        audience,
                        subject,
                        created_at,
                        updated_at,
                        last_authenticated_at
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        NOW(),
                        NOW(),
                        NOW()
                    )
                    ON CONFLICT (issuer, audience, subject)
                    DO NOTHING
                `,
                [
                    canonical.account_id,
                    issuer,
                    audience,
                    subject,
                ]
            );

            const linked = await base.findAppleIdentityForUpdate(
                tx,
                { issuer, audience, subject }
            );

            if (!linked) {
                throw new AccountAuthError(
                    'apple_identity_link_failed',
                    'The Apple identity could not be linked to this Agora account.',
                    { status: 503, retryable: true }
                );
            }

            return linked;
        },
    });
}
