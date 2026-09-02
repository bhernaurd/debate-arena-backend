import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    googlePlayProductionBypassChecks,
    googlePlayReleasePolicyConstants,
} from '../lib/googlePlayReleasePolicy.js';

test(
    'Play release bypass checks default to production-safe values',
    () => {
        assert.deepEqual(
            googlePlayProductionBypassChecks({}),
            {
                rankedProEnforced: true,
                expandedAgoraTestProAllowlistDisabled: true,
            }
        );
    }
);

test(
    'Play release readiness fails closed when Ranked Pro enforcement is disabled or malformed',
    () => {
        for (
            const value of
            ['false', '0', 'no', 'off', 'unexpected']
        ) {
            assert.equal(
                googlePlayProductionBypassChecks({
                    RANKED_REQUIRE_PRO: value,
                }).rankedProEnforced,
                false,
                value
            );
        }

        for (
            const value of
            ['true', '1', 'yes', 'on']
        ) {
            assert.equal(
                googlePlayProductionBypassChecks({
                    RANKED_REQUIRE_PRO: value,
                }).rankedProEnforced,
                true,
                value
            );
        }
    }
);

test(
    'Play release readiness rejects any Expanded Agora installation-level Pro allowlist',
    () => {
        assert.equal(
            googlePlayProductionBypassChecks({
                EXPANDED_AGORA_TEST_PRO_USER_IDS:
                    'device-one,device-two',
            }).expandedAgoraTestProAllowlistDisabled,
            false
        );
        assert.equal(
            googlePlayProductionBypassChecks({
                EXPANDED_AGORA_TEST_PRO_USER_IDS:
                    '  ,  ',
            }).expandedAgoraTestProAllowlistDisabled,
            true
        );
    }
);

test(
    'production bypass variables remain explicit and readiness script consumes the pure checks',
    () => {
        assert.deepEqual(
            googlePlayReleasePolicyConstants
                .productionBypassEnvironmentVariables,
            [
                'RANKED_REQUIRE_PRO',
                'EXPANDED_AGORA_TEST_PRO_USER_IDS',
            ]
        );

        const readinessSource =
            fs.readFileSync(
                new URL(
                    '../scripts/checkGooglePlayReadiness.js',
                    import.meta.url
                ),
                'utf8'
            );

        assert.match(
            readinessSource,
            /googlePlayProductionBypassChecks\(\s*process\.env\s*\)/
        );
        assert.match(
            readinessSource,
            /\.\.\.productionBypassChecks/
        );
    }
);
