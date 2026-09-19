import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
    new URL('../aiJobs.js', import.meta.url),
    'utf8'
);

test(
    'AI jobs can recover Pro access from a server-verified installation subscription link',
    () => {
        assert.match(
            source,
            /async function storedVerifiedProAccessForInstallation/
        );

        assert.match(
            source,
            /FROM subscription_entitlements se[\s\S]*FROM subscription_installation_links link[\s\S]*link\.user_id = \$1/
        );

        assert.match(
            source,
            /verification\.isVerifiedPro !== true[\s\S]*storedVerifiedProAccessForInstallation/
        );

        assert.match(
            source,
            /verified_installation_subscription_database/
        );
    }
);

test(
    'the fallback still relies on active server-stored entitlement state',
    () => {
        assert.match(
            source,
            /se\.status IN \('trial', 'active'\)[\s\S]*se\.expires_date > NOW\(\)/
        );

        assert.match(
            source,
            /se\.status = 'grace_period'[\s\S]*se\.grace_period_expires_date > NOW\(\)/
        );

        assert.match(
            source,
            /Client-reported Pro metadata is still never[\s\S]*accepted as access proof/
        );
    }
);
