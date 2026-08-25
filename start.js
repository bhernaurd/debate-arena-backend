// Production entrypoint. Load environment first, then background workers, then HTTP server.
import './env.js';
import './appleProceedsSyncWorker.js';
import './server.js';
