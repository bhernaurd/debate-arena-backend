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
// This version:
// - Supports the Standard Six + Albert Camus + Fyodor Dostoevsky + Søren Kierkegaard
// - Uses Claude-generated questions, not static fallback questions
// - Uses Haiku for question generation
// - Bypasses the Anthropic SDK/fetch layer because Railway was failing with:
//   "Invalid response body while trying to fetch ... Premature close"
// - Hard-enforces Beginner → Intermediate → Advanced
// - Retries temporary Anthropic/network failures

import express from 'express';
import crypto from 'crypto';
import pg from 'pg';
import https from 'https';

const router = express.Router();
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

// ─── Constants ───────────────────────────────────────────────────────────────

const QUESTION_MODEL =
    process.env.QUESTION_GENERATOR_MODEL || 'claude-haiku-4-5-20251001';

const ANTHROPIC_VERSION =
    process.env.ANTHROPIC_VERSION || '2023-06-01';

const REQUIRED_DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];

const DIFFICULTY_LABELS = {
    beginner: 'Beginner',
    intermediate: 'Intermediate',
    advanced: 'Advanced',
};

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

    'camus': 'Albert Camus',
    'albert camus': 'Albert Camus',

    'dostoevsky': 'Fyodor Dostoevsky',
    'fyodor dostoevsky': 'Fyodor Dostoevsky',

    'kierkegaard': 'Søren Kierkegaard',
    'søren kierkegaard': 'Søren Kierkegaard',
    'soren kierkegaard': 'Søren Kierkegaard',
};

const PHILOSOPHER_THEMES = {
    'Socrates':
        'self-examination, virtue, knowledge vs ignorance, truth, justice, the examined life, moral confidence, questioning assumptions, admitting what you do not know',

    'Plato':
        'truth vs illusion, the soul, justice, the Forms, the Allegory of the Cave, the ideal society, education, appearance vs reality, who should rule',

    'Aristotle':
        'virtue, habit, excellence, eudaimonia (flourishing), friendship, purpose, moderation and the golden mean, practical wisdom, character built through action',

    'Nietzsche':
        'values, suffering and what it makes of a person, herd morality, self-overcoming, "God is dead", the Ubermensch, comfort vs greatness, weakness, creating your own meaning, resentment',

    'Marcus Aurelius':
        'what is in your control, discipline, duty, mortality and memento mori, adversity, emotional restraint, acceptance, responsibility, fate, the opinions of others',

    'Carl Jung':
        'the shadow, individuation, dreams, projection, archetypes, the unconscious, identity, inner conflict, the persona vs the true self, integrating what you deny',

    'Albert Camus':
        'the absurd, lucidity, revolt, refusal of false consolation, happiness without illusion, life without appeal, the silence of the world, freedom, human dignity, solidarity, beauty, suffering, justice, limits, living honestly without ultimate meaning',

    'Fyodor Dostoevsky':
        'faith, suffering, guilt, freedom, conscience, moral responsibility, redemption, evil, sin, spiritual crisis, the burden of choice, human contradiction, compassion, pride, humility, underground psychology, nihilism, innocent suffering, rebellion against God, salvation through suffering',

    'Søren Kierkegaard':
        'the single individual, possibility and actuality, choice and responsibility, anxiety and freedom, despair and becoming a self, aesthetic ethical and religious existence, Religiousness A and B, inward appropriation without relativism, faith and the God-man paradox, infinite resignation, repetition, the crowd and the public, commanded neighbor-love, Christendom, admiration versus imitation, risk, commitment, and living what one claims to believe',
};

const RECENT_EXCLUSION_COUNT = 20;

const MAX_QUESTION_CHARS = Number(
    process.env.QUESTION_MAX_CHARS || 160
);

const GENERATE_RATE_LIMIT_PER_HOUR = Number(
    process.env.QUESTION_GENERATE_RATE_LIMIT_PER_HOUR || 5
);

