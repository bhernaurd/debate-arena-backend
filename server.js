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

// App Store notification envelopes contain nested signed JWS payloads and can
// be larger than ordinary app requests. Parse only this route family with the
// larger limit, then preserve the existing 50 KB global limit everywhere else.
app.use('/api/app-store', express.json({ limit: '128kb' }));
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

app.use('/debate', limiter);
app.use('/api/app-store/sync-transaction', subscriptionSyncLimiter);

app.use(createDailyChallengeRouter(pool));
app.use(createPushRouter(pool));
app.use(questionsRouter);
app.use(aiJobsRouter);
app.use(createAppStoreSubscriptionRouter(pool));

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
