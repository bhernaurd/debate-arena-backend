import test from 'node:test';
import assert from 'node:assert/strict';

import { upsertPushToken } from '../pushRoutes.js';

function makePool(initialRows = []) {
    const state = initialRows.map((row) => ({ ...row }));

    const client = {
        async query(sql, params = []) {
            const text = String(sql);

            if (
                text === 'BEGIN' ||
                text === 'COMMIT' ||
                text === 'ROLLBACK'
            ) {
                return { rows: [], rowCount: 0 };
            }

            if (text.includes('pg_advisory_xact_lock')) {
                return { rows: [], rowCount: 1 };
            }

            if (
                text.includes('SELECT user_id') &&
                text.includes('FROM push_tokens') &&
                text.includes('FOR UPDATE')
            ) {
                const [installId, environment] = params;
                const row = state.find(
                    (item) =>
                        item.install_id === installId &&
                        item.apns_environment === environment
                );

                return {
                    rows: row ? [{ user_id: row.user_id ?? null }] : [],
                    rowCount: row ? 1 : 0,
                };
            }

            if (
                text.includes('DELETE FROM push_tokens') &&
                text.includes('RETURNING')
            ) {
                const [deviceToken, installId, environment] = params;
                const index = state.findIndex(
                    (item) =>
                        item.device_token === deviceToken &&
                        (
                            item.install_id !== installId ||
                            item.apns_environment !== environment
                        )
                );

                if (index < 0) {
                    return { rows: [], rowCount: 0 };
                }

                const [removed] = state.splice(index, 1);

                return {
                    rows: [{
                        user_id: removed.user_id ?? null,
                        last_completed_challenge_id:
                            removed.last_completed_challenge_id ?? null,
                        last_completed_challenge_date:
                            removed.last_completed_challenge_date ?? null,
                    }],
                    rowCount: 1,
                };
            }

            if (text.includes('INSERT INTO push_tokens')) {
                const [
                    deviceToken,
                    platform,
                    timezone,
                    notificationsEnabled,
                    installId,
                    userId,
                    appVersion,
                    buildNumber,
                    environment,
                    languageCode,
                    languagePreference,
                    lastCompletedChallengeId,
                    lastCompletedChallengeDate,
                ] = params;

                const existingIndex = state.findIndex(
                    (item) =>
                        item.install_id === installId &&
                        item.apns_environment === environment
                );

                const registration = {
                    device_token: deviceToken,
                    platform,
                    timezone,
                    notifications_enabled: notificationsEnabled,
                    install_id: installId,
                    user_id: userId ?? null,
                    app_version: appVersion ?? null,
                    build_number: buildNumber ?? null,
                    apns_environment: environment,
                    language_code: languageCode,
                    language_preference: languagePreference,
                    last_completed_challenge_id:
                        lastCompletedChallengeId ?? null,
                    last_completed_challenge_date:
                        lastCompletedChallengeDate ?? null,
                    registered_at: new Date(),
                    updated_at: new Date(),
                    created_at: new Date(),
                    last_registered_at: new Date(),
                    last_failure_at: null,
                    failure_reason: null,
                };

                let row;

                if (existingIndex >= 0) {
                    const existing = state[existingIndex];

                    row = {
                        ...existing,
                        device_token: deviceToken,
                        platform,
                        timezone,
                        notifications_enabled: notificationsEnabled,
                        user_id: userId ?? existing.user_id ?? null,
                        app_version: appVersion ?? null,
                        build_number: buildNumber ?? null,
                        apns_environment: environment,
                        language_code: languageCode,
                        language_preference: languagePreference,
                        last_registered_at: new Date(),
                        updated_at: new Date(),
                        last_failure_at: null,
                        failure_reason: null,
                    };

                    state[existingIndex] = row;
                } else {
                    if (
                        state.some(
                            (item) => item.device_token === deviceToken
                        )
                    ) {
                        const error = new Error(
                            'duplicate key value violates unique constraint "push_tokens_pkey"'
                        );
                        error.code = '23505';
                        throw error;
                    }

                    state.push(registration);
                    row = registration;
                }

                return {
                    rows: [{ ...row }],
                    rowCount: 1,
                };
            }

            if (
                text.includes('UPDATE push_tokens') &&
                text.includes("failure_reason = 'superseded_by_new_token_registration'")
            ) {
                const [
                    deviceToken,
                    environment,
                    platform,
                    ...rest
                ] = params;

                let cursor = 0;
                let userId = null;
                let installId = null;

                if (text.includes('user_id = $4')) {
                    userId = rest[cursor++];
                }

                const installPosition = userId ? 5 : 4;
                if (
                    text.includes(`install_id = $${installPosition}`)
                ) {
                    installId = rest[cursor++];
                }

                const affected = [];

                for (const row of state) {
                    if (
                        row.device_token === deviceToken ||
                        row.apns_environment !== environment ||
                        (row.platform || 'ios') !== platform ||
                        row.notifications_enabled === false
                    ) {
                        continue;
                    }

                    if (
                        (userId && row.user_id === userId) ||
                        (installId && row.install_id === installId)
                    ) {
                        row.notifications_enabled = false;
                        row.failure_reason =
                            'superseded_by_new_token_registration';
                        affected.push({
                            device_token: row.device_token,
                        });
                    }
                }

                return {
                    rows: affected,
                    rowCount: affected.length,
                };
            }

            throw new Error(
                `Unexpected SQL in push token test: ${text}`
            );
        },

        release() {},
    };

    return {
        pool: {
            async connect() {
                return client;
            },
        },
        state,
    };
}

