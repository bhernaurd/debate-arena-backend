import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createRankedDebateEngineService,
    rankedDebateEngineConstants,
} from '../lib/rankedDebateEngineService.js';

const REQUEST_ID =
    '11111111-1111-4111-8111-111111111111';
const DEBATE_ID =
    '22222222-2222-4222-8222-222222222222';
const TOPIC_FINGERPRINT =
    'a'.repeat(64);

function context(
    debateMode,
    {
        rankedRulesVersion =
            'ranked-rules-v3-mode-contracts',
        scoringPromptVersion =
            'ranked-scoring-v3-mode-contracts',
    } = {}
) {
    return {
        debateId:
            DEBATE_ID,
        debateKind:
            'ladder',
        placementTrialNumber:
            null,
        philosopherId:
            'nietzsche',
        philosopherName:
            'Nietzsche',
        debateMode,
        topic:
            'Are the values you defend truly yours, or were they inherited without examination?',
        topicTheme:
            'inherited values',
        topicFingerprint:
            TOPIC_FINGERPRINT,
        rankedRulesVersion,
        philosopherPromptVersion:
            'ranked-philosopher-prompts-v1',
        scoringPromptVersion,
        modelProvider:
            'anthropic',
        modelName:
            'test-model',
    };
}

function conversation(
    userResponses = 1
) {
    const messages = [
        {
            role:
                'assistant',
            content:
                'Do you call these values your own merely because you have learned to defend them?',
        },
    ];

    for (
        let index = 1;
        index <= userResponses;
        index += 1
    ) {
        messages.push({
            role:
                'user',
            content:
                `This is my response ${index}. I believe reflection can separate inherited values from values I consciously affirm.`,
        });

        if (
            index <
                userResponses
        ) {
            messages.push({
                role:
                    'assistant',
                content:
                    'Reflection may reveal inheritance, but it does not yet prove that you created the standard by which you judge it.',
            });
        }
    }

    return messages;
}

function paragraph(
    wordCount,
    {
        prefix = 'reason',
        ending = '.',
    } = {}
) {
    assert.ok(
        wordCount >= 1
    );

    const words = [];

    for (
        let index = 1;
        index <= wordCount;
        index += 1
    ) {
        words.push(
            `${prefix}${index}`
        );
    }

    words[
        words.length - 1
    ] =
        `${words[words.length - 1]}${ending}`;

    return words.join(' ');
}

function body(
    paragraphWordCounts,
    {
        finalEnding = '.',
        prefix = 'reason',
    } = {}
) {
    return paragraphWordCounts
        .map(
            (count, index) =>
                paragraph(
                    count,
                    {
                        prefix:
                            `${prefix}${index + 1}_`,
                        ending:
                            index ===
                                paragraphWordCounts.length - 1
                                ? finalEnding
                                : '.',
                    }
                )
        )
        .join('\n\n');
}

function providerFrom(
    responses,
    capturedPayloads = []
) {
    let index = 0;

    return async function createMessage(
        payload
    ) {
        capturedPayloads.push(
            payload
        );

        const text =
            responses[
                Math.min(
                    index,
                    responses.length - 1
                )
            ];

        index += 1;

        return {
            content: [
                {
                    type:
                        'text',
                    text,
                },
            ],
        };
    };
}

function service(
    responses,
    capturedPayloads = []
) {
    return createRankedDebateEngineService({
        createMessage:
            providerFrom(
                responses,
                capturedPayloads
            ),
        maxOutputAttempts:
            2,
        httpAttempts:
            1,
    });
}

test(
    'exports the approved Ranked mode limits',
    () => {
        assert.deepEqual(
            rankedDebateEngineConstants
                .modeOutputLimits
                .guided,
            {
                minimumWords: 1,
                maximumWords: 89,
                minimumParagraphs: 2,
                maximumParagraphs: 3,
                requireSingleFinalQuestion: true,
            }
        );

        assert.deepEqual(
            rankedDebateEngineConstants
                .modeOutputLimits
                .balanced,
            {
                minimumWords: 95,
                maximumWords: 135,
                minimumParagraphs: 2,
                maximumParagraphs: 3,
                requireSingleFinalQuestion: false,
            }
        );
    }
);

