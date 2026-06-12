// questions.js
// ES module — matches the import/export style of server.js and dailyChallenge.js
//
// Question Generator for The Agora.
//   POST  /api/questions/generate   -> 3 philosopher-specific debate questions
//   PATCH /api/questions/:id/used   -> sets used_at when a debate starts
//
// Storage: Railway Postgres, using the existing generated_questions table
// (id, generation_id, user_id, philosopher, question_text,
//  question_normalized, theme, difficulty, source, generated_at, used_at).
//
// Model: same one the Daily Challenge already uses successfully
// (claude-haiku-4-5-20251001) — proven with this API key, and cheap,
// which matters since generation is unlimited for now.
//
// Unlimited generation: no daily limits, no pro checks, no limitReached.
// Duplicate prevention is fully active: recent-question exclusion list in
// the prompt, normalized comparison, similarity check, one retry.
//
// REQUIRES: npm install pg   (dailyChallenge.js doesn't use a database,
// so pg is likely not in package.json yet — install it before deploying.)
//
// Wiring in server.js (same style as dailyChallenge):
//   import questionsRouter from './questions.js';
//   app.use(questionsRouter);

import express from 'express';
import crypto from 'crypto';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Postgres pool ───────────────────────────────────────────────────────────
// Railway gives you two kinds of DATABASE_URL:
//   - internal  (host ends in .railway.internal) -> no SSL
//   - public proxy (host like xxxx.proxy.rlwy.net) -> SSL required
// This handles both automatically.

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway.internal')
        ? false
        : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
    console.error('[Questions] Postgres pool error:', err.message);
});

// ─── Philosopher normalization ───────────────────────────────────────────────
// Accepts Swift display names ("Nietzsche", "Marcus Aurelius", "Carl Jung"),
// full names ("Friedrich Nietzsche"), AND backend ids ("aurelius", "jung"),
// so it works whether the app sends philosopher.name or philosopher.id.
//
// The canonical name is what gets STORED — keeping storage canonical is what
// makes duplicate prevention work. If "Nietzsche" and "Friedrich Nietzsche"
// were stored as different philosophers, the exclusion list would split.

const PHILOSOPHER_ALIASES = {
    'socrates': 'Socrates',
    'plato': 'Plato',
    'aristotle': 'Aristotle',
    'nietzsche': 'Nietzsche',
    'friedrich nietzsche': 'Nietzsche',
    'marcus aurelius': 'Marcus Aurelius',
    'aurelius': 'Marcus Aurelius',
    'marcus': 'Marcus Aurelius',
    'jung': 'Carl Jung',
    'carl jung': 'Carl Jung',
};

function resolvePhilosopher(input) {
    if (typeof input !== 'string') return null;
    return PHILOSOPHER_ALIASES[input.trim().toLowerCase()] || null;
}

// Themes injected into the prompt so questions stay on-brand —
// same guardrail philosophy as validateChallenge() in dailyChallenge.js.
const PHILOSOPHER_THEMES = {
    'Socrates':
        'self-examination, virtue, knowledge vs ignorance, truth, justice, the examined life, moral confidence, questioning assumptions, admitting what you do not know',
    'Plato':
        'truth vs illusion, the soul, justice, the Forms, the Allegory of the Cave, the ideal society, education, appearance vs reality, who should rule',
    'Aristotle':
        'virtue, habit, excellence, eudaimonia (flourishing), friendship, purpose, moderation and the golden mean, practical wisdom, character built through action',
    'Nietzsche':
        'values, suffering as fuel, herd morality, self-overcoming, "God is dead", the Ubermensch, comfort vs greatness, weakness, creating your own meaning, resentment',
    'Marcus Aurelius':
        'what is in your control, discipline, duty, mortality and memento mori, adversity, emotional restraint, acceptance, responsibility, fate, the opinions of others',
    'Carl Jung':
        'the shadow, individuation, dreams, projection, archetypes, the unconscious, identity, inner conflict, the persona vs the true self, integrating what you deny',
};

// How many recent questions to feed the AI as "do not repeat" context.
const RECENT_EXCLUSION_COUNT = 20;

// ─── Duplicate helpers ───────────────────────────────────────────────────────

