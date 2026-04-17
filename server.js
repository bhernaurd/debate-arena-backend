import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '50kb' })); // Increased to handle summaries

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' }
});
app.use('/debate', limiter);

// Summarize older messages using Haiku (cheap)
async function summarizeMessages(messages) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Summarize this philosophical debate exchange in under 200 words. 
      Preserve the core arguments, positions taken, key philosophical concepts, 
      and any important points of agreement or disagreement. This will be used 
      to maintain debate continuity:\n\n${JSON.stringify(messages)}`
    }]
  });
  return response.content?.find(b => b.type === 'text')?.text ?? '';
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
  if (!system || typeof system !== 'string') {
    return res.status(400).json({ error: 'system prompt is required.' });
  }

  const validMessages = messages.filter(m =>
    m && typeof m.role === 'string' && typeof m.content === 'string' &&
    (m.role === 'user' || m.role === 'assistant')
  );

  if (validMessages.length === 0) {
    return res.status(400).json({ error: 'No valid messages provided.' });
  }

  try {
    // Manage history before sending to main model
    const managedMessages = await manageHistory(validMessages);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system,
      messages: managedMessages
    });

    const reply = response.content?.find(b => b.type === 'text')?.text ?? '';

    // Return both reply and managed messages so client stays in sync
    res.json({ reply, messages: managedMessages });
  } catch (error) {
    console.error('Anthropic API error:', error);
    res.status(500).json({ error: 'Failed to get response from AI.' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Debate Arena backend running on port ${PORT}`);
});
