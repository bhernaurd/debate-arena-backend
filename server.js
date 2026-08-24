// Ranked start-request foundation added in migration 007.
// env.js must be first — loads dotenv before any module reads process.env
import './env.js';

import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import rateLimit from 'express-rate-limit';
import pg from 'pg';

import { createDailyChallengeRouter } from './dailyChallenge.js';
import { createPushRouter } from './pushRoutes.js';
import questionsRouter from './questions.js';
import { createAnalyticsRouter } from './analytics.js';
import aiJobsRouter from './aiJobs.js';
import { createAppStoreSubscriptionRouter } from './appStoreSubscriptionRoutes.js';
import { createSubscriptionAdminRouter } from './subscriptionAdminRoutes.js';
import { createSubscriptionAdminDashboardRouter } from './subscriptionAdminDashboardRoutes.js';
import { createPaywallConfigurationRouter } from './paywallConfigurationRoutes.js';
import { createAffiliateRouter } from './affiliateRoutes.js';
import { createAccountAuthRouter } from './accountAuthRoutes.js';
import { createAccountSubscriptionEntitlementRouter } from './accountSubscriptionEntitlementRoutes.js';
import { createAccountDebateHistoryRouter } from './accountDebateHistoryRoutes.js';
import { createAccountAchievementRouter } from './accountAchievementRoutes.js';
import { createAccountDailyChallengeProgressRouter } from './accountDailyChallengeProgressRoutes.js';
import { createAccountRankedProfileRouter } from './accountRankedProfileRoutes.js';
import { createAccountRankedPlacementRouter } from './accountRankedPlacementRoutes.js';
import { createAccountRankedDebateRouter } from './accountRankedDebateRoutes.js';
import { createAccountRankedLadderRouter } from './accountRankedLadderRoutes.js';
import { createRankedPhilosopherEligibilityRouter } from './rankedPhilosopherEligibilityRoutes.js';
import { createAccountAuthService } from './lib/accountAuthService.js';
import { createAccountDebateHistoryService } from './lib/accountDebateHistoryService.js';
import { createAccountAchievementService } from './lib/accountAchievementService.js';
import { createAccountDailyChallengeProgressService } from './lib/accountDailyChallengeProgressService.js';
import { createAccountRankedProfileService } from './lib/accountRankedProfileService.js';
import { createAccountRankedPlacementService } from './lib/accountRankedPlacementService.js';
import { createAccountRankedDebateService } from './lib/accountRankedDebateService.js';
import { createAccountRankedLadderService } from './lib/accountRankedLadderService.js';
import { createAccountRankedUnifiedDebateService } from './lib/accountRankedUnifiedDebateService.js';
import { createRankedRatingService } from './lib/rankedRatingService.js';
import { createRankedDebateEngineService } from './lib/rankedDebateEngineService.js';
import { createAccountProAccessService } from './lib/accountProAccessService.js';
import { createRankedTopicGeneratorService } from './lib/rankedTopicGeneratorService.js';
import {
  createAccountSubscriptionOwnershipService,
} from './lib/accountSubscriptionOwnership.js';
import {
  createAffiliateSubscriptionAttributionService,
} from './lib/affiliateSubscriptionAttributionService.js';

import './pushScheduler.js';
import './aiJobWorker.js';

const { Pool } = pg;

const app = express();
app.all('/tiktoksEj6XzEmPpvavjyCl6uI5SXIFhGYJ6hC.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  return res
    .status(200)
    .send('tiktok-developers-site-verification=sEj6XzEmPpvavjyCl6uI5SXIFhGYJ6hC\n');
});
app.use(express.static('public'));
const PORT = process.env.PORT || 3000;

function readBooleanEnvironmentVariable(
  name,
  {
    defaultValue,
  }
) {
  const rawValue = process.env[name];

  if (
    rawValue == null ||
    rawValue.trim() === ''
  ) {
    return defaultValue;
  }

  switch (rawValue.trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
    case 'on':
      return true;

    case 'false':
    case '0':
    case 'no':
    case 'off':
      return false;

    default:
      throw new Error(
        `${name} must be true or false.`
      );
  }
}