const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'being', 'by', 'can',
    'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have',
    'he', 'her', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
    'its', 'of', 'on', 'or', 'our', 'should', 'so', 'than', 'that',
    'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
    'those', 'through', 'to', 'was', 'we', 'were', 'what', 'when',
    'where', 'whether', 'which', 'who', 'whom', 'whose', 'why', 'will',
    'with', 'without', 'would', 'you', 'your'
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableAnthropicError(err) {
    const message = String(err?.message || err || '').toLowerCase();

    return (
        message.includes('premature close') ||
        message.includes('socket hang up') ||
        message.includes('network') ||
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('fetch failed') ||
        message.includes('econnreset') ||
        message.includes('etimedout') ||
        message.includes('empty response') ||
        message.includes('503') ||
        message.includes('529') ||
        message.includes('overloaded')
    );
}

function resolvePhilosopher(input) {
    if (typeof input !== 'string') return null;
    return PHILOSOPHER_ALIASES[input.trim().toLowerCase()] || null;
}

function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeDifficulty(value) {
    if (typeof value !== 'string') return null;

    const difficulty = value.trim().toLowerCase();

    if (difficulty === 'beginner') return 'beginner';
    if (difficulty === 'intermediate') return 'intermediate';
    if (difficulty === 'advanced') return 'advanced';

    return null;
}

function contentWords(normalizedText) {
    return String(normalizedText || '')
        .split(' ')
        .map(w => w.trim())
        .filter(w => w.length > 0)
        .filter(w => !STOPWORDS.has(w));
}

function normalizedTheme(theme) {
    return normalizeText(theme || 'general');
}

function tooSimilar(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;

    const wordsA = new Set(contentWords(a));
    const wordsB = new Set(contentWords(b));

    if (wordsA.size === 0 || wordsB.size === 0) return false;

    // The raw includes check is useful for catching true paraphrase fragments,
    // but only after stopword filtering. Without this, short questions can look
    // falsely similar because they share words like "is", "to", or "the".
    if (a.includes(b) || b.includes(a)) {
        const smallerSet = wordsA.size <= wordsB.size ? wordsA : wordsB;

        if (smallerSet.size >= 4) {
            return true;
        }
    }

    let shared = 0;

    for (const w of wordsA) {
        if (wordsB.has(w)) shared++;
    }

    const overlap = shared / Math.min(wordsA.size, wordsB.size);

    return shared >= 3 && overlap > 0.8;
}

function sortByRequiredDifficulty(questions) {
    return [...questions].sort((a, b) => {
        return REQUIRED_DIFFICULTIES.indexOf(a.difficulty) - REQUIRED_DIFFICULTIES.indexOf(b.difficulty);
    });
}

function sanitizeQuestion(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const question = typeof raw.question === 'string'
        ? raw.question
            .trim()
            .replace(/^[-*\d.)\s]+/, '')
            .trim()
        : '';

    const theme = typeof raw.theme === 'string' && raw.theme.trim().length > 0
        ? raw.theme.trim()
        : 'general';

    const difficulty = normalizeDifficulty(raw.difficulty);

    if (!question || !difficulty) return null;
    if (!question.endsWith('?')) return null;
    if (question.length > MAX_QUESTION_CHARS) return null;

    return {
        question,
        theme,
        difficulty,
    };
}

function selectOnePerDifficulty(generated, neededDifficulties, recentNormalized, accepted) {
    const selected = [];

    for (const difficulty of neededDifficulties) {
        const candidates = generated.filter(q => q.difficulty === difficulty);

        for (const candidate of candidates) {
            const norm = normalizeText(candidate.question);
            const theme = normalizedTheme(candidate.theme);

            const usedThemes = new Set([
                ...accepted.map(q => normalizedTheme(q.theme)),
                ...selected.map(q => normalizedTheme(q.theme)),
            ]);

            const dupAgainstRecent = recentNormalized.some(r => tooSimilar(norm, r));
            const dupAgainstAccepted = accepted.some(a => tooSimilar(norm, normalizeText(a.question)));
            const dupAgainstSelected = selected.some(s => tooSimilar(norm, normalizeText(s.question)));
            const dupTheme = usedThemes.has(theme);

            if (!dupAgainstRecent && !dupAgainstAccepted && !dupAgainstSelected && !dupTheme) {
                selected.push(candidate);
                break;
            }
        }
    }

    return selected;
}

