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
app.use(express.json({ limit: '10kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' }
});
app.use('/debate', limiter);

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
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system,
      messages: validMessages
    });

    const reply = response.content?.find(b => b.type === 'text')?.text ?? '';
    res.json({ reply });
  } catch (error) {
    console.error('Anthropic API error:', error);
    res.status(500).json({ error: 'Failed to get response from AI.' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Debate Arena backend running on port ${PORT}`);
});