const rankedRequiresProAccess =
  readBooleanEnvironmentVariable(
    'RANKED_REQUIRE_PRO',
    {
      defaultValue: true,
    }
  );

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

app.set('trust proxy', 1);

app.use(cors());

// App Store notification envelopes and authenticated debate-history batches
// can be larger than ordinary app requests. Their route-specific parsers are
// installed before the existing 50 KB global parser.
app.use('/api/app-store', express.json({ limit: '128kb' }));

const accountHistoryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'too_many_history_sync_requests',
      message: 'Too many history sync requests. Please try again shortly.',
      retryable: true,
    },
  },
});

app.use(
  '/api/account/history',
  accountHistoryLimiter,
  express.json({ limit: '2mb' })
);

const accountDailyChallengeProgressLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'too_many_daily_challenge_progress_requests',
      message: 'Too many Daily Challenge progress requests. Please try again shortly.',
      retryable: true,
    },
  },
});

app.use(
  '/api/account/daily-challenge-progress',
  accountDailyChallengeProgressLimiter,
  express.json({ limit: '512kb' })
);

app.use(express.json({ limit: '50kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

const subscriptionSyncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many subscription sync requests.' },
});

const affiliatePortalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many affiliate dashboard requests. Please try again shortly.',
});

const accountChallengeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'too_many_authentication_requests',
      message: 'Too many authentication requests. Please try again shortly.',
      retryable: true,
    },
  },
});

const accountSignInLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'too_many_authentication_requests',
      message: 'Too many authentication requests. Please try again shortly.',
      retryable: true,
    },
  },
});

const accountSessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'too_many_authentication_requests',
      message: 'Too many authentication requests. Please try again shortly.',
      retryable: true,
    },
  },
});

const accountAchievementLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'too_many_achievement_sync_requests',
      message: 'Too many achievement sync requests. Please try again shortly.',
      retryable: true,
    },
  },
});

const accountRankedProfileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'too_many_ranked_profile_requests',
      message: 'Too many Ranked profile requests. Please try again shortly.',
      retryable: true,
    },
  },
});

const accountRankedPlacementLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'too_many_ranked_placement_requests',
      message: 'Too many Ranked placement requests. Please try again shortly.',
      retryable: true,
    },
  },
});

const accountRankedDebateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'too_many_ranked_debate_requests',
      message: 'Too many Ranked debate requests. Please try again shortly.',
      retryable: true,
    },
  },
});

const accountRankedLadderStartLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'too_many_ranked_ladder_start_requests',
      message: 'Too many Ranked ladder start requests. Please try again shortly.',
      retryable: true,
    },
  },
});

app.use('/debate', limiter);
app.use('/api/app-store/sync-transaction', subscriptionSyncLimiter);

// Construct one shared account service. This validates all required Apple and
// Agora authentication configuration during startup and ensures account routes
// and authenticated subscription ownership use the same authorization rules.
const accountAuthService = createAccountAuthService({ pool });

const accountSubscriptionOwnershipService =
  createAccountSubscriptionOwnershipService({
    pool,
    accountAuthService,
  });

const affiliateSubscriptionAttributionEnabled =
  readBooleanEnvironmentVariable(
    'AFFILIATE_SUBSCRIPTION_ATTRIBUTION_ENABLED',
    { defaultValue: true }
  );

const affiliateAppClipHandoffEnabled =
  readBooleanEnvironmentVariable(
    'AFFILIATE_APP_CLIP_HANDOFF_ENABLED',
    { defaultValue: false }
  );

const affiliateSubscriptionAttributionService =
  affiliateSubscriptionAttributionEnabled
    ? createAffiliateSubscriptionAttributionService({
        pool,
        requireReferralHandoffForNewAttribution:
          affiliateAppClipHandoffEnabled,
      })
    : null;