function parseQuestionsJSON(raw) {
    const clean = String(raw || '')
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

    try {
        return JSON.parse(clean);
    } catch {
        const firstBrace = clean.indexOf('{');
        const lastBrace = clean.lastIndexOf('}');

        if (firstBrace >= 0 && lastBrace > firstBrace) {
            const extracted = clean.slice(firstBrace, lastBrace + 1);
            return JSON.parse(extracted);
        }

        throw new Error('AI response was not valid JSON');
    }
}

// ─── Raw Anthropic HTTPS Client ──────────────────────────────────────────────

function callAnthropicMessagesRaw(payload, label = 'questions') {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.ANTHROPIC_API_KEY;

        if (!apiKey) {
            reject(new Error('Missing ANTHROPIC_API_KEY'));
            return;
        }

        const body = JSON.stringify(payload);

        const options = {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_VERSION,
                'Content-Length': Buffer.byteLength(body),
                'Connection': 'close',
            },
            timeout: 60_000,
            agent: new https.Agent({
                keepAlive: false,
                maxSockets: 1,
            }),
        };

        const req = https.request(options, (res) => {
            let raw = '';

            res.setEncoding('utf8');

            res.on('data', (chunk) => {
                raw += chunk;
            });

            res.on('end', () => {
                const statusCode = res.statusCode || 0;

                if (!raw || raw.trim().length === 0) {
                    reject(new Error(`Anthropic empty response body. Status ${statusCode}`));
                    return;
                }

                let parsed;

                try {
                    parsed = JSON.parse(raw);
                } catch {
                    reject(
                        new Error(
                            `Anthropic returned non-JSON response. Status ${statusCode}. Body: ${raw.slice(0, 300)}`
                        )
                    );
                    return;
                }

                if (statusCode < 200 || statusCode >= 300) {
                    const message =
                        parsed?.error?.message ||
                        parsed?.message ||
                        `Anthropic request failed with status ${statusCode}`;

                    reject(new Error(message));
                    return;
                }

                resolve(parsed);
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`Anthropic request timed out for ${label}`));
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.write(body);
        req.end();
    });
}

async function createClaudeMessageWithRetry(args, label = 'questions') {
    let lastError;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await callAnthropicMessagesRaw(args, label);
        } catch (err) {
            lastError = err;

            const retryable = isRetryableAnthropicError(err);

            console.error(
                `[Questions] Claude ${label} attempt ${attempt}/3 failed:`,
                err?.message || err
            );

            if (!retryable || attempt === 3) {
                throw err;
            }

            await sleep(900 * attempt);
        }
    }

    throw lastError;
}

// ─── Claude generation ──────────────────────────────────────────────────────

