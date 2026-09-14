// env.js
// Must be the first import in server.js.
// ES module imports are hoisted and evaluated before the importing file's body runs,
// so placing dotenv.config() inside server.js body is too late for sibling imports
// like pushScheduler.js and apnsService.js.
// Importing this file first guarantees process.env is populated before any other
// module initializes.

import dotenv from 'dotenv';
import { installAnthropicUsageTracking } from './lib/anthropicUsageTracking.js';

dotenv.config();
installAnthropicUsageTracking();