if (!affiliateSubscriptionAttributionEnabled) {
  console.warn(
    '[AffiliateAttribution] Live Apple subscription attribution is disabled. Stored verified transactions can be reconciled later.'
  );
}

const accountDebateHistoryService =
  createAccountDebateHistoryService({
    pool,
    accountAuthService,
  });

const accountAchievementService =
  createAccountAchievementService({
    pool,
    accountAuthService,
  });

const accountDailyChallengeProgressService =
  createAccountDailyChallengeProgressService({
    pool,
    accountAuthService,
  });

const accountRankedProfileService =
  createAccountRankedProfileService({
    pool,
    accountAuthService,
  });

const accountProAccessService =
  createAccountProAccessService({
    pool,
  });

const rankedProAccessService =
  rankedRequiresProAccess
    ? accountProAccessService
    : Object.freeze({
        async requireCurrentProAccess({
          accountId,
        } = {}) {
          const cleanAccountId =
            typeof accountId === 'string'
              ? accountId.trim().toLowerCase()
              : '';

          if (!cleanAccountId) {
            throw new Error(
              'Ranked Pro testing bypass received an invalid accountId.'
            );
          }

          return Object.freeze({
            accountId: cleanAccountId,
            hasProAccess: true,
            accessReason:
              'ranked_testing_bypass',
          });
        },
      });

if (!rankedRequiresProAccess) {
  console.warn(
    '[Ranked] WARNING: Agora Pro access is bypassed because RANKED_REQUIRE_PRO=false. Restore true before release.'
  );
}

const rankedTopicGeneratorService =
  createRankedTopicGeneratorService();

const accountRankedPlacementService =
  createAccountRankedPlacementService({
    pool,
    accountAuthService,
    proAccessService: rankedProAccessService,
    topicGeneratorService: rankedTopicGeneratorService,
  });

const rankedDebateEngineService =
  createRankedDebateEngineService();

const rankedRatingService =
  createRankedRatingService();

const baseAccountRankedDebateService =
  createAccountRankedDebateService({
    pool,
    accountAuthService,
    proAccessService: rankedProAccessService,
    debateEngineService: rankedDebateEngineService,
  });

const accountRankedLadderService =
  createAccountRankedLadderService({
    pool,
    accountAuthService,
    proAccessService: rankedProAccessService,
    topicGeneratorService: rankedTopicGeneratorService,
    ratingService: rankedRatingService,
  });

const accountRankedDebateService =
  createAccountRankedUnifiedDebateService({
    pool,
    baseService: baseAccountRankedDebateService,
    accountAuthService,
    proAccessService: rankedProAccessService,
    ratingService: rankedRatingService,
  });

const accountAuthRouter = createAccountAuthRouter(pool, {
  service: accountAuthService,
});

app.use(
  '/api/account/history',
  createAccountDebateHistoryRouter({
    service: accountDebateHistoryService,
  })
);

app.use(
  '/api/account/achievements',
  accountAchievementLimiter,
  createAccountAchievementRouter({
    service: accountAchievementService,
  })
);

app.use(
  '/api/account/daily-challenge-progress',
  createAccountDailyChallengeProgressRouter({
    service: accountDailyChallengeProgressService,
  })
);

app.use(
  '/api/account/ranked/philosophers',
  accountRankedProfileLimiter
);

app.use(
  '/api/account/ranked',
  createRankedPhilosopherEligibilityRouter()
);

app.use(
  '/api/account/ranked/placements/start',
  accountRankedPlacementLimiter
);

app.use(
  '/api/account/ranked',
  createAccountRankedPlacementRouter({
    service: accountRankedPlacementService,
  })
);

app.use(
  '/api/account/ranked/ladder/start',
  accountRankedLadderStartLimiter
);

app.use(
  '/api/account/ranked',
  createAccountRankedLadderRouter({
    service: accountRankedLadderService,
  })
);

