import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const baseMigration = readFileSync(
    new URL('../migrations/016_kierkegaard_release.sql', import.meta.url),
    'utf8'
);

const unlockMigration = readFileSync(
    new URL('../migrations/017_kierkegaard_unlock_now.sql', import.meta.url),
    'utf8'
);

function executableSql(source) {
    return source
        .split('\n')
        .filter(
            (line) =>
                !line
                    .trimStart()
                    .startsWith('--')
        )
        .join('\n')
        .trim();
}

test(
    'retired Kierkegaard migrations 016 and 017 are intentionally inert',
    () => {
        const baseSql =
            executableSql(baseMigration);
        const unlockSql =
            executableSql(unlockMigration);

        assert.equal(
            baseSql,
            'SELECT 1 AS retired_migration_016;'
        );

        assert.equal(
            unlockSql,
            'SELECT 1 AS retired_migration_017;'
        );

        assert.doesNotMatch(
            baseSql,
            /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i
        );

        assert.doesNotMatch(
            unlockSql,
            /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i
        );

        assert.doesNotMatch(
            baseMigration,
            /2026-08-(12|21)/
        );

        assert.doesNotMatch(
            unlockMigration,
            /2026-08-(12|21)/
        );

        assert.match(
            baseMigration,
            /September 11-13, 2026/
        );

        assert.match(
            unlockMigration,
            /September 11-13, 2026/
        );

        assert.match(
            baseMigration,
            /NEW\s+forward migration/i
        );

        assert.match(
            unlockMigration,
            /NEW\s+forward migration/i
        );

        assert.doesNotMatch(
            baseMigration,
            /^\s*BEGIN\s*;/im
        );

        assert.doesNotMatch(
            baseMigration,
            /^\s*COMMIT\s*;/im
        );

        assert.doesNotMatch(
            unlockMigration,
            /^\s*BEGIN\s*;/im
        );

        assert.doesNotMatch(
            unlockMigration,
            /^\s*COMMIT\s*;/im
        );
    }
);