function registrationInput(overrides = {}) {
    return {
        deviceToken: 'a'.repeat(64),
        platform: 'ios',
        timezone: 'America/Chicago',
        notificationsEnabled: true,
        installId: 'install-current-0001',
        userId: null,
        appVersion: '4.6',
        buildNumber: '1',
        apnsEnvironment: 'production',
        language: 'en',
        languagePreference: 'system',
        ...overrides,
    };
}

test(
    'moves an existing device token from a legacy installation without a primary-key collision',
    async () => {
        const deviceToken = 'a'.repeat(64);
        const { pool, state } = makePool([
            {
                device_token: deviceToken,
                platform: 'ios',
                timezone: 'America/Chicago',
                notifications_enabled: true,
                install_id: 'legacy-install-0001',
                user_id: 'legacy-user-0001',
                app_version: '4.5',
                build_number: '5',
                apns_environment: 'production',
                language_code: 'en',
                language_preference: 'system',
                last_completed_challenge_id: 'challenge-123',
                last_completed_challenge_date: '2026-09-20',
            },
        ]);

        const result = await upsertPushToken(
            pool,
            registrationInput({ deviceToken })
        );

        assert.equal(state.length, 1);
        assert.equal(state[0].device_token, deviceToken);
        assert.equal(
            state[0].install_id,
            'install-current-0001'
        );
        assert.equal(
            state[0].user_id,
            'legacy-user-0001'
        );
        assert.equal(
            state[0].last_completed_challenge_id,
            'challenge-123'
        );
        assert.equal(
            result.installId,
            'install-current-0001'
        );
    }
);

test(
    'keeps the canonical installation identity when a duplicate token row is merged into it',
    async () => {
        const incomingToken = 'c'.repeat(64);
        const canonicalToken = 'b'.repeat(64);

        const { pool, state } = makePool([
            {
                device_token: incomingToken,
                platform: 'ios',
                timezone: 'America/Chicago',
                notifications_enabled: true,
                install_id: 'legacy-install-0002',
                user_id: 'legacy-user-0002',
                apns_environment: 'production',
                language_code: 'en',
                language_preference: 'system',
            },
            {
                device_token: canonicalToken,
                platform: 'ios',
                timezone: 'America/Chicago',
                notifications_enabled: true,
                install_id: 'install-current-0001',
                user_id: 'canonical-user-0001',
                apns_environment: 'production',
                language_code: 'en',
                language_preference: 'system',
            },
        ]);

        const result = await upsertPushToken(
            pool,
            registrationInput({
                deviceToken: incomingToken,
            })
        );

        const canonical = state.find(
            (row) =>
                row.install_id ===
                'install-current-0001'
        );

        assert.equal(state.length, 1);
        assert.equal(
            canonical.device_token,
            incomingToken
        );
        assert.equal(
            canonical.user_id,
            'canonical-user-0001'
        );
        assert.equal(
            result.userId,
            'canonical-user-0001'
        );
    }
);
