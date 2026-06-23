// aiJobWorker.js
// Background worker for persistent AI generation jobs.
//
// This checks the ai_generation_jobs table every 10 seconds
// and processes any pending jobs.
//
// Add this to server.js as a side-effect import:
// import './aiJobWorker.js';

import { processQueuedAIJobs } from './aiJobs.js';

const INTERVAL_MS = 10_000;
let isRunning = false;

async function tick() {
    if (isRunning) return;

    isRunning = true;

    try {
        const count = await processQueuedAIJobs(3);

        if (count > 0) {
            console.log(`[AIJobWorker] Picked up ${count} pending job(s).`);
        }
    } catch (err) {
        console.error('[AIJobWorker] Tick error:', err.message);
    } finally {
        isRunning = false;
    }
}

console.log('[AIJobWorker] Started.');

// Run once shortly after server startup.
setTimeout(tick, 2_000);

// Then keep checking for pending jobs.
setInterval(tick, INTERVAL_MS);
