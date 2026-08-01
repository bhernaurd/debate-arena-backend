import assert from 'node:assert/strict';
import test from 'node:test';

import {
    RankedTopicGeneratorError,
    createRankedTopicGeneratorService,
} from '../lib/rankedTopicGeneratorService.js';

function response(
    topic,
    theme = 'Virtue',
    openingQuestion =
        'What answer would your own life give when this question becomes unavoidable?'
) {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    topic,
                    openingQuestion,
                    theme,
                }),
            },
        ],
    };
}

test(
    'generates one canonical Ranked topic with deterministic metadata',
    async () => {
        let request;

        const service =
            createRankedTopicGeneratorService({
                messageClient:
                    async (input) => {
                        request = input;
                        return response(
                            'Can you call yourself virtuous if you only act well when it benefits you?'
                        );
                    },
                model:
                    'test-model',
                generatorVersion:
                    'ranked-topic-test-v1',
                now: () =>
                    new Date(
                        '2026-07-30T05:00:00.000Z'
                    ),
            });

        const result =
            await service.generateTopic({
                philosopherId:
                    'aristotle',
                debateMode:
                    'guided',
            });

        assert.equal(
            result.philosopherId,
            'aristotle'
        );
        assert.equal(
            result.philosopherName,
            'Aristotle'
        );
        assert.equal(
            result.debateMode,
            'guided'
        );
        assert.equal(
            result.openingQuestion,
            'What answer would your own life give when this question becomes unavoidable?'
        );
        assert.equal(
            result.model,
            'test-model'
        );
        assert.equal(
            result.generatorVersion,
            'ranked-topic-test-v1'
        );
        assert.equal(
            result.topicFingerprint.length,
            64
        );
        assert.equal(
            result.generatedAt.toISOString(),
            '2026-07-30T05:00:00.000Z'
        );
        assert.equal(
            request.model,
            'test-model'
        );
        assert.match(
            request.messages[0].content,
            /Aristotle/
        );
        assert.match(
            request.messages[0].content,
            /AUTHORITATIVE PHILOSOPHER SOURCE/
        );
        assert.match(
            request.messages[0].content,
            /openingQuestion/
        );
    }
);

test(
    'requires canonical philosopher ids and excludes Coming Soon philosophers',
    async () => {
        const service =
            createRankedTopicGeneratorService({
                messageClient:
                    async () =>
                        response(
                            'Can a person remain free while surrendering every difficult choice to others?'
                        ),
            });

        await assert.rejects(
            service.generateTopic({
                philosopherId:
                    'Marcus Aurelius',
                debateMode:
                    'balanced',
            }),
            (error) =>
                error instanceof
                    RankedTopicGeneratorError &&
                error.code ===
                    'invalid_ranked_philosopher_id' &&
                error.status === 400
        );

        await assert.rejects(
            service.generateTopic({
                philosopherId:
                    'kierkegaard',
                debateMode:
                    'balanced',
            }),
            (error) =>
                error instanceof
                    RankedTopicGeneratorError &&
                error.code ===
                    'invalid_ranked_philosopher_id'
        );
    }
);

test(
    'rejects invalid Ranked debate modes',
    async () => {
        const service =
            createRankedTopicGeneratorService({
                messageClient:
                    async () =>
                        response(
                            'Can you call yourself free if comfort decides every important choice you make?'
                        ),
            });

        await assert.rejects(
            service.generateTopic({
                philosopherId:
                    'nietzsche',
                debateMode:
                    'easy',
            }),
            (error) =>
                error instanceof
                    RankedTopicGeneratorError &&
                error.code ===
                    'invalid_ranked_debate_mode'
        );
    }
);

test(
    'retries a temporary network failure',
    async () => {
        let attempts = 0;
        const delays = [];

        const service =
            createRankedTopicGeneratorService({
                messageClient:
                    async () => {
                        attempts += 1;

                        if (attempts === 1) {
                            throw new Error(
                                'network timeout'
                            );
                        }

                        return response(
                            'Is your calm genuine if it disappears the moment events stop obeying you?',
                            'Control'
                        );
                    },
                retryDelay:
                    async (milliseconds) => {
                        delays.push(
                            milliseconds
                        );
                    },
            });

        const result =
            await service.generateTopic({
                philosopherId:
                    'aurelius',
                debateMode:
                    'relentless',
            });

        assert.equal(
            attempts,
            2
        );
        assert.deepEqual(
            delays,
            [700]
        );
        assert.equal(
            result.theme,
            'Control'
        );
    }
);