test(
    'Guided accepts an under-90-word two-paragraph reply with one final question and no early score',
    async () => {
        const responseBody =
            body(
                [35, 35],
                {
                    finalEnding:
                        '?',
                    prefix:
                        'guided',
                }
            );
        const engine =
            service([
                responseBody,
            ]);

        const result =
            await engine.generateReply({
                requestId:
                    REQUEST_ID,
                context:
                    context(
                        'guided'
                    ),
                conversation:
                    conversation(1),
                roundNumber:
                    1,
            });

        assert.equal(
            result.text,
            responseBody
        );
        assert.equal(
            result.scoreText,
            null
        );
        assert.equal(
            result.scoreValue,
            null
        );
    }
);

test(
    'Guided rejects an oversized first attempt and regenerates from the correction prompt',
    async () => {
        const payloads = [];
        const oversized =
            body(
                [50, 45],
                {
                    finalEnding:
                        '?',
                    prefix:
                        'longguided',
                }
            );
        const corrected =
            body(
                [40, 40],
                {
                    finalEnding:
                        '?',
                    prefix:
                        'guidedfix',
                }
            );
        const engine =
            service(
                [
                    oversized,
                    corrected,
                ],
                payloads
            );

        const result =
            await engine.generateReply({
                requestId:
                    REQUEST_ID,
                context:
                    context(
                        'guided'
                    ),
                conversation:
                    conversation(1),
                roundNumber:
                    1,
            });

        assert.equal(
            result.text,
            corrected
        );
        assert.equal(
            payloads.length,
            2
        );
        assert.match(
            payloads[1].system,
            /must remain under 90 words/i
        );
    }
);

test(
    'Guided rejects a reply that does not end with exactly one question',
    async () => {
        const payloads = [];
        const invalid =
            body(
                [35, 35],
                {
                    finalEnding:
                        '.',
                    prefix:
                        'guidednoquestion',
                }
            );
        const corrected =
            body(
                [35, 35],
                {
                    finalEnding:
                        '?',
                    prefix:
                        'guidedquestion',
                }
            );
        const engine =
            service(
                [
                    invalid,
                    corrected,
                ],
                payloads
            );

        const result =
            await engine.generateReply({
                requestId:
                    REQUEST_ID,
                context:
                    context(
                        'guided'
                    ),
                conversation:
                    conversation(1),
                roundNumber:
                    1,
            });

        assert.equal(
            result.text,
            corrected
        );
        assert.match(
            payloads[1].system,
            /exactly one simple question/i
        );
    }
);

test(
    'Balanced rejects an undersized reply and accepts a 100-word two-paragraph correction',
    async () => {
        const payloads = [];
        const tooShort =
            body(
                [40, 40],
                {
                    finalEnding:
                        '?',
                    prefix:
                        'shortbalanced',
                }
            );
        const corrected =
            body(
                [50, 50],
                {
                    finalEnding:
                        '?',
                    prefix:
                        'balancedfix',
                }
            );
        const engine =
            service(
                [
                    tooShort,
                    corrected,
                ],
                payloads
            );

        const result =
            await engine.generateReply({
                requestId:
                    REQUEST_ID,
                context:
                    context(
                        'balanced'
                    ),
                conversation:
                    conversation(1),
                roundNumber:
                    1,
            });

        assert.equal(
            result.text,
            corrected
        );
        assert.match(
            payloads[1].system,
            /requires at least 95 response-body word/i
        );
    }
);

test(
    'the required score line is excluded from Balanced word and paragraph validation',
    async () => {
        const responseBody =
            body(
                [50, 50],
                {
                    finalEnding:
                        '?',
                    prefix:
                        'scoredbalanced',
                }
            );
        const scored =
            `${responseBody}\n\nSCORE:[7.5/10]: The argument is clear but its standard remains insufficiently defended.`;
        const engine =
            service([
                scored,
            ]);

        const result =
            await engine.generateReply({
                requestId:
                    REQUEST_ID,
                context:
                    context(
                        'balanced'
                    ),
                conversation:
                    conversation(2),
                roundNumber:
                    2,
            });

        assert.equal(
            result.text,
            responseBody
        );
        assert.equal(
            result.scoreValue,
            7.5
        );
        assert.equal(
            result.scoreText,
            '7.5/10: The argument is clear but its standard remains insufficiently defended.'
        );
    }
);