// Normalize question text for comparison:
// lowercase, strip punctuation, collapse whitespace.
function normalizeText(text) {
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

// ─── Claude generation ───────────────────────────────────────────────────────

function buildPrompt(philosopher, themes, recentQuestions, count) {
    const exclusionBlock = recentQuestions.length > 0
        ? `Do NOT repeat or closely paraphrase any of these recent questions:\n${recentQuestions.map(q => `- ${q}`).join('\n')}`
        : 'There are no recent questions to avoid.';

    return `You are generating debate questions for "The Agora", an iOS app where users debate history's greatest philosophers in real-time conversation. Tagline: "For centuries, you could only read the philosophers. Now you can debate them."

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

async function callClaudeForQuestions(philosopher, recentQuestionTexts, count) {
    const prompt = buildPrompt(
        philosopher,
        PHILOSOPHER_THEMES[philosopher],
        recentQuestionTexts,
        count
    );

    // Same model + call shape as generateChallenge() in dailyChallenge.js.
    const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content?.find(b => b.type === 'text')?.text ?? '';
    const clean = raw.replace(/```json|```/g, '').trim();

    const parsed = JSON.parse(clean); // throws if invalid -> caught by route handler
    if (!Array.isArray(parsed.questions)) {
        throw new Error('AI response missing questions array');
    }

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

// ─── POST /api/questions/generate ────────────────────────────────────────────
// Unlimited generation — no daily limits, no pro checks.

router.post('/api/questions/generate', async (req, res) => {
    try {
        const { userId, count = 3 } = req.body;

        if (!userId || typeof userId !== 'string') {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }

        // "Nietzsche" / "Friedrich Nietzsche" / "aurelius" / "Carl Jung" all resolve.
        const philosopher = resolvePhilosopher(req.body.philosopher);
        if (!philosopher) {
            return res.status(400).json({ success: false, error: 'Invalid philosopher' });
        }

        const safeCount = Math.min(Math.max(parseInt(count, 10) || 3, 1), 3);

        // Recent questions for this user + philosopher (exclusion list).
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

        // Generate, with ONE retry if duplicates slip through.
        let accepted = [];
        for (let attempt = 0; attempt < 2 && accepted.length < safeCount; attempt++) {
            const generated = await callClaudeForQuestions(
                philosopher,
                // On retry, also exclude what we already accepted this round
                [...recentTexts, ...accepted.map(q => q.question)],
                safeCount - accepted.length
            );

            for (const q of generated) {
                const norm = normalizeText(q.question);
                const dupAgainstRecent = recentNormalized.some(r => tooSimilar(norm, r));
                const dupAgainstBatch = accepted.some(a => tooSimilar(norm, normalizeText(a.question)));
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

        // Save with ONE shared generation_id for the whole batch
        // (one button tap = one generation = up to 3 rows).
        const generationId = crypto.randomUUID();

        const saved = [];
        for (const q of accepted) {
            const insert = await pool.query(
                `INSERT INTO generated_questions
                     (generation_id, user_id, philosopher, question_text,
                      question_normalized, theme, difficulty, source, generated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'ai_generated', now())
                 RETURNING id`,
                [generationId, userId, philosopher, q.question, normalizeText(q.question), q.theme, q.difficulty]
            );
            saved.push({
                id: insert.rows[0].id,
                question: q.question,
                theme: q.theme,
                difficulty: q.difficulty,
            });
        }

        console.log(`[Questions] Generated ${saved.length} for ${philosopher} (user ${userId.slice(0, 8)}…) | generation_id: ${generationId}`);

        return res.json({ success: true, questions: saved });
    } catch (err) {
        console.error('[Questions] generate error:', err.message);
        return res.status(500).json({
            success: false,
            error: 'Question generation failed. Please try again.',
        });
    }
});

// ─── PATCH /api/questions/:id/used ───────────────────────────────────────────
// Fire-and-forget from the app when the user enters a debate with a
// generated question. Failure here must NEVER block the debate.

router.patch('/api/questions/:id/used', async (req, res) => {
    try {
        await pool.query(
            `UPDATE generated_questions
             SET used_at = now()
             WHERE id = $1 AND used_at IS NULL`,
            [req.params.id]
        );
        return res.json({ success: true });
    } catch (err) {
        console.error('[Questions] used error:', err.message);
        return res.status(500).json({ success: false });
    }
});

export default router;