test(
    'regenerates after invalid model output',
    async () => {
        let attempts = 0;

        const service =
            createRankedTopicGeneratorService({
                messageClient:
                    async () => {
                        attempts += 1;

                        if (attempts === 1) {
                            return response(
                                'This is not a question'
                            );
                        }

                        return response(
                            'Do you seek truth when it costs you the identity others recognize?',
                            'Persona'
                        );
                    },
            });

        const result =
            await service.generateTopic({
                philosopherId:
                    'jung',
                debateMode:
                    'balanced',
            });

        assert.equal(
            attempts,
            2
        );
        assert.equal(
            result.theme,
            'Persona'
        );
    }
);

test(
    'regenerates when the model omits the philosopher opening question',
    async () => {
        let attempts = 0;
        const prompts = [];

        const service =
            createRankedTopicGeneratorService({
                messageClient:
                    async (request) => {
                        attempts += 1;
                        prompts.push(
                            request.messages[0].content
                        );

                        if (attempts === 1) {
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({
                                            topic: 'Can a person be courageous while refusing every risk that might expose failure?',
                                            theme: 'Courage',
                                        }),
                                    },
                                ],
                            };
                        }

                        return response(
                            'Can a person be courageous while refusing every risk that might expose failure?',
                            'Courage',
                            'Will you still call yourself courageous when your virtue has never entered danger?'
                        );
                    },
            });

        const result =
            await service.generateTopic({
                philosopherId:
                    'aristotle',
                debateMode:
                    'balanced',
            });

        assert.equal(
            attempts,
            2
        );
        assert.equal(
            result.openingQuestion,
            'Will you still call yourself courageous when your virtue has never entered danger?'
        );
        assert.match(
            prompts[1],
            /opening question must be one clean question/i
        );
    }
);

test(
    'rejects repeated or closely paraphrased topics',
    async () => {
        let attempts = 0;

        const service =
            createRankedTopicGeneratorService({
                messageClient:
                    async () => {
                        attempts += 1;
                        return response(
                            'Can life be worth living without ultimate meaning?',
                            'Absurd'
                        );
                    },
            });

        await assert.rejects(
            service.generateTopic({
                philosopherId:
                    'camus',
                debateMode:
                    'balanced',
                recentTopics: [
                    'Can life be worth living without ultimate meaning?',
                ],
            }),
            (error) =>
                error instanceof
                    RankedTopicGeneratorError &&
                error.code ===
                    'ranked_topic_generation_failed' &&
                error.retryable === true
        );

        assert.equal(
            attempts,
            3
        );
    }
);

test(
    'accepts JSON inside a fenced model response',
    async () => {
        const service =
            createRankedTopicGeneratorService({
                messageClient:
                    async () => ({
                        content: [
                            {
                                type: 'text',
                                text:
                                    '```json\n{"topic":"Would you still call an action just if it saved many people by sacrificing one innocent person?","openingQuestion":"Would you name the act just when its order is purchased with an innocent soul?","theme":"Justice"}\n```',
                            },
                        ],
                    }),
            });

        const result =
            await service.generateTopic({
                philosopherId:
                    'plato',
                debateMode:
                    'guided',
            });

        assert.equal(
            result.theme,
            'Justice'
        );
    }
);

test(
    'produces the same fingerprint for the same normalized topic',
    async () => {
        const topic =
            'Is it better to suffer injustice than to become unjust yourself?';

        const first =
            createRankedTopicGeneratorService({
                messageClient:
                    async () =>
                        response(
                            topic,
                            'Justice'
                        ),
            });

        const second =
            createRankedTopicGeneratorService({
                messageClient:
                    async () =>
                        response(
                            '  Is it better to suffer injustice than to become unjust yourself?  ',
                            'Justice'
                        ),
            });

        const firstResult =
            await first.generateTopic({
                philosopherId:
                    'socrates',
                debateMode:
                    'balanced',
            });

        const secondResult =
            await second.generateTopic({
                philosopherId:
                    'socrates',
                debateMode:
                    'balanced',
            });

        assert.equal(
            firstResult.topicFingerprint,
            secondResult.topicFingerprint
        );
    }
);
