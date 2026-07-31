import express from 'express';

import {
    listEligibleRankedPhilosophers,
} from './lib/rankedPhilosopherCatalog.js';

const RANKED_PHILOSOPHER_ELIGIBILITY_SCHEMA_VERSION = 1;

export function createRankedPhilosopherEligibilityRouter() {
    const router = express.Router();

    router.get(
        '/philosophers',
        (_req, res) => {
            const philosophers =
                listEligibleRankedPhilosophers();

            res.setHeader(
                'Cache-Control',
                'no-store'
            );

            return res.status(200).json({
                success: true,
                schemaVersion:
                    RANKED_PHILOSOPHER_ELIGIBILITY_SCHEMA_VERSION,
                philosopherIds:
                    philosophers.map(
                        (philosopher) => philosopher.id
                    ),
                philosophers,
                generatedAt:
                    new Date().toISOString(),
            });
        }
    );

    return router;
}

export const rankedPhilosopherEligibilityConstants =
    Object.freeze({
        schemaVersion:
            RANKED_PHILOSOPHER_ELIGIBILITY_SCHEMA_VERSION,
    });
