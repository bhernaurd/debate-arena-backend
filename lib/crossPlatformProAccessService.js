import {
    createAccountProAccessService,
} from './accountProAccessService.js';

/**
 * Compatibility factory retained for server wiring introduced during the
 * Android entitlement rollout. The canonical AccountProAccessService now reads
 * App Store/Lifetime and Google Play entitlements itself, so all consumers use
 * exactly one authorization implementation.
 */
export function createCrossPlatformProAccessService({
    pool,
} = {}) {
    return createAccountProAccessService({
        pool,
    });
}
