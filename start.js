// Production entrypoint. Load environment first, verify Ranked configuration,
// then start background workers and the HTTP server.
import './env.js';

async function verifyRankedReadiness() {
    const connectionString =
        process.env.DATABASE_URL?.trim();

    if (!connectionString) {
        throw new Error(
            '[Startup] DATABASE_URL is required.'
        );
    }

    const [
        { default: pg },
        { rankedTopicGeneratorConstants },
        { assertRankedTopicGeneratorConfiguration },
    ] = await Promise.all([
        import('pg'),
        import('./lib/rankedTopicGeneratorService.js'),
        import('./lib/rankedConfigurationReadiness.js'),
    ]);

    const { Pool } = pg;
    const pool = new Pool({
        connectionString,
        ssl: connectionString.includes('railway')
            ? { rejectUnauthorized: false }
            : false,
        max: 1,
    });

    try {
        const readiness =
            await assertRankedTopicGeneratorConfiguration({
                pool,
                runtimeTopicGeneratorVersion:
                    rankedTopicGeneratorConstants
                        .defaultGeneratorVersion,
            });

        console.log(
            '[RankedReadiness] Topic generator configuration verified:',
            readiness.runtimeTopicGeneratorVersion
        );
    } finally {
        await pool.end();
    }
}

async function start() {
    await verifyRankedReadiness();

    await import('./appleProceedsSyncWorker.js');
    await import('./appleSubscriptionStatusReconciliationWorker.js');
    await import('./server.js');
}

start().catch((error) => {
    console.error(
        '[Startup] Refusing to start:',
        error?.stack || error
    );
    process.exit(1);
});
