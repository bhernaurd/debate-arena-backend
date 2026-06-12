// =====================================================================
// routes/questions.js — Question Generator endpoint for The Agora
// (FINAL v3: alias normalization, unlimited generation, generation_id)
// =====================================================================
//
// ENDPOINTS:
//   POST  /api/questions/generate   -> generates 3 philosopher-specific debate questions
//   PATCH /api/questions/:id/used   -> marks a question as used when a debate starts
//
// CHANGES IN v3:
//   - PHILOSOPHER_ALIASES map: "Nietzsche" and "Jung" (and any casing of
//     the full names) are normalized to canonical names BEFORE validation,
//     so the app can send either short or full names safely.
//   - Clear swap-in points for your EXISTING shared Postgres pool and
//     your EXISTING Claude model/helper (see TODO comments below).
//
// =====================================================================

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// ---------------------------------------------------------------------
// DATABASE POOL
// ---------------------------------------------------------------------
// TODO (IMPORTANT): If your backend already has a shared pool — very
// likely, since your daily-challenge cron and push-token cleanup talk to
// the database — REUSE IT instead of the block below. Find where your
// existing code does `new Pool(...)`. If it's in its own file, e.g.:
//
//     // db.js
//     module.exports = pool;
//
// then DELETE the block below and replace it with ONE line:
//
//     const pool = require('../db');   // adjust the path to your file
//
// If your pool is created inside index.js/server.js and not exported,
// the cleanest fix is to move it into its own db.js and require it from
// both places. Two pools won't crash anything, but they double your
// Postgres connections, and Railway's free-tier connection cap is low.
//
// Only keep the block below if you truly have no existing pool:
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------------------------------------------------------------------
// CLAUDE CLIENT
// ---------------------------------------------------------------------
// TODO (IMPORTANT): Your daily-challenge generation already calls Claude
// successfully. Open that file and check two things:
//   1. HOW it calls Claude — if it uses @anthropic-ai/sdk like below,
//      you're done. If it uses raw fetch to api.anthropic.com, copy that
//      pattern into callClaudeForQuestions() instead.
//   2. WHICH model string it uses — and use THE SAME ONE here. Replace
//      CLAUDE_MODEL below with whatever string your daily challenge uses,
//      since that string is proven to work with your API key and plan.
// 'claude-sonnet-4-6' is a valid current model name and a good default,
// but "matches what already works in your backend" beats "valid".
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = 'claude-sonnet-4-6'; // <-- match your daily-challenge model string

// ---------------------------------------------------------------------
// 1. CONFIG
// ---------------------------------------------------------------------

// Canonical names — these are what get stored in the database and what
// the themes map is keyed on. Keeping storage canonical matters for
// duplicate prevention: if "Nietzsche" and "Friedrich Nietzsche" were
// stored as different philosophers, the exclusion list would split in two.
const PHILOSOPHER_ALIASES = {
  'socrates': 'Socrates',
  'plato': 'Plato',
  'aristotle': 'Aristotle',
  'nietzsche': 'Friedrich Nietzsche',
  'friedrich nietzsche': 'Friedrich Nietzsche',
  'marcus aurelius': 'Marcus Aurelius',
  'jung': 'Carl Jung',
  'carl jung': 'Carl Jung',
};

// Normalizes whatever the app sends ("Nietzsche", "nietzsche",
// "Friedrich Nietzsche") to the canonical name, or null if unknown.
function resolvePhilosopher(input) {
  if (typeof input !== 'string') return null;
  return PHILOSOPHER_ALIASES[input.trim().toLowerCase()] || null;
}

// Themes injected into the AI prompt so questions stay on-brand for each
// philosopher — same guardrail philosophy as your validateChallenge().
const PHILOSOPHER_THEMES = {
  'Socrates':
    'self-examination, virtue, knowledge vs ignorance, truth, justice, the examined life, moral confidence, questioning assumptions, admitting what you do not know',
  'Plato':
    'truth vs illusion, the soul, justice, the Forms, the Allegory of the Cave, the ideal society, education, appearance vs reality, who should rule',
  'Aristotle':
    'virtue, habit, excellence, eudaimonia (flourishing), friendship, purpose, moderation and the golden mean, practical wisdom, character built through action',
  'Friedrich Nietzsche':
    'values, suffering as fuel, herd morality, self-overcoming, "God is dead", the Ubermensch, comfort vs greatness, weakness, creating your own meaning, resentment',
  'Marcus Aurelius':
    'what is in your control, discipline, duty, mortality and memento mori, adversity, emotional restraint, acceptance, responsibility, fate, the opinions of others',
  'Carl Jung':
    'the shadow, individuation, dreams, projection, archetypes, the unconscious, identity, inner conflict, the persona vs the true self, integrating what you deny',
};

// How many recent questions to feed the AI as "do not repeat" context.
const RECENT_EXCLUSION_COUNT = 20;

// ---------------------------------------------------------------------
// 2. HELPERS
// ---------------------------------------------------------------------

// Normalize question text for duplicate comparison:
// lowercase, strip punctuation, collapse whitespace.
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Simple similarity check (no embeddings): duplicate if exact match, one
// contains the other, or they share > 80% of the shorter question's words.
function tooSimilar(a, b) {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const wordsA = new Set(a.split(' '));
  const wordsB = new Set(b.split(' '));
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  const overlap = shared / Math.min(wordsA.size, wordsB.size);
  return overlap > 0.8;
}

