// env.js must be first — loads dotenv before any module reads process.env
import './env.js';

import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import rateLimit from 'express-rate-limit';

import dailyChallengeRouter from './dailyChallenge.js';
import pushRouter from './pushRoutes.js';
import questionsRouter from './questions.js';
import './pushScheduler.js';  // registers cron jobs on startup

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Anthropic({
apiKey: process.env.ANTHROPIC_API_KEY
});

// Required for Railway proxy + express-rate-limit.
// Must come before rateLimit middleware.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '50kb' }));

// Rate limiter for debate endpoint only
const limiter = rateLimit({
windowMs: 60 * 1000,
max: 30,
standardHeaders: true,
legacyHeaders: false,
message: { error: 'Too many requests. Please slow down.' }
});

app.use('/debate', limiter);

// Routes
app.use(dailyChallengeRouter);
app.use(pushRouter);
app.use(questionsRouter);

// Summarize older messages using Haiku
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
to maintain debate continuity:\n\n${JSON.stringify(messages)}`
}
]
});

const summary = response.content
?.filter(block => block.type === 'text')
?.map(block => block.text)
?.join('\n')
?.trim() ?? '';

return summary;
}

// Manage conversation history to prevent payload bloat
async function manageHistory(messages) {
if (messages.length <= 20) return messages;

const olderMessages = messages.slice(0, -10);
const recentMessages = messages.slice(-10);
const summary = await summarizeMessages(olderMessages);

return [
{
role: 'user',
content: `[Earlier debate summary: ${summary}]`
},
{
role: 'assistant',
content: 'I recall our previous exchange. Let us continue from where we left off.'
},
...recentMessages
];
}

app.post('/debate', async (req, res) => {
const { messages, system } = req.body;

if (!messages || !Array.isArray(messages) || messages.length === 0) {
return res.status(400).json({ error: 'messages array is required.' });
}

if (!system || typeof system !== 'string' || system.trim().length === 0) {
return res.status(400).json({ error: 'system prompt is required.' });
}

const validMessages = messages.filter(m =>
m &&
typeof m.role === 'string' &&
typeof m.content === 'string' &&
m.content.trim().length > 0 &&
(m.role === 'user' || m.role === 'assistant')
);

if (validMessages.length === 0) {
return res.status(400).json({ error: 'No valid messages provided.' });
}

try {
const managedMessages = await manageHistory(validMessages);

```
console.log('[Debate] Sending request to Claude:', {
  model: 'claude-sonnet-4-5-20250929',
  messageCount: managedMessages.length,
  systemLength: system.length
});

const response = await client.messages.create({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  system: system.trim(),
  messages: managedMessages
});

const reply = response.content
  ?.filter(block => block.type === 'text')
  ?.map(block => block.text)
  ?.join('\n')
  ?.trim() ?? '';

if (!reply) {
  console.error('[Debate] Empty Claude reply:', JSON.stringify(response));
  return res.status(500).json({ error: 'AI returned an empty response.' });
}

return res.json({
  reply,
  messages: managedMessages
});
```

} catch (error) {
console.error('[Debate] Anthropic API error full:', error?.stack || error);
return res.status(500).json({ error: 'Failed to get response from AI.' });
}
});

app.get('/health', (_, res) => {
res.json({ status: 'ok' });
});

app.listen(PORT, () => {
console.log(`Debate Arena backend running on port ${PORT}`);
});