function buildPrompt(philosopher, themes, recentQuestions, neededDifficulties) {
    const difficultyList = neededDifficulties.join(', ');

    const exclusionBlock = recentQuestions.length > 0
        ? `Do NOT repeat or closely paraphrase any of these recent questions:\n${recentQuestions.map(q => `- ${q}`).join('\n')}`
        : 'There are no recent questions to avoid.';

    return `You are generating debate questions for "The Agora", an iOS app where users debate history's greatest philosophers in real-time conversation.

Tagline:
"For centuries, you could only read the philosophers. Now you can debate them."

Philosopher:
${philosopher}

Core themes for this philosopher:
${themes}

Generate exactly ${neededDifficulties.length} debate question(s).

You must generate exactly ONE question for each of these difficulty levels:
${difficultyList}

The final JSON array must be ordered exactly like this:
${neededDifficulties.map(d => DIFFICULTY_LABELS[d]).join(' → ')}

Rules for every question:
- One sentence, under 140 characters whenever possible.
- THE CURIOSITY TEST: the user must have an instant gut answer, followed immediately by doubt. If the gut answer arrives with no doubt attached, the question fails.
- SELF-IMPLICATING: the question should make the user defend their own life or their own beliefs, not an abstract position.
- TWO-SECOND TEST: fully understandable at a glance by someone with zero philosophy background. No philosopher's technical vocabulary in the question itself.
- It should be arguable, never a definition, trivia, or "explain X" question.
- It must feel like ${philosopher} is challenging the user personally and directly.
- It must be philosophically accurate to ${philosopher}'s actual ideas and concerns.
- Never invent quotes.
- Never attribute claims this philosopher did not make.
- No generic self-help phrasing.
- No academic jargon.
- Each question must cover a different theme.

Examples of GOOD questions:
- "Is it worse to hurt someone or to be hurt?"
- "Can a person be happy without being good?"
- "Is hope a strength or a form of escape?"

Examples of BAD questions:
- "Does wealth lead to happiness?" This has an easy gut answer with little doubt.
- "What is the role of virtue in eudaimonia?" This is jargon and classroom phrasing.
- "Can we truly know anything?" This is abstract, ownerless, and has weak personal stakes.

Question style:
- The question should sound like it belongs to ${philosopher}'s philosophical world.
- It should not sound like a generic debate prompt.
- It should pressure the user to defend a real position.
- Avoid vague questions like "What is the meaning of life?"
- Avoid classroom phrasing like "Explain why..." or "Define..."
- Prefer sharp, personal, philosophically loaded questions.
- Do not copy the structure of the examples. Use them only as quality standards.

Difficulty guide:
- beginner: requires no philosophy background, purely intuitive
- intermediate: touches a named concept or recognizable idea in plain language
- advanced: forces the user to defend a position against the philosopher's strongest idea

${exclusionBlock}

Return ONLY valid JSON with no markdown, no backticks, and no text before or after it.

Return exactly this shape:
{"questions":[{"question":"string","theme":"string","difficulty":"beginner"}]}

Important:
- difficulty must be exactly one of: beginner, intermediate, advanced
- Do not return two questions with the same difficulty.
- Do not omit any requested difficulty.`;
}

async function callClaudeForQuestions(philosopher, recentQuestionTexts, neededDifficulties) {
    const prompt = buildPrompt(
        philosopher,
        PHILOSOPHER_THEMES[philosopher],
        recentQuestionTexts,
        neededDifficulties
    );

    const message = await createClaudeMessageWithRetry(
        {
            model: QUESTION_MODEL,
            max_tokens: 700,
            messages: [{ role: 'user', content: prompt }],
        },
        `question generation for ${philosopher} using ${QUESTION_MODEL}`
    );

    const raw = message.content?.find(b => b.type === 'text')?.text ?? '';
    const parsed = parseQuestionsJSON(raw);

    if (!Array.isArray(parsed.questions)) {
        throw new Error('AI response missing questions array');
    }

    return parsed.questions
        .map(sanitizeQuestion)
        .filter(Boolean);
}

async function generateDifficultyLockedQuestions(philosopher, recentTexts, recentNormalized) {
    let accepted = [];

    for (let attempt = 0; attempt < 3; attempt++) {
        const acceptedDifficulties = new Set(accepted.map(q => q.difficulty));
        const neededDifficulties = REQUIRED_DIFFICULTIES.filter(d => !acceptedDifficulties.has(d));

        if (neededDifficulties.length === 0) break;

        const generated = await callClaudeForQuestions(
            philosopher,
            [...recentTexts, ...accepted.map(q => q.question)],
            neededDifficulties
        );

        const selected = selectOnePerDifficulty(
            generated,
            neededDifficulties,
            recentNormalized,
            accepted
        );

        accepted.push(...selected);
        accepted = sortByRequiredDifficulty(accepted);
    }

    const finalDifficulties = new Set(accepted.map(q => q.difficulty));
    const hasAllDifficulties = REQUIRED_DIFFICULTIES.every(d => finalDifficulties.has(d));

    if (!hasAllDifficulties) {
        throw new Error('Could not generate one fresh question per difficulty');
    }

    return sortByRequiredDifficulty(accepted);
}

// ─── Persistence / protection helpers ───────────────────────────────────────

function makePublicError(statusCode, publicMessage, internalMessage = publicMessage) {
    const err = new Error(internalMessage);
    err.statusCode = statusCode;
    err.publicMessage = publicMessage;
    return err;
}

function validateUserId(userId) {
    return typeof userId === 'string' && userId.trim().length >= 6;
}

