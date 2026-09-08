import {
    createAccountProAccessService,
} from './accountProAccessService.js';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Shared cross-platform entitlement facade.
 *
 * getCurrentAccess() remains the canonical Apple/Lifetime/Google Play Pro
 * lookup used by subscription UI and Ranked's free-vs-Pro policy.
 *
 * Ranked gameplay itself is now available to every authenticated account:
 * placements are free, active Ranked debates can always be resumed/finished,
 * and the ladder route separately enforces the free daily-start policy. The
 * legacy Ranked services still call requireCurrentProAccess(), so this method
 * intentionally acts as their authenticated-gameplay compatibility gate rather
 * than a subscription gate.
 */
export function createCrossPlatformProAccessService({
    pool,
} = {}) {
    const entitlementService =
        createAccountProAccessService({
            pool,
        });

    return Object.freeze({
        getCurrentAccess:
            entitlementService.getCurrentAccess,

        async requireCurrentProAccess({
            accountId,
        } = {}) {
            const cleanAccountId =
                typeof accountId === 'string'
                    ? accountId.trim().toLowerCase()
                    : '';

            if (!UUID_RE.test(cleanAccountId)) {
                const error = new Error(
                    'Ranked gameplay received an invalid accountId.'
                );
                error.code = 'invalid_ranked_account';
                error.status = 400;
                error.retryable = false;
                throw error;
            }

            return Object.freeze({
                accountId: cleanAccountId,
                hasProAccess: true,
                accessReason:
                    'ranked_authenticated_gameplay',
            });
        },
    });
}