// Build the exact AI prompt.
function buildPrompt(philosopher, themes, recentQuestions, count) {
  const exclusionBlock = recentQuestions.length > 0
    ? `Do NOT repeat or closely paraphrase any of these recent questions:\n${recentQuestions.map(q => `- ${q}`).join('\n')}`
    : 'There are no recent questions to avoid.';

  return `You are generating debate questions for "The Agora", an iOS app where users debate history's greatest philosophers in real-time conversation.

Philosopher: ${philosopher}
Core themes for this philosopher: ${themes}

Generate exactly ${count} debate questions.

Rules for every question:
- One sentence. Under 140 characters whenever possible. Never a paragraph.
- It must create tension and invite real disagreement. It should be arguable, never a definition, trivia, or "explain X" question.
- It must feel like ${philosopher} is challenging the user personally and directly, not like a school essay prompt.
- It must be philosophically accurate to ${philosopher}'s actual ideas and concerns. Never invent quotes. Never attribute claims this philosopher did not make.
- No generic self-help phrasing. No academic jargon.
- Each of the ${count} questions must cover a DIFFERENT theme.

${exclusionBlock}

Difficulty guide:
- beginner: requires no philosophy background, purely intuitive
- intermediate: touches a named concept (e.g. herd morality, the Cave) in plain language
- advanced: forces the user to defend a position against the philosopher's strongest idea

Return ONLY valid JSON with no markdown, no backticks, and no text before or after it, in exactly this shape:
{"questions":[{"question":"string","theme":"string","difficulty":"beginner | intermediate | advanced"}]}`;
}

// Call Claude and safely parse the JSON response.
async function callClaudeForQuestions(philosopher, recentQuestions, count) {
  const prompt = buildPrompt(
    philosopher,
    PHILOSOPHER_THEMES[philosopher],
    recentQuestions,
    count
  );

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  // Strip markdown fences if the model added them despite instructions.
  const cleaned = raw.replace(/```json|```/g, '').trim();

  const parsed = JSON.parse(cleaned); // throws if invalid -> caught by caller
  if (!Array.isArray(parsed.questions)) {
    throw new Error('AI response missing questions array');
  }

  // Validate and sanitize each question.
  return parsed.questions
    .filter(q => typeof q.question === 'string' && q.question.trim().length > 0)
    .map(q => ({
      question: q.question.trim(),
      theme: typeof q.theme === 'string' ? q.theme.trim() : 'general',
      difficulty: ['beginner', 'intermediate', 'advanced'].includes(q.difficulty)
        ? q.difficulty
        : 'intermediate',
    }));
}

// ---------------------------------------------------------------------
// 3. POST /api/questions/generate
//    Unlimited generation — no daily limits, no pro checks.
// ---------------------------------------------------------------------

router.post('/generate', async (req, res) => {
  try {
    const { userId, count = 3 } = req.body;

    // --- Validation ---
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    // Normalize "Nietzsche" -> "Friedrich Nietzsche", "Jung" -> "Carl Jung", etc.
    const philosopher = resolvePhilosopher(req.body.philosopher);
    if (!philosopher) {
      return res.status(400).json({ success: false, error: 'Invalid philosopher' });
    }

    const safeCount = Math.min(Math.max(parseInt(count, 10) || 3, 1), 3);

    // --- Fetch recent questions for the exclusion list (canonical name) ---
    const recent = await pool.query(
      `SELECT question_text, question_normalized
       FROM generated_questions
       WHERE user_id = $1 AND philosopher = $2
       ORDER BY generated_at DESC
       LIMIT $3`,
      [userId, philosopher, RECENT_EXCLUSION_COUNT]
    );
    const recentTexts = recent.rows.map(r => r.question_text);
    const recentNormalized = recent.rows.map(r => r.question_normalized);

    // --- Generate, with ONE retry if duplicates slip through ---
    let accepted = [];
    for (let attempt = 0; attempt < 2 && accepted.length < safeCount; attempt++) {
      const generated = await callClaudeForQuestions(
        philosopher,
        // On retry, also exclude what we already accepted this round
        [...recentTexts, ...accepted.map(q => q.question)],
        safeCount - accepted.length
      );

      for (const q of generated) {
        const norm = normalize(q.question);
        const dupAgainstRecent = recentNormalized.some(r => tooSimilar(norm, r));
        const dupAgainstBatch = accepted.some(a => tooSimilar(norm, normalize(a.question)));
        if (!dupAgainstRecent && !dupAgainstBatch) {
          accepted.push(q);
        }
        if (accepted.length >= safeCount) break;
      }
    }

    if (accepted.length === 0) {
      return res.status(502).json({
        success: false,
        error: 'Could not generate fresh questions. Please try again.',
      });
    }

    // --- Save to database with ONE shared generation_id for the batch ---
    const generationId = crypto.randomUUID();

    const saved = [];
    for (const q of accepted) {
      const insert = await pool.query(
        `INSERT INTO generated_questions
           (generation_id, user_id, philosopher, question_text, question_normalized, theme, difficulty, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ai_generated')
         RETURNING id`,
        [generationId, userId, philosopher, q.question, normalize(q.question), q.theme, q.difficulty]
      );
      saved.push({
        id: insert.rows[0].id,
        question: q.question,
        theme: q.theme,
        difficulty: q.difficulty,
      });
    }

    return res.json({ success: true, questions: saved });
  } catch (err) {
    console.error('[questions/generate] error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Question generation failed. Please try again.',
    });
  }
});

// ---------------------------------------------------------------------
// 4. PATCH /api/questions/:id/used
//    Fire-and-forget from the app when the user starts a debate with a
//    generated question. Failure here must NEVER block the debate.
// ---------------------------------------------------------------------

router.patch('/:id/used', async (req, res) => {
  try {
    await pool.query(
      `UPDATE generated_questions SET used_at = now() WHERE id = $1 AND used_at IS NULL`,
      [req.params.id]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[questions/used] error:', err.message);
    return res.status(500).json({ success: false });
  }
});

module.exports = router;