async function enforceGenerateRateLimit(userId, philosopher) {
    if (!Number.isFinite(GENERATE_RATE_LIMIT_PER_HOUR) || GENERATE_RATE_LIMIT_PER_HOUR <= 0) {
        return;
    }

    const result = await pool.query(
        `SELECT COUNT(DISTINCT generation_id)::int AS generation_count
         FROM generated_questions
         WHERE user_id = $1
           AND philosopher = $2
           AND generated_at > now() - interval '1 hour'`,
        [userId, philosopher]
    );

    const generationCount = Number(result.rows[0]?.generation_count || 0);

    if (generationCount >= GENERATE_RATE_LIMIT_PER_HOUR) {
        throw makePublicError(
            429,
            'Too many question generations. Please try again later.',
            `Rate limit exceeded for ${philosopher} by user ${userId}`
        );
    }
}

async function saveGeneratedQuestionsAtomic({ generationId, userId, philosopher, questions }) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const values = [];
        const rowsSql = questions.map((q, index) => {
            const base = index * 7;

            values.push(
                generationId,
                userId,
                philosopher,
                q.question,
                normalizeText(q.question),
                q.theme,
                q.difficulty
            );

            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, 'ai_generated', now())`;
        }).join(',\n');

        const insert = await client.query(
            `INSERT INTO generated_questions
                 (generation_id, user_id, philosopher, question_text,
                  question_normalized, theme, difficulty, source, generated_at)
             VALUES
                 ${rowsSql}
             RETURNING id, question_text, theme, difficulty`,
            values
        );

        await client.query('COMMIT');

        return insert.rows.map(row => ({
            id: row.id,
            question: row.question_text,
            theme: row.theme,
            difficulty: row.difficulty,
        }));
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ─── POST /api/questions/generate ───────────────────────────────────────────

router.post('/api/questions/generate', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!validateUserId(userId)) {
            return res.status(400).json({
                success: false,
                error: 'A valid userId is required',
            });
        }

        const philosopher = resolvePhilosopher(req.body.philosopher);

        if (!philosopher) {
            return res.status(400).json({
                success: false,
                error: 'Invalid philosopher',
            });
        }

        await enforceGenerateRateLimit(userId, philosopher);

        const recent = await pool.query(
            `SELECT question_text, question_normalized
             FROM generated_questions
             WHERE user_id = $1 AND philosopher = $2
             ORDER BY generated_at DESC
             LIMIT $3`,
            [userId, philosopher, RECENT_EXCLUSION_COUNT]
        );

        const recentTexts = recent.rows.map(r => r.question_text).filter(Boolean);
        const recentNormalized = recent.rows.map(r => r.question_normalized).filter(Boolean);

        const accepted = await generateDifficultyLockedQuestions(
            philosopher,
            recentTexts,
            recentNormalized
        );

        const generationId = crypto.randomUUID();

        const saved = await saveGeneratedQuestionsAtomic({
            generationId,
            userId,
            philosopher,
            questions: accepted,
        });

        const orderedSaved = sortByRequiredDifficulty(saved);

        console.log(
            `[Questions] Generated Beginner → Intermediate → Advanced for ${philosopher} ` +
            `(user ${userId.slice(0, 8)}…) | generation_id: ${generationId}`
        );

        return res.json({
            success: true,
            questions: orderedSaved,
        });
    } catch (err) {
        console.error('[Questions] generate error:', err.message);

        return res.status(err.statusCode || 500).json({
            success: false,
            error: err.publicMessage || 'Question generation failed. Please try again.',
        });
    }
});

// ─── PATCH /api/questions/:id/used ───────────────────────────────────────────

router.patch('/api/questions/:id/used', async (req, res) => {
    try {
        const userId = req.body?.userId || req.query?.userId;

        if (!validateUserId(userId)) {
            return res.status(400).json({
                success: false,
                error: 'A valid userId is required',
            });
        }

        const update = await pool.query(
            `UPDATE generated_questions
             SET used_at = now()
             WHERE id = $1
               AND user_id = $2
               AND used_at IS NULL
             RETURNING id`,
            [req.params.id, userId]
        );

        if (update.rowCount === 0) {
            return res.status(404).json({
                success: false,
                error: 'Question not found or already marked used',
            });
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('[Questions] used error:', err.message);
        return res.status(500).json({ success: false });
    }
});

export default router;