test(
    'Relentless rejects more than four response-body paragraphs and regenerates',
    async () => {
        const payloads = [];
        const fiveParagraphs =
            body(
                [10, 10, 10, 10, 10],
                {
                    finalEnding:
                        '?',
                    prefix:
                        'relentlesslong',
                }
            );
        const fourParagraphs =
            body(
                [12, 12, 12, 12],
                {
                    finalEnding:
                        '?',
                    prefix:
                        'relentlessfix',
                }
            );
        const engine =
            service(
                [
                    fiveParagraphs,
                    fourParagraphs,
                ],
                payloads
            );

        const result =
            await engine.generateReply({
                requestId:
                    REQUEST_ID,
                context:
                    context(
                        'relentless'
                    ),
                conversation:
                    conversation(1),
                roundNumber:
                    1,
            });

        assert.equal(
            result.text,
            fourParagraphs
        );
        assert.match(
            payloads[1].system,
            /requires 1 to 4 response-body paragraph/i
        );
    }
);

test(
    'legacy generated openings use the same Guided contract and never include a score',
    async () => {
        const opening =
            body(
                [35, 35],
                {
                    finalEnding:
                        '?',
                    prefix:
                        'opening',
                }
            );
        const engine =
            service([
                opening,
            ]);

        const result =
            await engine.generateOpening({
                requestId:
                    REQUEST_ID,
                context:
                    context(
                        'guided'
                    ),
                conversation: [],
            });

        assert.equal(
            result.text,
            opening
        );
        assert.equal(
            result.scoreValue,
            null
        );
    }
);

test(
    'the first Ranked reply still rejects an early score and regenerates without one',
    async () => {
        const payloads = [];
        const responseBody =
            body(
                [35, 35],
                {
                    finalEnding:
                        '?',
                    prefix:
                        'earlyscore',
                }
            );
        const engine =
            service(
                [
                    `${responseBody}\n\nSCORE:[6/10]: This score is too early.`,
                    responseBody,
                ],
                payloads
            );

        const result =
            await engine.generateReply({
                requestId:
                    REQUEST_ID,
                context:
                    context(
                        'guided'
                    ),
                conversation:
                    conversation(1),
                roundNumber:
                    1,
            });

        assert.equal(
            result.scoreValue,
            null
        );
        assert.equal(
            result.text,
            responseBody
        );
        assert.match(
            payloads[1].system,
            /score was produced before scoring was due/i
        );
    }
);

test(
    'the second Ranked reply still requires exactly one final score line',
    async () => {
        const payloads = [];
        const responseBody =
            body(
                [50, 50],
                {
                    finalEnding:
                        '?',
                    prefix:
                        'requiredscore',
                }
            );
        const engine =
            service(
                [
                    responseBody,
                    `${responseBody}\n\nSCORE:[8/10]: The position is clear and directly answers the objection.`,
                ],
                payloads
            );

        const result =
            await engine.generateReply({
                requestId:
                    REQUEST_ID,
                context:
                    context(
                        'balanced'
                    ),
                conversation:
                    conversation(2),
                roundNumber:
                    2,
            });

        assert.equal(
            result.scoreValue,
            8
        );
        assert.match(
            payloads[1].system,
            /required final SCORE line was missing or malformed/i
        );
    }
);

test(
    'existing debates keep their stored legacy mode behavior after the v3 deployment',
    async () => {
        const payloads = [];
        const legacyBody =
            body(
                [95],
                {
                    finalEnding:
                        '.',
                    prefix:
                        'legacyguided',
                }
            );
        const engine =
            service(
                [
                    legacyBody,
                ],
                payloads
            );

        const result =
            await engine.generateReply({
                requestId:
                    REQUEST_ID,
                context:
                    context(
                        'guided',
                        {
                            rankedRulesVersion:
                                'ranked-rules-v2-philosopher-question-opening',
                            scoringPromptVersion:
                                'ranked-scoring-v1',
                        }
                    ),
                conversation:
                    conversation(1),
                roundNumber:
                    1,
            });

        assert.equal(
            result.text,
            legacyBody
        );
        assert.doesNotMatch(
            payloads[0].system,
            /MODE AUTHORITY:/
        );
        assert.match(
            payloads[0].system,
            /Keep most responses concise, generally 3 to 5 sentences\./
        );
    }
);
