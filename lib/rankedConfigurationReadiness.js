function cleanVersion(value, fieldName) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(
            `[RankedReadiness] ${fieldName} must be a non-empty string.`
        );
    }

    return value.trim();
}

export async function assertRankedTopicGeneratorConfiguration({
    pool,
    runtimeTopicGeneratorVersion,
} = {}) {
    if (!pool || typeof pool.query !== 'function') {
        throw new Error(
            '[RankedReadiness] A PostgreSQL pool is required.'
        );
    }

    const runtimeVersion = cleanVersion(
        runtimeTopicGeneratorVersion,
        'runtimeTopicGeneratorVersion'
    );

    const result = await pool.query(`
        SELECT topic_generator_version
        FROM ranked_system_configuration
        WHERE configuration_key = 'global'
        LIMIT 1
    `);

    const databaseVersion = cleanVersion(
        result.rows[0]?.topic_generator_version,
        'ranked_system_configuration.topic_generator_version'
    );

    if (databaseVersion !== runtimeVersion) {
        throw new Error(
            '[RankedReadiness] Refusing to start because the Ranked topic ' +
            'generator version is inconsistent. ' +
            `Runtime: ${runtimeVersion}. Database: ${databaseVersion}. ` +
            'Apply a forward Ranked configuration migration before deploying.'
        );
    }

    return Object.freeze({
        runtimeTopicGeneratorVersion: runtimeVersion,
        databaseTopicGeneratorVersion: databaseVersion,
    });
}