app.use(
  '/api/account/ranked',
  accountRankedDebateLimiter,
  createAccountRankedDebateRouter({
    service: accountRankedDebateService,
  })
);

app.use(
  '/api/account/ranked',
  accountRankedProfileLimiter,
  createAccountRankedProfileRouter({
    service: accountRankedProfileService,
  })
);

app.use('/api/account/apple/challenge', accountChallengeLimiter);
app.use('/api/account/apple/sign-in', accountSignInLimiter);
app.use('/api/account/session', accountSessionLimiter);
app.use(
  '/api/account/subscription',
  accountSessionLimiter,
  createAccountSubscriptionEntitlementRouter({
    accountAuthService,
    proAccessService: accountProAccessService,
  })
);
app.use('/api/account', accountAuthRouter);

app.use('/affiliate', affiliatePortalLimiter);
app.use(createAffiliateRouter(pool, {
  accountAuthService,
  affiliateSubscriptionAttributionService,
  appClipHandoffEnabled: affiliateAppClipHandoffEnabled,
}));
app.use(createPaywallConfigurationRouter());
app.use(createDailyChallengeRouter(pool));
app.use(createPushRouter(pool));
app.use(questionsRouter);
app.use(aiJobsRouter);
app.use(createAppStoreSubscriptionRouter(pool, {
  accountSubscriptionOwnershipService,
  affiliateSubscriptionAttributionService,
}));

app.use('/api/subscription-admin', createSubscriptionAdminRouter(pool, {
  adminKey:
    process.env.SUBSCRIPTION_DASHBOARD_ADMIN_KEY ||
    process.env.ANALYTICS_ADMIN_KEY,
}));

app.use('/subscription-admin', createSubscriptionAdminDashboardRouter({
  adminKey:
    process.env.SUBSCRIPTION_DASHBOARD_ADMIN_KEY ||
    process.env.ANALYTICS_ADMIN_KEY,
  port: PORT,
}));

app.use('/analytics', createAnalyticsRouter(pool, {
  adminKey: process.env.ANALYTICS_ADMIN_KEY,
}));

async function summarizeMessages(messages) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [
      {
        role: 'user',
        content: `Summarize this philosophical debate exchange in under 200 words. 
Preserve the core arguments, positions taken, key philosophical concepts, 
and any important points of agreement or disagreement. This will be used 
to maintain debate continuity:\n\n${JSON.stringify(messages)}`,
      },
    ],
  });

  return response.content?.find((b) => b.type === 'text')?.text ?? '';
}

async function manageHistory(messages) {
  if (messages.length <= 20) return messages;

  const olderMessages = messages.slice(0, -10);
  const recentMessages = messages.slice(-10);
  const summary = await summarizeMessages(olderMessages);

  return [
    {
      role: 'user',
      content: `[Earlier debate summary: ${summary}]`,
    },
    {
      role: 'assistant',
      content: 'I recall our previous exchange. Let us continue from where we left off.',
    },
    ...recentMessages,
  ];
}

app.post('/debate', async (req, res) => {
  const { messages, system } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }

  if (!system || typeof system !== 'string') {
    return res.status(400).json({ error: 'system prompt is required.' });
  }

  const validMessages = messages.filter((m) =>
    m &&
    typeof m.role === 'string' &&
    typeof m.content === 'string' &&
    (m.role === 'user' || m.role === 'assistant')
  );

  if (validMessages.length === 0) {
    return res.status(400).json({ error: 'No valid messages provided.' });
  }

  try {
    const managedMessages = await manageHistory(validMessages);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system,
      messages: managedMessages,
    });

    const reply = response.content?.find((b) => b.type === 'text')?.text ?? '';

    return res.json({
      reply,
      messages: managedMessages,
    });
  } catch (error) {
    console.error('Anthropic API error:', error);
    return res.status(500).json({ error: 'Failed to get response from AI.' });
  }
});

app.get('/health', (_, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Debate Arena backend running on port ${PORT}`);
});
