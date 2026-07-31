import crypto from 'node:crypto';

import {
    requireRankedPhilosopher,
} from './rankedPhilosopherCatalog.js';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INSTALLATION_ID_RE =
    /^[A-Za-z0-9-]{8,128}$/;

const TOPIC_FINGERPRINT_RE =
    /^[0-9a-f]{64}$/;

const RANKED_DEBATE_SCHEMA_VERSION = 1;
const STORED_MESSAGE_SCHEMA_VERSION = 1;

const GENERATION_LEASE_MS =
    3 * 60 * 1000;

const MAX_USER_MESSAGE_LENGTH = 8_000;
const MAX_ASSISTANT_MESSAGE_LENGTH = 20_000;
const MAX_SCORE_TEXT_LENGTH = 500;
const MAX_MESSAGES = 2_005;
const MAX_ROUNDS = 1_000;
const MAX_STORED_MESSAGES_JSON_BYTES =
    2 * 1024 * 1024;

const PLACEMENT_TRIALS_REQUIRED = 5;
const MIN_COMPLETION_USER_TURNS = 2;

const MESSAGE_ROLES = new Set([
    'user',
    'assistant',
]);

const MESSAGE_KINDS = new Set([
    'opening',
    'turn',
]);

const MESSAGE_STATUSES = new Set([
    'pending',
    'completed',
    'failed',
]);

export class AccountRankedDebateError extends Error {
    constructor(
        code,
        message,
        {
            status = 500,
            retryable = false,
            details = null,
            cause,
        } = {}
    ) {
        super(
            message,
            cause
                ? { cause }
                : undefined
        );

        this.name =
            'AccountRankedDebateError';

        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.details = details;
    }
}

function fail(
    code,
    message,
    options
) {
    throw new AccountRankedDebateError(
        code,
        message,
        options
    );
}

function requireString(
    value,
    fieldName,
    {
        minimumLength = 1,
        maximumLength = 16_384,
        pattern = null,
        trim = true,
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            'invalid_ranked_debate_request',
            `${fieldName} must be a string.`,
            { status: 400 }
        );
    }

    const cleaned =
        trim
            ? value.trim()
            : value;

    if (
        cleaned.length < minimumLength ||
        cleaned.length > maximumLength ||
        (
            pattern &&
            !pattern.test(cleaned)
        )
    ) {
        fail(
            'invalid_ranked_debate_request',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return cleaned;
}

function requireInstallationId(value) {
    return requireString(
        value,
        'installationId',
        {
            maximumLength: 128,
            pattern:
                INSTALLATION_ID_RE,
        }
    );
}

function requireUuid(
    value,
    fieldName
) {
    return requireString(
        value,
        fieldName,
        {
            maximumLength: 64,
            pattern: UUID_RE,
        }
    ).toLowerCase();
}

function requireStateVersion(value) {
    const parsed =
        typeof value === 'number'
            ? value
            : Number(value);

    if (
        !Number.isSafeInteger(parsed) ||
        parsed < 1
    ) {
        fail(
            'invalid_ranked_state_version',
            'expectedStateVersion must be a positive integer.',
            { status: 400 }
        );
    }

    return parsed;
}

function requireUserContent(value) {
    return requireString(
        value,
        'content',
        {
            maximumLength:
                MAX_USER_MESSAGE_LENGTH,
        }
    );
}

function serviceDate(now) {
    const raw = now();
    const date =
        raw instanceof Date
            ? raw
            : new Date(raw);

    if (Number.isNaN(date.getTime())) {
        fail(
            'invalid_ranked_debate_configuration',
            'now() returned an invalid date.'
        );
    }

    return date;
}

function createServiceId(createId) {
    const value = createId();

    if (
        typeof value !== 'string' ||
        !UUID_RE.test(value)
    ) {
        fail(
            'invalid_ranked_debate_configuration',
            'createId() must return a UUID.'
        );
    }

    return value.toLowerCase();
}

function rowValue(
    row,
    snakeCase,
    camelCase
) {
    if (
        Object.prototype.hasOwnProperty.call(
            row,
            snakeCase
        )
    ) {
        return row[snakeCase];
    }

    return row[camelCase];
}

function normalizeDate(
    value,
    fieldName,
    {
        optional = false,
    } = {}
) {
    if (
        value == null &&
        optional
    ) {
        return null;
    }

    const date =
        value instanceof Date
            ? value
            : new Date(value);

    if (Number.isNaN(date.getTime())) {
        fail(
            'ranked_debate_state_unavailable',
            `Ranked debate state contains an invalid ${fieldName}.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return date;
}

function normalizeInteger(
    value,
    fieldName,
    minimum,
    maximum,
    {
        optional = false,
    } = {}
) {
    if (
        value == null &&
        optional
    ) {
        return null;
    }

    const parsed =
        typeof value === 'number'
            ? value
            : Number(value);

    if (
        !Number.isSafeInteger(parsed) ||
        parsed < minimum ||
        parsed > maximum
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Ranked debate state contains an invalid ${fieldName}.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return parsed;
}

function normalizeNumber(
    value,
    fieldName,
    minimum,
    maximum,
    {
        optional = false,
    } = {}
) {
    if (
        value == null &&
        optional
    ) {
        return null;
    }

    const parsed =
        typeof value === 'number'
            ? value
            : Number(value);

    if (
        !Number.isFinite(parsed) ||
        parsed < minimum ||
        parsed > maximum
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Ranked debate state contains an invalid ${fieldName}.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return parsed;
}

function normalizeText(
    value,
    fieldName,
    maximumLength,
    {
        optional = false,
        minimumLength = 1,
    } = {}
) {
    if (
        value == null &&
        optional
    ) {
        return null;
    }

    if (typeof value !== 'string') {
        fail(
            'ranked_debate_state_unavailable',
            `Ranked debate state contains an invalid ${fieldName}.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const cleaned = value.trim();

    if (
        cleaned.length < minimumLength ||
        cleaned.length > maximumLength
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Ranked debate state contains an invalid ${fieldName}.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return cleaned;
}

function normalizeConfiguration(row) {
    if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row)
    ) {
        fail(
            'ranked_configuration_unavailable',
            'Ranked configuration is unavailable.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const configurationKey =
        rowValue(
            row,
            'configuration_key',
            'configurationKey'
        );

    if (configurationKey !== 'global') {
        fail(
            'ranked_configuration_unavailable',
            'Ranked configuration is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const isEnabled =
        rowValue(
            row,
            'is_enabled',
            'isEnabled'
        );

    const allowResumeActiveDebates =
        rowValue(
            row,
            'allow_resume_active_debates',
            'allowResumeActiveDebates'
        );

    if (
        typeof isEnabled !== 'boolean' ||
        typeof allowResumeActiveDebates !==
            'boolean'
    ) {
        fail(
            'ranked_configuration_unavailable',
            'Ranked configuration contains invalid rollout controls.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        isEnabled,
        allowResumeActiveDebates,
    });
}

function normalizeAuthorization(
    value,
    expectedInstallationId
) {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
    ) {
        fail(
            'ranked_authorization_unavailable',
            'The Agora account session returned invalid authorization data.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const accountId =
        typeof value.accountId === 'string'
            ? value.accountId.trim().toLowerCase()
            : '';

    const installationId =
        typeof value.installationId === 'string'
            ? value.installationId.trim()
            : '';

    if (!UUID_RE.test(accountId)) {
        fail(
            'ranked_authorization_unavailable',
            'The Agora account session returned an invalid account ID.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        !INSTALLATION_ID_RE.test(installationId) ||
        installationId !== expectedInstallationId
    ) {
        fail(
            'invalid_access_token',
            'The Agora account session does not belong to this installation.',
            {
                status: 401,
                retryable: false,
            }
        );
    }

    return Object.freeze({
        accountId,
        installationId,
    });
}

function requireContinuationEnabled(
    configuration
) {
    if (!configuration.isEnabled) {
        fail(
            'ranked_disabled',
            'Ranked is not currently available.',
            {
                status: 503,
                retryable: false,
            }
        );
    }

    if (
        !configuration
            .allowResumeActiveDebates
    ) {
        fail(
            'ranked_resume_disabled',
            'Active Ranked debates are temporarily unavailable.',
            {
                status: 503,
                retryable: true,
            }
        );
    }
}

function normalizeStoredMessage(
    value,
    index
) {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} is invalid.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const schemaVersion =
        normalizeInteger(
            value.schemaVersion,
            `messages[${index}].schemaVersion`,
            1,
            STORED_MESSAGE_SCHEMA_VERSION
        );

    if (
        schemaVersion !==
        STORED_MESSAGE_SCHEMA_VERSION
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} uses an unsupported schema.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const id =
        normalizeText(
            value.id,
            `messages[${index}].id`,
            64
        ).toLowerCase();

    const requestId =
        normalizeText(
            value.requestId,
            `messages[${index}].requestId`,
            64
        ).toLowerCase();

    if (
        !UUID_RE.test(id) ||
        !UUID_RE.test(requestId)
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} contains an invalid UUID.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const role =
        normalizeText(
            value.role,
            `messages[${index}].role`,
            20
        );

    const kind =
        normalizeText(
            value.kind,
            `messages[${index}].kind`,
            20
        );

    const status =
        normalizeText(
            value.status,
            `messages[${index}].status`,
            20
        );

    if (
        !MESSAGE_ROLES.has(role) ||
        !MESSAGE_KINDS.has(kind) ||
        !MESSAGE_STATUSES.has(status)
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} contains an invalid state.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const generationId =
        value.generationId == null
            ? null
            : normalizeText(
                value.generationId,
                `messages[${index}].generationId`,
                64
            ).toLowerCase();

    if (
        generationId != null &&
        !UUID_RE.test(generationId)
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} contains an invalid generation ID.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        (role === 'assistant' && generationId == null) ||
        (role === 'user' && generationId != null)
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} contains invalid generation ownership.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const visible = value.visible;

    if (typeof visible !== 'boolean') {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} contains an invalid visible flag.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const content =
        typeof value.content === 'string'
            ? value.content
            : '';

    const maximumLength =
        role === 'user'
            ? MAX_USER_MESSAGE_LENGTH
            : MAX_ASSISTANT_MESSAGE_LENGTH;

    if (
        content.length > maximumLength ||
        (
            status === 'completed' &&
            visible &&
            !content.trim()
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} contains invalid content.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const roundNumber =
        normalizeInteger(
            value.roundNumber,
            `messages[${index}].roundNumber`,
            0,
            MAX_ROUNDS
        );

    const scoreText =
        normalizeText(
            value.scoreText,
            `messages[${index}].scoreText`,
            MAX_SCORE_TEXT_LENGTH,
            {
                optional: true,
            }
        );

    const scoreValue =
        normalizeNumber(
            value.scoreValue,
            `messages[${index}].scoreValue`,
            0,
            10,
            {
                optional: true,
            }
        );

    if (
        (
            scoreText == null
        ) !==
        (
            scoreValue == null
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} has an incomplete score.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        role === 'user' &&
        (
            scoreText != null ||
            scoreValue != null
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked user message ${index} cannot contain a score.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const failureCode =
        normalizeText(
            value.failureCode,
            `messages[${index}].failureCode`,
            100,
            {
                optional: true,
            }
        );

    if (
        value.failureRetryable != null &&
        typeof value.failureRetryable !== 'boolean'
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} contains invalid retry metadata.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const failureRetryable =
        value.failureRetryable ?? null;

    if (
        status === 'failed' &&
        (
            failureCode == null ||
            failureRetryable == null
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} has incomplete failure metadata.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        status !== 'failed' &&
        (
            failureCode != null ||
            failureRetryable != null
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} has unexpected failure metadata.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const createdAt =
        normalizeDate(
            value.createdAt,
            `messages[${index}].createdAt`
        );

    const generationStartedAt =
        normalizeDate(
            value.generationStartedAt,
            `messages[${index}].generationStartedAt`,
            {
                optional: true,
            }
        );

    const completedAt =
        normalizeDate(
            value.completedAt,
            `messages[${index}].completedAt`,
            {
                optional: true,
            }
        );

    if (
        role === 'assistant' &&
        generationStartedAt == null
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked assistant message ${index} is missing generation time.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        role === 'user' &&
        generationStartedAt != null
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked user message ${index} cannot contain generation time.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        generationStartedAt != null &&
        generationStartedAt < createdAt
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} has an invalid generation timestamp.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        completedAt != null &&
        completedAt < createdAt
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} has an invalid completion timestamp.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        completedAt != null &&
        generationStartedAt != null &&
        completedAt < generationStartedAt
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} completed before generation began.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        status === 'pending' &&
        completedAt != null
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked pending message ${index} cannot be complete.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        status !== 'pending' &&
        completedAt == null
    ) {
        fail(
            'ranked_debate_state_unavailable',
            `Stored Ranked message ${index} is missing completion time.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        schemaVersion,
        id,
        requestId,
        generationId,
        role,
        kind,
        status,
        visible,
        content,
        roundNumber,
        scoreText,
        scoreValue,
        failureCode,
        failureRetryable,
        createdAt,
        generationStartedAt,
        completedAt,
    });
}

function failStoredMessageSequence(message) {
    fail(
        'ranked_debate_state_unavailable',
        message,
        {
            status: 503,
            retryable: true,
        }
    );
}

function validateStoredMessageSequence(messages) {
    if (messages.length === 0) {
        return;
    }

    const opening = messages[0];

    if (
        opening.role !== 'assistant' ||
        opening.kind !== 'opening' ||
        opening.roundNumber !== 0
    ) {
        failStoredMessageSequence(
            'Stored Ranked messages must begin with the philosopher opening.'
        );
    }

    if (
        opening.scoreText != null ||
        opening.scoreValue != null
    ) {
        failStoredMessageSequence(
            'The stored Ranked opening cannot contain a score.'
        );
    }

    if (
        opening.status === 'completed' &&
        !opening.visible
    ) {
        failStoredMessageSequence(
            'The completed Ranked opening must be visible.'
        );
    }

    if (
        opening.status !== 'completed' &&
        opening.visible
    ) {
        failStoredMessageSequence(
            'An unfinished Ranked opening cannot be visible.'
        );
    }

    if (
        opening.status !== 'completed' &&
        messages.length !== 1
    ) {
        failStoredMessageSequence(
            'No Ranked turns can follow an unfinished opening.'
        );
    }

    const requestIds = new Set([
        opening.requestId,
    ]);

    let expectedRound = 1;
    let index = 1;

    while (index < messages.length) {
        const user = messages[index];
        const assistant = messages[index + 1];

        if (
            !assistant ||
            user.role !== 'user' ||
            assistant.role !== 'assistant' ||
            user.kind !== 'turn' ||
            assistant.kind !== 'turn'
        ) {
            failStoredMessageSequence(
                'Stored Ranked turns must be complete user and philosopher pairs.'
            );
        }

        if (
            user.requestId !== assistant.requestId ||
            user.roundNumber !== expectedRound ||
            assistant.roundNumber !== expectedRound
        ) {
            failStoredMessageSequence(
                'Stored Ranked turn identity or ordering is invalid.'
            );
        }

        if (requestIds.has(user.requestId)) {
            failStoredMessageSequence(
                'Stored Ranked messages contain a reused request ID.'
            );
        }

        requestIds.add(user.requestId);

        if (
            user.status !== 'completed' ||
            !user.visible ||
            user.scoreText != null ||
            user.scoreValue != null
        ) {
            failStoredMessageSequence(
                'Stored Ranked user turns must be completed, visible, and unscored.'
            );
        }

        if (
            assistant.status === 'completed' &&
            !assistant.visible
        ) {
            failStoredMessageSequence(
                'A completed Ranked philosopher turn must be visible.'
            );
        }

        if (
            assistant.status !== 'completed' &&
            assistant.visible
        ) {
            failStoredMessageSequence(
                'An unfinished Ranked philosopher turn cannot be visible.'
            );
        }

        if (expectedRound === 1) {
            if (
                assistant.scoreText != null ||
                assistant.scoreValue != null
            ) {
                failStoredMessageSequence(
                    'The first Ranked user turn cannot receive a score.'
                );
            }
        } else if (
            assistant.status === 'completed' &&
            (
                assistant.scoreText == null ||
                assistant.scoreValue == null
            )
        ) {
            failStoredMessageSequence(
                'Completed Ranked turns after round one must contain a score.'
            );
        }

        if (
            assistant.createdAt < user.createdAt ||
            assistant.generationStartedAt < user.createdAt
        ) {
            failStoredMessageSequence(
                'Stored Ranked turn timestamps are invalid.'
            );
        }

        if (
            assistant.status !== 'completed' &&
            index + 2 !== messages.length
        ) {
            failStoredMessageSequence(
                'No Ranked turns can follow an unfinished philosopher response.'
            );
        }

        expectedRound += 1;
        index += 2;
    }
}

function normalizeStoredMessages(value) {
    if (!Array.isArray(value)) {
        fail(
            'ranked_debate_state_unavailable',
            'Stored Ranked messages are invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        value.length >
        MAX_MESSAGES
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Stored Ranked message history is too large.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const normalized =
        value.map(
            normalizeStoredMessage
        );

    const ids = new Set();
    const generationIds = new Set();

    for (const message of normalized) {
        if (ids.has(message.id)) {
            fail(
                'ranked_debate_state_unavailable',
                'Stored Ranked messages contain duplicate IDs.',
                {
                    status: 503,
                    retryable: true,
                }
            );
        }

        ids.add(message.id);

        if (message.generationId != null) {
            if (
                generationIds.has(
                    message.generationId
                )
            ) {
                fail(
                    'ranked_debate_state_unavailable',
                    'Stored Ranked messages contain duplicate generation IDs.',
                    {
                        status: 503,
                        retryable: true,
                    }
                );
            }

            generationIds.add(
                message.generationId
            );
        }
    }

    validateStoredMessageSequence(
        normalized
    );

    return Object.freeze(
        normalized
    );
}

function normalizeDebate(
    row,
    expectedAccountId
) {
    if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row)
    ) {
        fail(
            'ranked_debate_not_found',
            'The Ranked debate could not be found.',
            { status: 404 }
        );
    }

    const id =
        normalizeText(
            rowValue(
                row,
                'id',
                'id'
            ),
            'debate.id',
            64
        ).toLowerCase();

    const accountId =
        normalizeText(
            rowValue(
                row,
                'account_id',
                'accountId'
            ),
            'debate.accountId',
            64
        ).toLowerCase();

    if (
        !UUID_RE.test(id) ||
        !UUID_RE.test(accountId)
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate identity is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const startRequestId =
        normalizeText(
            rowValue(
                row,
                'start_request_id',
                'startRequestId'
            ),
            'debate.startRequestId',
            64
        ).toLowerCase();

    if (!UUID_RE.test(startRequestId)) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate start request identity is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const rawCompletionRequestId =
        rowValue(
            row,
            'completion_request_id',
            'completionRequestId'
        );

    const completionRequestId =
        rawCompletionRequestId == null
            ? null
            : normalizeText(
                rawCompletionRequestId,
                'debate.completionRequestId',
                64
            ).toLowerCase();

    if (
        completionRequestId != null &&
        !UUID_RE.test(completionRequestId)
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate completion request identity is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const rawForfeitRequestId =
        rowValue(
            row,
            'forfeit_request_id',
            'forfeitRequestId'
        );

    const forfeitRequestId =
        rawForfeitRequestId == null
            ? null
            : normalizeText(
                rawForfeitRequestId,
                'debate.forfeitRequestId',
                64
            ).toLowerCase();

    if (
        forfeitRequestId != null &&
        !UUID_RE.test(forfeitRequestId)
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate forfeit request identity is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        completionRequestId != null &&
        forfeitRequestId != null
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate contains conflicting resolution requests.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        accountId !==
        expectedAccountId
    ) {
        fail(
            'ranked_debate_account_mismatch',
            'The Ranked debate belongs to a different account.',
            { status: 403 }
        );
    }

    const status =
        normalizeText(
            rowValue(
                row,
                'status',
                'status'
            ),
            'debate.status',
            20
        );

    if (
        ![
            'active',
            'completed',
            'forfeited',
            'invalid',
            'voided',
        ].includes(status)
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate status is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const debateKind =
        normalizeText(
            rowValue(
                row,
                'debate_kind',
                'debateKind'
            ),
            'debate.debateKind',
            20
        );

    if (
        ![
            'placement',
            'ladder',
        ].includes(debateKind)
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate kind is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const placementTrialNumber =
        normalizeInteger(
            rowValue(
                row,
                'placement_trial_number',
                'placementTrialNumber'
            ),
            'debate.placementTrialNumber',
            1,
            5,
            {
                optional: true,
            }
        );

    if (
        (
            debateKind ===
                'placement' &&
            placementTrialNumber == null
        ) ||
        (
            debateKind ===
                'ladder' &&
            placementTrialNumber != null
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate placement identity is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const philosopherId =
        normalizeText(
            rowValue(
                row,
                'philosopher_id',
                'philosopherId'
            ),
            'debate.philosopherId',
            100
        ).toLowerCase();

    let philosopher;

    try {
        philosopher =
            requireRankedPhilosopher(
                philosopherId
            );
    } catch (error) {
        fail(
            error?.code ??
                'ranked_philosopher_unavailable',
            error?.message ??
                'The Ranked philosopher is unavailable.',
            {
                status:
                    Number.isInteger(
                        error?.status
                    )
                        ? error.status
                        : 503,
                retryable:
                    Boolean(
                        error?.retryable
                    ),
                cause: error,
            }
        );
    }

    const philosopherName =
        normalizeText(
            rowValue(
                row,
                'philosopher_name',
                'philosopherName'
            ),
            'debate.philosopherName',
            100
        );

    if (
        philosopher.name !==
        philosopherName
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate philosopher identity is inconsistent.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const debateMode =
        normalizeText(
            rowValue(
                row,
                'debate_mode',
                'debateMode'
            ),
            'debate.debateMode',
            20
        );

    if (
        ![
            'guided',
            'balanced',
            'relentless',
        ].includes(debateMode)
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate mode is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const topicFingerprint =
        normalizeText(
            rowValue(
                row,
                'topic_fingerprint',
                'topicFingerprint'
            ),
            'debate.topicFingerprint',
            64
        ).toLowerCase();

    if (
        !TOPIC_FINGERPRINT_RE.test(
            topicFingerprint
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate topic fingerprint is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const messages =
        normalizeStoredMessages(
            rowValue(
                row,
                'messages',
                'messages'
            )
        );

    const roundCount =
        normalizeInteger(
            rowValue(
                row,
                'round_count',
                'roundCount'
            ),
            'debate.roundCount',
            0,
            MAX_ROUNDS
        );

    const completedUserTurns =
        messages.filter(
            (message) =>
                message.kind === 'turn' &&
                message.role === 'user' &&
                message.status ===
                    'completed'
        ).length;

    if (
        roundCount !==
        completedUserTurns
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate round count does not match stored messages.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const currentScoreText =
        normalizeText(
            rowValue(
                row,
                'current_score_text',
                'currentScoreText'
            ),
            'debate.currentScoreText',
            MAX_SCORE_TEXT_LENGTH,
            {
                optional: true,
            }
        );

    const currentScoreValue =
        normalizeNumber(
            rowValue(
                row,
                'current_score_value',
                'currentScoreValue'
            ),
            'debate.currentScoreValue',
            0,
            10,
            {
                optional: true,
            }
        );

    if (
        (
            currentScoreText == null
        ) !==
        (
            currentScoreValue == null
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate current score is incomplete.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const latestScoredReply =
        [...messages]
            .reverse()
            .find(
                (message) =>
                    message.role === 'assistant' &&
                    message.status === 'completed' &&
                    message.scoreValue != null
            ) ?? null;

    if (
        latestScoredReply == null &&
        currentScoreValue != null
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate current score has no matching scored response.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        latestScoredReply != null &&
        (
            currentScoreValue !== latestScoredReply.scoreValue ||
            currentScoreText !== latestScoredReply.scoreText
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate current score does not match the latest scored response.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const finalScoreText =
        normalizeText(
            rowValue(
                row,
                'final_score_text',
                'finalScoreText'
            ),
            'debate.finalScoreText',
            MAX_SCORE_TEXT_LENGTH,
            {
                optional: true,
            }
        );

    const finalScoreValue =
        normalizeNumber(
            rowValue(
                row,
                'final_score_value',
                'finalScoreValue'
            ),
            'debate.finalScoreValue',
            0,
            10,
            {
                optional: true,
            }
        );

    if (
        (
            finalScoreText == null
        ) !==
        (
            finalScoreValue == null
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate final score is incomplete.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const startedAt =
        normalizeDate(
            rowValue(
                row,
                'started_at',
                'startedAt'
            ),
            'debate.startedAt'
        );

    const lastActivityAt =
        normalizeDate(
            rowValue(
                row,
                'last_activity_at',
                'lastActivityAt'
            ),
            'debate.lastActivityAt'
        );

    if (
        lastActivityAt <
        startedAt
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate activity time is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const completedAt =
        normalizeDate(
            rowValue(
                row,
                'completed_at',
                'completedAt'
            ),
            'debate.completedAt',
            {
                optional: true,
            }
        );

    if (
        completedAt != null &&
        completedAt < startedAt
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate completion time is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        status === 'active' &&
        (
            completionRequestId != null ||
            forfeitRequestId != null ||
            finalScoreValue != null ||
            completedAt != null
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'An active Ranked debate contains resolution metadata.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        status === 'completed' &&
        (
            completionRequestId == null ||
            forfeitRequestId != null ||
            finalScoreValue == null ||
            completedAt == null
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'A completed Ranked debate is missing completion metadata.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        status === 'forfeited' &&
        (
            forfeitRequestId == null ||
            completionRequestId != null ||
            finalScoreValue !== 0 ||
            completedAt == null
        )
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'A forfeited Ranked debate is missing valid forfeit metadata.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        status !== 'completed' &&
        completionRequestId != null
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate completion metadata is attached to an invalid status.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        status !== 'forfeited' &&
        forfeitRequestId != null
    ) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate forfeit metadata is attached to an invalid status.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        id,
        accountId,
        startRequestId,
        completionRequestId,
        forfeitRequestId,
        debateKind,
        placementTrialNumber,
        status,
        philosopher,
        philosopherId,
        philosopherName,
        debateMode,
        topic:
            normalizeText(
                rowValue(
                    row,
                    'topic',
                    'topic'
                ),
                'debate.topic',
                4_000
            ),
        topicFingerprint,
        topicTheme:
            normalizeText(
                rowValue(
                    row,
                    'topic_theme',
                    'topicTheme'
                ),
                'debate.topicTheme',
                120
            ),
        topicModelProvider:
            normalizeText(
                rowValue(
                    row,
                    'topic_model_provider',
                    'topicModelProvider'
                ),
                'debate.topicModelProvider',
                100
            ),
        topicModelName:
            normalizeText(
                rowValue(
                    row,
                    'topic_model_name',
                    'topicModelName'
                ),
                'debate.topicModelName',
                200
            ),
        topicGeneratedAt:
            normalizeDate(
                rowValue(
                    row,
                    'topic_generated_at',
                    'topicGeneratedAt'
                ),
                'debate.topicGeneratedAt'
            ),
        messages,
        currentScoreText,
        currentScoreValue,
        finalScoreText,
        finalScoreValue,
        roundCount,
        rankedRulesVersion:
            normalizeText(
                rowValue(
                    row,
                    'ranked_rules_version',
                    'rankedRulesVersion'
                ),
                'debate.rankedRulesVersion',
                100
            ),
        philosopherPromptVersion:
            normalizeText(
                rowValue(
                    row,
                    'philosopher_prompt_version',
                    'philosopherPromptVersion'
                ),
                'debate.philosopherPromptVersion',
                100
            ),
        scoringPromptVersion:
            normalizeText(
                rowValue(
                    row,
                    'scoring_prompt_version',
                    'scoringPromptVersion'
                ),
                'debate.scoringPromptVersion',
                100
            ),
        reportPromptVersion:
            normalizeText(
                rowValue(
                    row,
                    'report_prompt_version',
                    'reportPromptVersion'
                ),
                'debate.reportPromptVersion',
                100
            ),
        topicGeneratorVersion:
            normalizeText(
                rowValue(
                    row,
                    'topic_generator_version',
                    'topicGeneratorVersion'
                ),
                'debate.topicGeneratorVersion',
                100
            ),
        rpFormulaVersion:
            normalizeText(
                rowValue(
                    row,
                    'rp_formula_version',
                    'rpFormulaVersion'
                ),
                'debate.rpFormulaVersion',
                100
            ),
        modelProvider:
            normalizeText(
                rowValue(
                    row,
                    'model_provider',
                    'modelProvider'
                ),
                'debate.modelProvider',
                100
            ),
        modelName:
            normalizeText(
                rowValue(
                    row,
                    'model_name',
                    'modelName'
                ),
                'debate.modelName',
                150
            ),
        stateVersion:
            normalizeInteger(
                rowValue(
                    row,
                    'state_version',
                    'stateVersion'
                ),
                'debate.stateVersion',
                1,
                Number.MAX_SAFE_INTEGER
            ),
        startedAt,
        lastActivityAt,
        completedAt,
        updatedAt:
            normalizeDate(
                rowValue(
                    row,
                    'updated_at',
                    'updatedAt'
                ),
                'debate.updatedAt'
            ),
    });
}

function storedMessagesJsonBytes(
    messages
) {
    return Buffer.byteLength(
        JSON.stringify(messages),
        'utf8'
    );
}

function requireMessagesWithinLimits(
    messages
) {
    if (
        messages.length >
        MAX_MESSAGES
    ) {
        fail(
            'ranked_debate_message_limit_reached',
            'This Ranked debate has reached its message limit.',
            {
                status: 409,
                retryable: false,
            }
        );
    }

    if (
        storedMessagesJsonBytes(
            messages
        ) >
        MAX_STORED_MESSAGES_JSON_BYTES
    ) {
        fail(
            'ranked_debate_message_limit_reached',
            'This Ranked debate has reached its storage limit.',
            {
                status: 409,
                retryable: false,
            }
        );
    }
}

function messageToStorage(message) {
    return {
        schemaVersion:
            message.schemaVersion,
        id: message.id,
        requestId:
            message.requestId,
        generationId:
            message.generationId,
        role: message.role,
        kind: message.kind,
        status: message.status,
        visible: message.visible,
        content: message.content,
        roundNumber:
            message.roundNumber,
        scoreText:
            message.scoreText,
        scoreValue:
            message.scoreValue,
        failureCode:
            message.failureCode,
        failureRetryable:
            message.failureRetryable,
        createdAt:
            message.createdAt
                .toISOString(),
        generationStartedAt:
            message.generationStartedAt
                ?.toISOString() ??
            null,
        completedAt:
            message.completedAt
                ?.toISOString() ??
            null,
    };
}

function storagePayload(messages) {
    const payload =
        messages.map(
            messageToStorage
        );

    requireMessagesWithinLimits(
        payload
    );

    return payload;
}

function visibleConversation(messages) {
    return messages
        .filter(
            (message) =>
                message.visible &&
                message.status ===
                    'completed'
        )
        .map(
            (message) =>
                Object.freeze({
                    role:
                        message.role,
                    content:
                        message.content,
                })
        );
}

function publicMessage(message) {
    if (
        !message ||
        !message.visible ||
        message.status !==
            'completed'
    ) {
        return null;
    }

    return Object.freeze({
        id: message.id,
        requestId:
            message.requestId,
        role: message.role,
        kind: message.kind,
        content: message.content,
        roundNumber:
            message.roundNumber,
        scoreText:
            message.scoreText,
        scoreValue:
            message.scoreValue,
        createdAt:
            message.createdAt,
        completedAt:
            message.completedAt,
    });
}

function pendingGeneration(messages) {
    const pending =
        messages.find(
            (message) =>
                message.role ===
                    'assistant' &&
                message.status ===
                    'pending'
        );

    if (pending) {
        return Object.freeze({
            requestId:
                pending.requestId,
            kind: pending.kind,
            roundNumber:
                pending.roundNumber,
            status: 'pending',
            retryable: true,
            generationStartedAt:
                pending
                    .generationStartedAt,
            failureCode: null,
        });
    }

    const failed =
        [...messages]
            .reverse()
            .find(
                (message) =>
                    message.role ===
                        'assistant' &&
                    message.status ===
                        'failed'
            );

    if (!failed) {
        return null;
    }

    return Object.freeze({
        requestId:
            failed.requestId,
        kind: failed.kind,
        roundNumber:
            failed.roundNumber,
        status: 'failed',
        retryable:
            Boolean(
                failed
                    .failureRetryable
            ),
        generationStartedAt:
            failed
                .generationStartedAt,
        failureCode:
            failed.failureCode,
    });
}

function publicDebate(debate) {
    return Object.freeze({
        id: debate.id,
        accountId:
            debate.accountId,
        startRequestId:
            debate.startRequestId,
        completionRequestId:
            debate.completionRequestId,
        forfeitRequestId:
            debate.forfeitRequestId,
        debateKind:
            debate.debateKind,
        placementTrialNumber:
            debate
                .placementTrialNumber,
        status: debate.status,
        philosopherId:
            debate.philosopherId,
        philosopherName:
            debate.philosopherName,
        debateMode:
            debate.debateMode,
        topic: debate.topic,
        topicFingerprint:
            debate.topicFingerprint,
        topicTheme:
            debate.topicTheme,
        topicModelProvider:
            debate.topicModelProvider,
        topicModelName:
            debate.topicModelName,
        topicGeneratedAt:
            debate.topicGeneratedAt,
        messages: Object.freeze(
            debate.messages
                .map(publicMessage)
                .filter(Boolean)
        ),
        pendingGeneration:
            debate.status === 'active'
                ? pendingGeneration(
                    debate.messages
                )
                : null,
        currentScoreText:
            debate.currentScoreText,
        currentScoreValue:
            debate.currentScoreValue,
        finalScoreText:
            debate.finalScoreText,
        finalScoreValue:
            debate.finalScoreValue,
        roundCount:
            debate.roundCount,
        rankedRulesVersion:
            debate.rankedRulesVersion,
        philosopherPromptVersion:
            debate
                .philosopherPromptVersion,
        scoringPromptVersion:
            debate
                .scoringPromptVersion,
        reportPromptVersion:
            debate
                .reportPromptVersion,
        topicGeneratorVersion:
            debate
                .topicGeneratorVersion,
        rpFormulaVersion:
            debate.rpFormulaVersion,
        modelProvider:
            debate.modelProvider,
        modelName:
            debate.modelName,
        stateVersion:
            debate.stateVersion,
        startedAt:
            debate.startedAt,
        lastActivityAt:
            debate.lastActivityAt,
        completedAt:
            debate.completedAt,
        updatedAt:
            debate.updatedAt,
    });
}

function messagesForRequest(
    messages,
    requestId
) {
    return messages.filter(
        (message) =>
            message.requestId ===
            requestId
    );
}

function completedAssistantForRequest(
    messages,
    requestId
) {
    return messages.find(
        (message) =>
            message.requestId ===
                requestId &&
            message.role ===
                'assistant' &&
            message.status ===
                'completed'
    );
}

function assistantForRequest(
    messages,
    requestId
) {
    return messages.find(
        (message) =>
            message.requestId ===
                requestId &&
            message.role ===
                'assistant'
    );
}

function userForRequest(
    messages,
    requestId
) {
    return messages.find(
        (message) =>
            message.requestId ===
                requestId &&
            message.role ===
                'user'
    );
}

function completedOpening(
    messages
) {
    return messages.find(
        (message) =>
            message.kind ===
                'opening' &&
            message.role ===
                'assistant' &&
            message.status ===
                'completed'
    );
}

function unresolvedAssistant(
    messages
) {
    return [...messages]
        .reverse()
        .find(
            (message) =>
                message.role ===
                    'assistant' &&
                (
                    message.status ===
                        'pending' ||
                    message.status ===
                        'failed'
                )
        ) ?? null;
}

function isGenerationLeaseStale(
    message,
    checkedAt,
    generationLeaseMs
) {
    if (
        message.status !==
            'pending' ||
        !message
            .generationStartedAt
    ) {
        return false;
    }

    return (
        checkedAt.getTime() -
        message
            .generationStartedAt
            .getTime()
    ) >= generationLeaseMs;
}

function cloneMessages(messages) {
    return messages.map(
        (message) => ({
            ...message,
        })
    );
}

function reserveOpeningMessages({
    messages,
    requestId,
    checkedAt,
    createId,
    generationLeaseMs,
}) {
    const sameRequest =
        assistantForRequest(
            messages,
            requestId
        );

    if (sameRequest) {
        if (
            sameRequest.kind !==
            'opening'
        ) {
            fail(
                'ranked_request_id_conflict',
                'requestId was already used for a different Ranked action.',
                { status: 409 }
            );
        }

        if (
            sameRequest.status ===
                'completed'
        ) {
            return Object.freeze({
                action: 'existing',
                requestId,
                reply:
                    sameRequest,
                messages,
            });
        }

        if (
            sameRequest.status ===
                'pending' &&
            !isGenerationLeaseStale(
                sameRequest,
                checkedAt,
                generationLeaseMs
            )
        ) {
            fail(
                'ranked_generation_in_progress',
                'The Ranked opening is still being generated.',
                {
                    status: 409,
                    retryable: true,
                    details: {
                        requestId,
                    },
                }
            );
        }

        if (
            sameRequest.status ===
                'failed' &&
            !sameRequest
                .failureRetryable
        ) {
            fail(
                sameRequest.failureCode ??
                    'ranked_opening_failed',
                'The Ranked opening could not be generated.',
                {
                    status: 409,
                    retryable: false,
                    details: {
                        requestId,
                    },
                }
            );
        }

        const next =
            cloneMessages(messages);

        const generationId =
            createServiceId(
                createId
            );

        const index =
            next.findIndex(
                (message) =>
                    message.id ===
                    sameRequest.id
            );

        next[index] = {
            ...next[index],
            generationId,
            status: 'pending',
            visible: false,
            content: '',
            scoreText: null,
            scoreValue: null,
            failureCode: null,
            failureRetryable:
                null,
            generationStartedAt:
                checkedAt,
            completedAt: null,
        };

        return Object.freeze({
            action: 'generate',
            requestId,
            generationId,
            messages: Object.freeze(
                next
            ),
        });
    }

    const existingOpening =
        completedOpening(messages);

    if (existingOpening) {
        return Object.freeze({
            action: 'existing',
            requestId:
                existingOpening
                    .requestId,
            reply:
                existingOpening,
            messages,
        });
    }

    const unresolved =
        unresolvedAssistant(
            messages
        );

    if (unresolved) {
        fail(
            unresolved.status ===
                'pending'
                ? 'ranked_generation_in_progress'
                : 'ranked_previous_generation_failed',
            unresolved.status ===
                'pending'
                ? 'Another Ranked response is still being generated.'
                : 'Retry the previous Ranked response before continuing.',
            {
                status: 409,
                retryable:
                    unresolved.status ===
                        'pending' ||
                    Boolean(
                        unresolved
                            .failureRetryable
                    ),
                details: {
                    requestId:
                        unresolved
                            .requestId,
                },
            }
        );
    }

    if (
        messages.some(
            (message) =>
                message.visible &&
                message.status ===
                    'completed'
        )
    ) {
        fail(
            'ranked_opening_state_invalid',
            'The Ranked opening cannot be created after the debate has begun.',
            { status: 409 }
        );
    }

    const messageId =
        createServiceId(
            createId
        );

    const generationId =
        createServiceId(
            createId
        );

    const next = [
        ...messages,
        Object.freeze({
            schemaVersion:
                STORED_MESSAGE_SCHEMA_VERSION,
            id: messageId,
            requestId,
            generationId,
            role: 'assistant',
            kind: 'opening',
            status: 'pending',
            visible: false,
            content: '',
            roundNumber: 0,
            scoreText: null,
            scoreValue: null,
            failureCode: null,
            failureRetryable:
                null,
            createdAt:
                checkedAt,
            generationStartedAt:
                checkedAt,
            completedAt: null,
        }),
    ];

    return Object.freeze({
        action: 'generate',
        requestId,
        generationId,
        messages: Object.freeze(
            next
        ),
    });
}

function reserveTurnMessages({
    messages,
    requestId,
    content,
    roundNumber,
    checkedAt,
    createId,
    generationLeaseMs,
}) {
    const requestMessages =
        messagesForRequest(
            messages,
            requestId
        );

    if (
        requestMessages.length > 0
    ) {
        const existingUser =
            userForRequest(
                messages,
                requestId
            );

        const existingAssistant =
            assistantForRequest(
                messages,
                requestId
            );

        if (
            !existingUser ||
            !existingAssistant ||
            existingUser.kind !==
                'turn' ||
            existingAssistant.kind !==
                'turn' ||
            existingUser.content !==
                content
        ) {
            fail(
                'ranked_request_id_conflict',
                'requestId was already used with different Ranked turn data.',
                { status: 409 }
            );
        }

        if (
            existingAssistant.status ===
                'completed'
        ) {
            return Object.freeze({
                action: 'existing',
                requestId,
                reply:
                    existingAssistant,
                messages,
            });
        }

        if (
            existingAssistant.status ===
                'pending' &&
            !isGenerationLeaseStale(
                existingAssistant,
                checkedAt,
                generationLeaseMs
            )
        ) {
            fail(
                'ranked_generation_in_progress',
                'The Ranked response is still being generated.',
                {
                    status: 409,
                    retryable: true,
                    details: {
                        requestId,
                    },
                }
            );
        }

        if (
            existingAssistant.status ===
                'failed' &&
            !existingAssistant
                .failureRetryable
        ) {
            fail(
                existingAssistant
                    .failureCode ??
                    'ranked_reply_failed',
                'The Ranked response could not be generated.',
                {
                    status: 409,
                    retryable: false,
                    details: {
                        requestId,
                    },
                }
            );
        }

        const next =
            cloneMessages(messages);

        const generationId =
            createServiceId(
                createId
            );

        const index =
            next.findIndex(
                (message) =>
                    message.id ===
                    existingAssistant.id
            );

        next[index] = {
            ...next[index],
            generationId,
            status: 'pending',
            visible: false,
            content: '',
            scoreText: null,
            scoreValue: null,
            failureCode: null,
            failureRetryable:
                null,
            generationStartedAt:
                checkedAt,
            completedAt: null,
        };

        return Object.freeze({
            action: 'generate',
            requestId,
            generationId,
            messages: Object.freeze(
                next
            ),
        });
    }

    const unresolved =
        unresolvedAssistant(
            messages
        );

    if (unresolved) {
        fail(
            unresolved.status ===
                'pending'
                ? 'ranked_generation_in_progress'
                : 'ranked_previous_generation_failed',
            unresolved.status ===
                'pending'
                ? 'Another Ranked response is still being generated.'
                : 'Retry the previous Ranked response before continuing.',
            {
                status: 409,
                retryable:
                    unresolved.status ===
                        'pending' ||
                    Boolean(
                        unresolved
                            .failureRetryable
                    ),
                details: {
                    requestId:
                        unresolved
                            .requestId,
                },
            }
        );
    }

    if (!completedOpening(messages)) {
        fail(
            'ranked_opening_required',
            'The Ranked opening must be generated before submitting a turn.',
            { status: 409 }
        );
    }

    const userMessage =
        Object.freeze({
            schemaVersion:
                STORED_MESSAGE_SCHEMA_VERSION,
            id:
                createServiceId(
                    createId
                ),
            requestId,
            generationId: null,
            role: 'user',
            kind: 'turn',
            status: 'completed',
            visible: true,
            content,
            roundNumber,
            scoreText: null,
            scoreValue: null,
            failureCode: null,
            failureRetryable:
                null,
            createdAt:
                checkedAt,
            generationStartedAt:
                null,
            completedAt:
                checkedAt,
        });

    const generationId =
        createServiceId(
            createId
        );

    const assistantMessage =
        Object.freeze({
            schemaVersion:
                STORED_MESSAGE_SCHEMA_VERSION,
            id:
                createServiceId(
                    createId
                ),
            requestId,
            generationId,
            role: 'assistant',
            kind: 'turn',
            status: 'pending',
            visible: false,
            content: '',
            roundNumber,
            scoreText: null,
            scoreValue: null,
            failureCode: null,
            failureRetryable:
                null,
            createdAt:
                checkedAt,
            generationStartedAt:
                checkedAt,
            completedAt: null,
        });

    return Object.freeze({
        action: 'generate',
        requestId,
        generationId,
        messages: Object.freeze([
            ...messages,
            userMessage,
            assistantMessage,
        ]),
    });
}

function normalizeEngineResult(
    value,
    debate,
    {
        opening,
        roundNumber = 0,
    }
) {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
    ) {
        fail(
            opening
                ? 'ranked_opening_generation_failed'
                : 'ranked_reply_generation_failed',
            opening
                ? 'The Ranked opening could not be generated.'
                : 'The Ranked response could not be generated.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const text =
        requireString(
            value.text,
            'engineResult.text',
            {
                maximumLength:
                    MAX_ASSISTANT_MESSAGE_LENGTH,
            }
        );

    const modelProvider =
        requireString(
            value.modelProvider,
            'engineResult.modelProvider',
            {
                maximumLength: 100,
            }
        );

    const modelName =
        requireString(
            value.modelName,
            'engineResult.modelName',
            {
                maximumLength: 150,
            }
        );

    if (
        modelProvider !==
            debate.modelProvider ||
        modelName !==
            debate.modelName
    ) {
        fail(
            'ranked_model_mismatch',
            'The Ranked response was generated by an unexpected model.',
            {
                status: 503,
                retryable: false,
            }
        );
    }

    const scoreText =
        value.scoreText == null
            ? null
            : requireString(
                value.scoreText,
                'engineResult.scoreText',
                {
                    maximumLength:
                        MAX_SCORE_TEXT_LENGTH,
                }
            );

    const scoreValue =
        value.scoreValue == null
            ? null
            : Number(
                value.scoreValue
            );

    if (
        scoreValue != null &&
        (
            !Number.isFinite(
                scoreValue
            ) ||
            scoreValue < 0 ||
            scoreValue > 10
        )
    ) {
        fail(
            'ranked_scoring_failed',
            'The Ranked response returned an invalid score.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        (
            scoreText == null
        ) !==
        (
            scoreValue == null
        )
    ) {
        fail(
            'ranked_scoring_failed',
            'The Ranked response returned incomplete score data.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        opening &&
        (
            scoreText != null ||
            scoreValue != null
        )
    ) {
        fail(
            'ranked_opening_generation_failed',
            'The Ranked opening unexpectedly included a score.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (!opening) {
        if (
            !Number.isSafeInteger(roundNumber) ||
            roundNumber < 1 ||
            roundNumber > MAX_ROUNDS
        ) {
            fail(
                'ranked_scoring_failed',
                'The Ranked response used an invalid round number.',
                {
                    status: 503,
                    retryable: true,
                }
            );
        }

        if (
            roundNumber === 1 &&
            (
                scoreText != null ||
                scoreValue != null
            )
        ) {
            fail(
                'ranked_scoring_failed',
                'The first Ranked user turn must not be scored.',
                {
                    status: 503,
                    retryable: true,
                }
            );
        }

        if (
            roundNumber >= 2 &&
            (
                scoreText == null ||
                scoreValue == null
            )
        ) {
            fail(
                'ranked_scoring_failed',
                'Ranked turns after round one must include a score.',
                {
                    status: 503,
                    retryable: true,
                }
            );
        }
    }

    return Object.freeze({
        text,
        scoreText,
        scoreValue,
        modelProvider,
        modelName,
    });
}


const PLACEMENT_CUTOFFS = Object.freeze([
    Object.freeze({
        minimumScore: 8.00,
        rankKey: 'scholar',
        division: 3,
    }),
    Object.freeze({
        minimumScore: 7.50,
        rankKey: 'logician',
        division: 1,
    }),
    Object.freeze({
        minimumScore: 7.10,
        rankKey: 'logician',
        division: 2,
    }),
    Object.freeze({
        minimumScore: 6.70,
        rankKey: 'logician',
        division: 3,
    }),
    Object.freeze({
        minimumScore: 6.30,
        rankKey: 'dialectician',
        division: 1,
    }),
    Object.freeze({
        minimumScore: 5.90,
        rankKey: 'dialectician',
        division: 2,
    }),
    Object.freeze({
        minimumScore: 5.50,
        rankKey: 'dialectician',
        division: 3,
    }),
    Object.freeze({
        minimumScore: 5.00,
        rankKey: 'student',
        division: 1,
    }),
    Object.freeze({
        minimumScore: 4.50,
        rankKey: 'student',
        division: 2,
    }),
    Object.freeze({
        minimumScore: 4.00,
        rankKey: 'student',
        division: 3,
    }),
    Object.freeze({
        minimumScore: 3.50,
        rankKey: 'initiate',
        division: 1,
    }),
    Object.freeze({
        minimumScore: 3.00,
        rankKey: 'initiate',
        division: 2,
    }),
    Object.freeze({
        minimumScore: 0.00,
        rankKey: 'initiate',
        division: 3,
    }),
]);

function roundDecimal(
    value,
    decimalPlaces
) {
    const factor =
        10 ** decimalPlaces;

    return Math.round(
        (
            value +
            Number.EPSILON
        ) *
        factor
    ) / factor;
}

function scoredCompletedReplies(
    messages
) {
    return messages.filter(
        (message) =>
            message.role === 'assistant' &&
            message.kind === 'turn' &&
            message.status === 'completed' &&
            message.scoreValue != null
    );
}

function calculateFinalScore(
    messages
) {
    const scoredReplies =
        scoredCompletedReplies(
            messages
        );

    if (scoredReplies.length === 0) {
        fail(
            'ranked_completion_score_unavailable',
            'The Ranked debate does not contain a completed scored response.',
            {
                status: 409,
                retryable: false,
                details: {
                    scoredRoundCount: 0,
                },
            }
        );
    }

    const total =
        scoredReplies.reduce(
            (
                sum,
                message
            ) =>
                sum +
                message.scoreValue,
            0
        );

    const finalScoreValue =
        roundDecimal(
            total /
                scoredReplies.length,
            2
        );

    return Object.freeze({
        finalScoreValue,
        finalScoreText:
            `${finalScoreValue.toFixed(2)}/10`,
        scoredRoundCount:
            scoredReplies.length,
    });
}

function placementForScore(
    placementWeightedScore
) {
    const cutoff =
        PLACEMENT_CUTOFFS.find(
            (candidate) =>
                placementWeightedScore >=
                candidate.minimumScore
        );

    if (!cutoff) {
        fail(
            'ranked_placement_calculation_failed',
            'The Ranked placement score could not be assigned to a starting rank.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        rankKey:
            cutoff.rankKey,
        division:
            cutoff.division,
        rp: 0,
    });
}

function normalizeCompletionProfile(
    row,
    expectedAccountId
) {
    if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row)
    ) {
        fail(
            'ranked_profile_unavailable',
            'The Ranked profile is unavailable.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const accountId =
        normalizeText(
            rowValue(
                row,
                'account_id',
                'accountId'
            ),
            'profile.accountId',
            64
        ).toLowerCase();

    if (
        !UUID_RE.test(accountId) ||
        accountId !== expectedAccountId
    ) {
        fail(
            'ranked_profile_account_mismatch',
            'The Ranked profile belongs to a different account.',
            {
                status: 503,
                retryable: false,
            }
        );
    }

    const placementStatus =
        normalizeText(
            rowValue(
                row,
                'placement_status',
                'placementStatus'
            ),
            'profile.placementStatus',
            20
        );

    if (
        ![
            'not_started',
            'in_progress',
            'completed',
        ].includes(
            placementStatus
        )
    ) {
        fail(
            'ranked_profile_unavailable',
            'The Ranked profile contains an invalid placement status.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const currentRankKey =
        normalizeText(
            rowValue(
                row,
                'current_rank_key',
                'currentRankKey'
            ),
            'profile.currentRankKey',
            50,
            {
                optional: true,
            }
        );

    const peakRankKey =
        normalizeText(
            rowValue(
                row,
                'peak_rank_key',
                'peakRankKey'
            ),
            'profile.peakRankKey',
            50,
            {
                optional: true,
            }
        );

    return Object.freeze({
        accountId,
        placementStatus,
        placementTrialsCompleted:
            normalizeInteger(
                rowValue(
                    row,
                    'placement_trials_completed',
                    'placementTrialsCompleted'
                ),
                'profile.placementTrialsCompleted',
                0,
                PLACEMENT_TRIALS_REQUIRED
            ),
        placementWeightedScore:
            normalizeNumber(
                rowValue(
                    row,
                    'placement_weighted_score',
                    'placementWeightedScore'
                ),
                'profile.placementWeightedScore',
                0,
                10,
                {
                    optional: true,
                }
            ),
        currentRankKey,
        currentDivision:
            normalizeInteger(
                rowValue(
                    row,
                    'current_division',
                    'currentDivision'
                ),
                'profile.currentDivision',
                1,
                3,
                {
                    optional: true,
                }
            ),
        currentRP:
            normalizeInteger(
                rowValue(
                    row,
                    'current_rp',
                    'currentRP'
                ),
                'profile.currentRP',
                0,
                99,
                {
                    optional: true,
                }
            ),
        peakRankKey,
        peakDivision:
            normalizeInteger(
                rowValue(
                    row,
                    'peak_division',
                    'peakDivision'
                ),
                'profile.peakDivision',
                1,
                3,
                {
                    optional: true,
                }
            ),
        peakReachedAt:
            normalizeDate(
                rowValue(
                    row,
                    'peak_reached_at',
                    'peakReachedAt'
                ),
                'profile.peakReachedAt',
                {
                    optional: true,
                }
            ),
        demotionProtectionDebatesRemaining:
            normalizeInteger(
                rowValue(
                    row,
                    'demotion_protection_debates_remaining',
                    'demotionProtectionDebatesRemaining'
                ),
                'profile.demotionProtectionDebatesRemaining',
                0,
                1
            ),
        rankedDebatesCompleted:
            normalizeInteger(
                rowValue(
                    row,
                    'ranked_debates_completed',
                    'rankedDebatesCompleted'
                ),
                'profile.rankedDebatesCompleted',
                0,
                Number.MAX_SAFE_INTEGER
            ),
        stateVersion:
            normalizeInteger(
                rowValue(
                    row,
                    'state_version',
                    'stateVersion'
                ),
                'profile.stateVersion',
                1,
                Number.MAX_SAFE_INTEGER
            ),
        updatedAt:
            normalizeDate(
                rowValue(
                    row,
                    'updated_at',
                    'updatedAt'
                ),
                'profile.updatedAt'
            ),
    });
}

function normalizeCompletionTrial(
    row,
    expectedAccountId
) {
    if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row)
    ) {
        fail(
            'ranked_placement_state_unavailable',
            'The Ranked placement trial is unavailable.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const accountId =
        normalizeText(
            rowValue(
                row,
                'account_id',
                'accountId'
            ),
            'placementTrial.accountId',
            64
        ).toLowerCase();

    if (
        !UUID_RE.test(accountId) ||
        accountId !== expectedAccountId
    ) {
        fail(
            'ranked_profile_account_mismatch',
            'The Ranked placement trial belongs to a different account.',
            {
                status: 503,
                retryable: false,
            }
        );
    }

    const rankedDebateId =
        normalizeText(
            rowValue(
                row,
                'ranked_debate_id',
                'rankedDebateId'
            ),
            'placementTrial.rankedDebateId',
            64,
            {
                optional: true,
            }
        );

    const philosopherId =
        normalizeText(
            rowValue(
                row,
                'philosopher_id',
                'philosopherId'
            ),
            'placementTrial.philosopherId',
            100,
            {
                optional: true,
            }
        );

    const topicFingerprint =
        normalizeText(
            rowValue(
                row,
                'topic_fingerprint',
                'topicFingerprint'
            ),
            'placementTrial.topicFingerprint',
            64,
            {
                optional: true,
            }
        );

    if (
        rankedDebateId != null &&
        !UUID_RE.test(
            rankedDebateId
                .toLowerCase()
        )
    ) {
        fail(
            'ranked_placement_state_unavailable',
            'The Ranked placement trial contains an invalid debate ID.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        topicFingerprint != null &&
        !TOPIC_FINGERPRINT_RE.test(
            topicFingerprint
                .toLowerCase()
        )
    ) {
        fail(
            'ranked_placement_state_unavailable',
            'The Ranked placement trial contains an invalid topic fingerprint.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        accountId,
        trialNumber:
            normalizeInteger(
                rowValue(
                    row,
                    'trial_number',
                    'trialNumber'
                ),
                'placementTrial.trialNumber',
                1,
                PLACEMENT_TRIALS_REQUIRED
            ),
        requiredMode:
            normalizeText(
                rowValue(
                    row,
                    'required_mode',
                    'requiredMode'
                ),
                'placementTrial.requiredMode',
                20
            ),
        weightBasisPoints:
            normalizeInteger(
                rowValue(
                    row,
                    'weight_basis_points',
                    'weightBasisPoints'
                ),
                'placementTrial.weightBasisPoints',
                1,
                10_000
            ),
        status:
            normalizeText(
                rowValue(
                    row,
                    'status',
                    'status'
                ),
                'placementTrial.status',
                20
            ),
        rankedDebateId:
            rankedDebateId == null
                ? null
                : rankedDebateId
                    .toLowerCase(),
        philosopherId:
            philosopherId == null
                ? null
                : philosopherId
                    .toLowerCase(),
        philosopherName:
            normalizeText(
                rowValue(
                    row,
                    'philosopher_name',
                    'philosopherName'
                ),
                'placementTrial.philosopherName',
                100,
                {
                    optional: true,
                }
            ),
        topicFingerprint:
            topicFingerprint == null
                ? null
                : topicFingerprint
                    .toLowerCase(),
        finalScoreValue:
            normalizeNumber(
                rowValue(
                    row,
                    'final_score_value',
                    'finalScoreValue'
                ),
                'placementTrial.finalScoreValue',
                0,
                10,
                {
                    optional: true,
                }
            ),
        weightedScoreContribution:
            normalizeNumber(
                rowValue(
                    row,
                    'weighted_score_contribution',
                    'weightedScoreContribution'
                ),
                'placementTrial.weightedScoreContribution',
                0,
                2.5,
                {
                    optional: true,
                }
            ),
        startedAt:
            normalizeDate(
                rowValue(
                    row,
                    'started_at',
                    'startedAt'
                ),
                'placementTrial.startedAt',
                {
                    optional: true,
                }
            ),
        completedAt:
            normalizeDate(
                rowValue(
                    row,
                    'completed_at',
                    'completedAt'
                ),
                'placementTrial.completedAt',
                {
                    optional: true,
                }
            ),
        updatedAt:
            normalizeDate(
                rowValue(
                    row,
                    'updated_at',
                    'updatedAt'
                ),
                'placementTrial.updatedAt'
            ),
    });
}

function normalizeCompletionSummary(
    row
) {
    if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row)
    ) {
        fail(
            'ranked_placement_state_unavailable',
            'The Ranked placement summary is unavailable.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        completedTrials:
            normalizeInteger(
                rowValue(
                    row,
                    'completed_trials',
                    'completedTrials'
                ),
                'placementSummary.completedTrials',
                0,
                PLACEMENT_TRIALS_REQUIRED
            ),
        weightedScore:
            normalizeNumber(
                rowValue(
                    row,
                    'weighted_score',
                    'weightedScore'
                ),
                'placementSummary.weightedScore',
                0,
                10
            ),
    });
}

function placementCompletionPayload({
    debate,
    trial,
    profile,
}) {
    const scoredRoundCount =
        scoredCompletedReplies(
            debate.messages
        ).length;

    const placementCompleted =
        trial.trialNumber ===
            PLACEMENT_TRIALS_REQUIRED;

    if (
        placementCompleted &&
        profile.placementStatus !==
            'completed'
    ) {
        fail(
            'ranked_placement_state_unavailable',
            'The final Ranked placement trial is complete but the profile is not placed.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        outcome:
            debate.status === 'forfeited'
                ? 'forfeited'
                : 'completed',
        completedAt:
            debate.completedAt,
        finalScoreText:
            debate.finalScoreText,
        finalScoreValue:
            debate.finalScoreValue,
        scoredRoundCount,
        placement:
            Object.freeze({
                trialNumber:
                    trial.trialNumber,
                weightBasisPoints:
                    trial
                        .weightBasisPoints,
                weightedScoreContribution:
                    trial
                        .weightedScoreContribution,
                trialsCompleted:
                    trial.trialNumber,
                trialsRequired:
                    PLACEMENT_TRIALS_REQUIRED,
                placementCompleted,
                placementWeightedScore:
                    placementCompleted
                        ? profile
                            .placementWeightedScore
                        : null,
                startingRankKey:
                    placementCompleted
                        ? profile
                            .currentRankKey
                        : null,
                startingDivision:
                    placementCompleted
                        ? profile
                            .currentDivision
                        : null,
                startingRP:
                    placementCompleted
                        ? profile
                            .currentRP
                        : null,
                demotionProtectionDebatesRemaining:
                    placementCompleted
                        ? profile
                            .demotionProtectionDebatesRemaining
                        : 0,
            }),
    });
}

function mapCompletionPersistenceError(
    error
) {
    if (
        error?.code === '23505' &&
        String(
            error?.constraint ??
                ''
        ) ===
            'account_ranked_debates_completion_request_idx'
    ) {
        return new AccountRankedDebateError(
            'ranked_completion_request_conflict',
            'This completion request ID was already used for another Ranked debate.',
            {
                status: 409,
                retryable: false,
                cause: error,
            }
        );
    }

    if (
        error?.code === '23505' &&
        String(
            error?.constraint ??
                ''
        ) ===
            'account_ranked_debates_forfeit_request_idx'
    ) {
        return new AccountRankedDebateError(
            'ranked_forfeit_request_conflict',
            'This forfeit request ID was already used for another Ranked debate.',
            {
                status: 409,
                retryable: false,
                cause: error,
            }
        );
    }

    return null;
}

function mapDependencyError(
    error,
    fallback
) {
    if (
        error instanceof
        AccountRankedDebateError
    ) {
        return error;
    }

    return new AccountRankedDebateError(
        typeof error?.code ===
            'string' &&
        error.code
            ? error.code
            : fallback.code,
        fallback.message,
        {
            status:
                Number.isInteger(
                    error?.status
                )
                    ? error.status
                    : fallback.status,
            retryable:
                Boolean(
                    error?.retryable ??
                    fallback.retryable
                ),
            cause: error,
        }
    );
}

function sanitizedFailure(error) {
    const code =
        typeof error?.code ===
            'string' &&
        error.code
            ? error.code
            : 'ranked_generation_failed';

    return {
        code:
            code
                .trim()
                .slice(0, 100) ||
            'ranked_generation_failed',
        retryable:
            Boolean(
                error?.retryable
            ),
    };
}

function generationContext(debate) {
    return Object.freeze({
        debateId: debate.id,
        debateKind:
            debate.debateKind,
        placementTrialNumber:
            debate
                .placementTrialNumber,
        philosopherId:
            debate.philosopherId,
        philosopherName:
            debate.philosopherName,
        philosopher:
            debate.philosopher,
        debateMode:
            debate.debateMode,
        topic: debate.topic,
        topicTheme:
            debate.topicTheme,
        topicFingerprint:
            debate.topicFingerprint,
        rankedRulesVersion:
            debate.rankedRulesVersion,
        philosopherPromptVersion:
            debate
                .philosopherPromptVersion,
        scoringPromptVersion:
            debate
                .scoringPromptVersion,
        modelProvider:
            debate.modelProvider,
        modelName:
            debate.modelName,
    });
}

export function createPostgresAccountRankedDebateRepository(
    pool
) {
    if (
        !pool ||
        typeof pool.connect !==
            'function' ||
        typeof pool.query !==
            'function'
    ) {
        fail(
            'invalid_ranked_debate_configuration',
            'A PostgreSQL pool is required.'
        );
    }

    const debateColumns = `
        id,
        account_id,
        start_request_id,
        completion_request_id,
        forfeit_request_id,
        debate_kind,
        placement_trial_number,
        status,
        philosopher_id,
        philosopher_name,
        debate_mode,
        topic,
        topic_fingerprint,
        topic_theme,
        topic_model_provider,
        topic_model_name,
        topic_generated_at,
        messages,
        current_score_text,
        current_score_value,
        final_score_text,
        final_score_value,
        round_count,
        ranked_rules_version,
        philosopher_prompt_version,
        scoring_prompt_version,
        report_prompt_version,
        topic_generator_version,
        rp_formula_version,
        model_provider,
        model_name,
        state_version,
        started_at,
        last_activity_at,
        completed_at,
        updated_at
    `;

    return Object.freeze({
        async withTransaction(work) {
            const client =
                await pool.connect();

            try {
                await client.query(
                    'BEGIN'
                );

                const result =
                    await work(client);

                await client.query(
                    'COMMIT'
                );

                return result;
            } catch (error) {
                try {
                    await client.query(
                        'ROLLBACK'
                    );
                } catch {
                    // Preserve the original error.
                }

                throw error;
            } finally {
                client.release();
            }
        },

        async loadConfiguration(client) {
            const result =
                await client.query(
                    `
                        /* account-ranked-debate:load-configuration */
                        SELECT
                            configuration_key,
                            is_enabled,
                            allow_resume_active_debates
                        FROM ranked_system_configuration
                        WHERE configuration_key = 'global'
                    `
                );

            return result.rows[0] ??
                null;
        },

        async findDebateForUpdate(
            client,
            {
                accountId,
                debateId,
            }
        ) {
            const result =
                await client.query(
                    `
                        /* account-ranked-debate:find-for-update */
                        SELECT
                            ${debateColumns}
                        FROM account_ranked_debates
                        WHERE account_id = $1
                          AND id = $2
                        LIMIT 1
                        FOR UPDATE
                    `,
                    [
                        accountId,
                        debateId,
                    ]
                );

            return result.rows[0] ??
                null;
        },

        async findActiveDebateForUpdate(
            client,
            {
                accountId,
            }
        ) {
            const result =
                await client.query(
                    `
                        /* account-ranked-debate:find-active-for-update */
                        SELECT
                            ${debateColumns}
                        FROM account_ranked_debates
                        WHERE account_id = $1
                          AND status = 'active'
                        LIMIT 1
                        FOR UPDATE
                    `,
                    [
                        accountId,
                    ]
                );

            return result.rows[0] ??
                null;
        },

        async updateActiveDebate(
            client,
            {
                accountId,
                debateId,
                expectedStateVersion,
                messages,
                currentScoreText,
                currentScoreValue,
                roundCount,
                installationId,
                activityAt,
            }
        ) {
            const result =
                await client.query(
                    `
                        /* account-ranked-debate:update-active */
                        UPDATE account_ranked_debates
                        SET
                            messages = $4::jsonb,
                            current_score_text = $5,
                            current_score_value = $6,
                            round_count = $7,
                            last_synced_from_installation_id = $8,
                            state_version = state_version + 1,
                            last_activity_at = GREATEST(last_activity_at, $9),
                            updated_at = GREATEST(updated_at, $9)
                        WHERE account_id = $1
                          AND id = $2
                          AND status = 'active'
                          AND state_version = $3
                        RETURNING
                            ${debateColumns}
                    `,
                    [
                        accountId,
                        debateId,
                        expectedStateVersion,
                        JSON.stringify(
                            messages
                        ),
                        currentScoreText,
                        currentScoreValue,
                        roundCount,
                        installationId,
                        activityAt,
                    ]
                );

            return result.rows[0] ??
                null;
        },

        async findPlacementProfileForUpdate(
            client,
            {
                accountId,
            }
        ) {
            const result =
                await client.query(
                    `
                        /* account-ranked-debate:find-placement-profile-for-update */
                        SELECT
                            account_id,
                            placement_status,
                            placement_trials_completed,
                            placement_weighted_score,
                            current_rank_key,
                            current_division,
                            current_rp,
                            peak_rank_key,
                            peak_division,
                            peak_reached_at,
                            demotion_protection_debates_remaining,
                            ranked_debates_completed,
                            state_version,
                            updated_at
                        FROM account_ranked_profiles
                        WHERE account_id = $1
                        FOR UPDATE
                    `,
                    [
                        accountId,
                    ]
                );

            return result.rows[0] ??
                null;
        },

        async findPlacementTrialForUpdate(
            client,
            {
                accountId,
                trialNumber,
            }
        ) {
            const result =
                await client.query(
                    `
                        /* account-ranked-debate:find-placement-trial-for-update */
                        SELECT
                            account_id,
                            trial_number,
                            required_mode,
                            weight_basis_points,
                            status,
                            ranked_debate_id,
                            philosopher_id,
                            philosopher_name,
                            topic_fingerprint,
                            final_score_value,
                            weighted_score_contribution,
                            started_at,
                            completed_at,
                            updated_at
                        FROM account_ranked_placement_trials
                        WHERE account_id = $1
                          AND trial_number = $2
                        FOR UPDATE
                    `,
                    [
                        accountId,
                        trialNumber,
                    ]
                );

            return result.rows[0] ??
                null;
        },

        async completePlacementDebate(
            client,
            {
                accountId,
                debateId,
                expectedStateVersion,
                requestId,
                finalScoreText,
                finalScoreValue,
                installationId,
                completedAt,
            }
        ) {
            const result =
                await client.query(
                    `
                        /* account-ranked-debate:complete-placement-debate */
                        UPDATE account_ranked_debates
                        SET
                            completion_request_id = $4,
                            status = 'completed',
                            final_score_text = $5,
                            final_score_value = $6,
                            last_synced_from_installation_id = $7,
                            state_version = state_version + 1,
                            last_activity_at = GREATEST(
                                last_activity_at,
                                $8
                            ),
                            completed_at = $8,
                            updated_at = GREATEST(
                                updated_at,
                                $8
                            )
                        WHERE account_id = $1
                          AND id = $2
                          AND status = 'active'
                          AND state_version = $3
                        RETURNING
                            ${debateColumns}
                    `,
                    [
                        accountId,
                        debateId,
                        expectedStateVersion,
                        requestId,
                        finalScoreText,
                        finalScoreValue,
                        installationId,
                        completedAt,
                    ]
                );

            return result.rows[0] ??
                null;
        },

        async forfeitPlacementDebate(
            client,
            {
                accountId,
                debateId,
                expectedStateVersion,
                requestId,
                installationId,
                forfeitedAt,
            }
        ) {
            const result =
                await client.query(
                    `
                        /* account-ranked-debate:forfeit-placement-debate */
                        UPDATE account_ranked_debates
                        SET
                            forfeit_request_id = $4,
                            status = 'forfeited',
                            final_score_text = '0.00/10',
                            final_score_value = 0,
                            last_synced_from_installation_id = $5,
                            state_version = state_version + 1,
                            last_activity_at = GREATEST(
                                last_activity_at,
                                $6
                            ),
                            completed_at = $6,
                            updated_at = GREATEST(
                                updated_at,
                                $6
                            )
                        WHERE account_id = $1
                          AND id = $2
                          AND status = 'active'
                          AND state_version = $3
                        RETURNING
                            ${debateColumns}
                    `,
                    [
                        accountId,
                        debateId,
                        expectedStateVersion,
                        requestId,
                        installationId,
                        forfeitedAt,
                    ]
                );

            return result.rows[0] ??
                null;
        },

        async completePlacementTrial(
            client,
            {
                accountId,
                trialNumber,
                debateId,
                finalScoreValue,
                weightedScoreContribution,
                completedAt,
            }
        ) {
            const result =
                await client.query(
                    `
                        /* account-ranked-debate:complete-placement-trial */
                        UPDATE account_ranked_placement_trials
                        SET
                            status = 'completed',
                            final_score_value = $4,
                            weighted_score_contribution = $5,
                            completed_at = $6,
                            updated_at = GREATEST(
                                updated_at,
                                $6
                            )
                        WHERE account_id = $1
                          AND trial_number = $2
                          AND ranked_debate_id = $3
                          AND status = 'active'
                        RETURNING
                            account_id,
                            trial_number,
                            required_mode,
                            weight_basis_points,
                            status,
                            ranked_debate_id,
                            philosopher_id,
                            philosopher_name,
                            topic_fingerprint,
                            final_score_value,
                            weighted_score_contribution,
                            started_at,
                            completed_at,
                            updated_at
                    `,
                    [
                        accountId,
                        trialNumber,
                        debateId,
                        finalScoreValue,
                        weightedScoreContribution,
                        completedAt,
                    ]
                );

            return result.rows[0] ??
                null;
        },

        async forfeitPlacementTrial(
            client,
            {
                accountId,
                trialNumber,
                debateId,
                forfeitedAt,
            }
        ) {
            const result =
                await client.query(
                    `
                        /* account-ranked-debate:forfeit-placement-trial */
                        UPDATE account_ranked_placement_trials
                        SET
                            status = 'forfeited',
                            final_score_value = 0,
                            weighted_score_contribution = 0,
                            completed_at = $4,
                            updated_at = GREATEST(
                                updated_at,
                                $4
                            )
                        WHERE account_id = $1
                          AND trial_number = $2
                          AND ranked_debate_id = $3
                          AND status = 'active'
                        RETURNING
                            account_id,
                            trial_number,
                            required_mode,
                            weight_basis_points,
                            status,
                            ranked_debate_id,
                            philosopher_id,
                            philosopher_name,
                            topic_fingerprint,
                            final_score_value,
                            weighted_score_contribution,
                            started_at,
                            completed_at,
                            updated_at
                    `,
                    [
                        accountId,
                        trialNumber,
                        debateId,
                        forfeitedAt,
                    ]
                );

            return result.rows[0] ??
                null;
        },

        async loadPlacementCompletionSummary(
            client,
            {
                accountId,
            }
        ) {
            const result =
                await client.query(
                    `
                        /* account-ranked-debate:load-placement-completion-summary */
                        SELECT
                            COUNT(*) FILTER (
                                WHERE status IN (
                                    'completed',
                                    'forfeited'
                                )
                            )::integer AS completed_trials,
                            COALESCE(
                                SUM(
                                    weighted_score_contribution
                                ) FILTER (
                                    WHERE status IN (
                                        'completed',
                                        'forfeited'
                                    )
                                ),
                                0
                            )::numeric(7, 4) AS weighted_score
                        FROM account_ranked_placement_trials
                        WHERE account_id = $1
                    `,
                    [
                        accountId,
                    ]
                );

            return result.rows[0] ??
                null;
        },

        async updatePlacementProfile(
            client,
            {
                accountId,
                expectedStateVersion,
                placementStatus,
                placementTrialsCompleted,
                placementWeightedScore,
                rankKey,
                division,
                rp,
                completedAt,
                incrementRankedDebatesCompleted =
                    true,
            }
        ) {
            const placementCompleted =
                placementStatus ===
                    'completed';

            const result =
                await client.query(
                    `
                        /* account-ranked-debate:update-placement-profile */
                        UPDATE account_ranked_profiles
                        SET
                            placement_status = $3::text,
                            placement_trials_completed =
                                $4::smallint,
                            placement_weighted_score =
                                $5::numeric,
                            current_rank_key = $6::text,
                            current_division = $7::smallint,
                            current_rp = $8::integer,
                            peak_rank_key = $6::text,
                            peak_division = $7::smallint,
                            peak_reached_at =
                                CASE
                                    WHEN $6::text IS NULL
                                        THEN NULL
                                    ELSE $9::timestamptz
                                END,
                            demotion_protection_debates_remaining =
                                CASE
                                    WHEN $10::boolean
                                        THEN 1
                                    ELSE 0
                                END,
                            demotion_protection_reason =
                                CASE
                                    WHEN $10::boolean
                                        THEN 'placement'
                                    ELSE NULL
                                END,
                            demotion_protection_granted_at =
                                CASE
                                    WHEN $10::boolean
                                        THEN $9::timestamptz
                                    ELSE NULL
                                END,
                            ranked_debates_completed =
                                ranked_debates_completed +
                                CASE
                                    WHEN $11::boolean
                                        THEN 1
                                    ELSE 0
                                END,
                            last_ranked_debate_completed_at =
                                CASE
                                    WHEN $11::boolean
                                        THEN $9::timestamptz
                                    ELSE
                                        last_ranked_debate_completed_at
                                END,
                            state_version = state_version + 1,
                            updated_at = GREATEST(
                                updated_at,
                                $9::timestamptz
                            )
                        WHERE account_id = $1::uuid
                          AND state_version = $2::integer
                          AND placement_status = 'in_progress'
                        RETURNING
                            account_id,
                            placement_status,
                            placement_trials_completed,
                            placement_weighted_score,
                            current_rank_key,
                            current_division,
                            current_rp,
                            peak_rank_key,
                            peak_division,
                            peak_reached_at,
                            demotion_protection_debates_remaining,
                            ranked_debates_completed,
                            state_version,
                            updated_at
                    `,
                    [
                        accountId,
                        expectedStateVersion,
                        placementStatus,
                        placementTrialsCompleted,
                        placementWeightedScore,
                        rankKey,
                        division,
                        rp,
                        completedAt,
                        placementCompleted,
                        incrementRankedDebatesCompleted,
                    ]
                );

            return result.rows[0] ??
                null;
        },

        async insertPlacementTrialEvent(
            client,
            {
                accountId,
                debate,
                trial,
                finalScoreValue,
                weightedScoreContribution,
                occurredAt,
                forfeited = false,
            }
        ) {
            await client.query(
                `
                    /* account-ranked-debate:insert-placement-trial-event */
                    INSERT INTO account_ranked_rating_events (
                        account_id,
                        ranked_debate_id,
                        event_type,
                        placement_trial_number,
                        philosopher_id,
                        philosopher_name,
                        debate_mode,
                        topic_fingerprint,
                        final_score_value,
                        protection_before,
                        protection_after,
                        protection_applied,
                        protection_consumed,
                        ranked_rules_version,
                        philosopher_prompt_version,
                        scoring_prompt_version,
                        report_prompt_version,
                        topic_generator_version,
                        rp_formula_version,
                        model_provider,
                        model_name,
                        formula_components,
                        occurred_at,
                        created_at
                    )
                    VALUES (
                        $1,
                        $2,
                        'placement_trial',
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        0,
                        0,
                        FALSE,
                        FALSE,
                        $9,
                        $10,
                        $11,
                        $12,
                        $13,
                        $14,
                        $15,
                        $16,
                        $17::jsonb,
                        $18,
                        $18
                    )
                `,
                [
                    accountId,
                    debate.id,
                    trial.trialNumber,
                    debate.philosopherId,
                    debate.philosopherName,
                    debate.debateMode,
                    debate.topicFingerprint,
                    finalScoreValue,
                    debate.rankedRulesVersion,
                    debate.philosopherPromptVersion,
                    debate.scoringPromptVersion,
                    debate.reportPromptVersion,
                    debate.topicGeneratorVersion,
                    debate.rpFormulaVersion,
                    debate.modelProvider,
                    debate.modelName,
                    JSON.stringify({
                        formula:
                            'placement_weighted_average_v1',
                        weightBasisPoints:
                            trial.weightBasisPoints,
                        weightedScoreContribution,
                        forfeited:
                            Boolean(
                                forfeited
                            ),
                    }),
                    occurredAt,
                ]
            );
        },

        async insertPlacementCompletedEvent(
            client,
            {
                accountId,
                debate,
                placementWeightedScore,
                placement,
                occurredAt,
            }
        ) {
            await client.query(
                `
                    /* account-ranked-debate:insert-placement-completed-event */
                    INSERT INTO account_ranked_rating_events (
                        account_id,
                        ranked_debate_id,
                        event_type,
                        placement_trial_number,
                        philosopher_id,
                        philosopher_name,
                        debate_mode,
                        topic_fingerprint,
                        final_score_value,
                        after_rank_key,
                        after_division,
                        after_rp,
                        promoted,
                        demoted,
                        protection_before,
                        protection_after,
                        protection_applied,
                        protection_consumed,
                        ranked_rules_version,
                        philosopher_prompt_version,
                        scoring_prompt_version,
                        report_prompt_version,
                        topic_generator_version,
                        rp_formula_version,
                        model_provider,
                        model_name,
                        formula_components,
                        occurred_at,
                        created_at
                    )
                    VALUES (
                        $1,
                        $2,
                        'placement_completed',
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        $9,
                        $10,
                        0,
                        FALSE,
                        FALSE,
                        0,
                        1,
                        TRUE,
                        FALSE,
                        $11,
                        $12,
                        $13,
                        $14,
                        $15,
                        $16,
                        $17,
                        $18,
                        $19::jsonb,
                        $20,
                        $20
                    )
                `,
                [
                    accountId,
                    debate.id,
                    debate.placementTrialNumber,
                    debate.philosopherId,
                    debate.philosopherName,
                    debate.debateMode,
                    debate.topicFingerprint,
                    placementWeightedScore,
                    placement.rankKey,
                    placement.division,
                    debate.rankedRulesVersion,
                    debate.philosopherPromptVersion,
                    debate.scoringPromptVersion,
                    debate.reportPromptVersion,
                    debate.topicGeneratorVersion,
                    debate.rpFormulaVersion,
                    debate.modelProvider,
                    debate.modelName,
                    JSON.stringify({
                        formula:
                            'placement_cutoffs_v1',
                        placementWeightedScore,
                        startingRankKey:
                            placement.rankKey,
                        startingDivision:
                            placement.division,
                        startingRP: 0,
                    }),
                    occurredAt,
                ]
            );
        },
    });
}

export function createAccountRankedDebateService({
    pool = null,
    repository = null,
    accountAuthService,
    proAccessService,
    debateEngineService,
    now = () => Date.now(),
    createId =
        () =>
            crypto.randomUUID(),
    generationLeaseMs =
        GENERATION_LEASE_MS,
} = {}) {
    if (
        !accountAuthService ||
        typeof accountAuthService
            .authorizeAccessToken !==
            'function'
    ) {
        fail(
            'invalid_ranked_debate_configuration',
            'accountAuthService.authorizeAccessToken() is required.'
        );
    }

    if (
        !proAccessService ||
        typeof proAccessService
            .requireCurrentProAccess !==
            'function'
    ) {
        fail(
            'invalid_ranked_debate_configuration',
            'proAccessService.requireCurrentProAccess() is required.'
        );
    }

    if (
        !debateEngineService ||
        typeof debateEngineService
            .generateOpening !==
            'function' ||
        typeof debateEngineService
            .generateReply !==
            'function'
    ) {
        fail(
            'invalid_ranked_debate_configuration',
            'A Ranked debate engine with generateOpening() and generateReply() is required.'
        );
    }

    if (
        typeof now !==
            'function'
    ) {
        fail(
            'invalid_ranked_debate_configuration',
            'now must be a function.'
        );
    }

    if (
        typeof createId !==
            'function'
    ) {
        fail(
            'invalid_ranked_debate_configuration',
            'createId must be a function.'
        );
    }

    if (
        !Number.isSafeInteger(
            generationLeaseMs
        ) ||
        generationLeaseMs <
            60_000
    ) {
        fail(
            'invalid_ranked_debate_configuration',
            'generationLeaseMs must be at least 60000 milliseconds.'
        );
    }

    const repo =
        repository ??
        createPostgresAccountRankedDebateRepository(
            pool
        );

    const requiredRepositoryMethods = [
        'withTransaction',
        'loadConfiguration',
        'findDebateForUpdate',
        'findActiveDebateForUpdate',
        'updateActiveDebate',
    ];

    for (
        const method
        of requiredRepositoryMethods
    ) {
        if (
            typeof repo?.[method] !==
            'function'
        ) {
            fail(
                'invalid_ranked_debate_configuration',
                `Ranked debate repository is missing ${method}().`
            );
        }
    }

    function requireRepositoryMethods(
        methods
    ) {
        for (const method of methods) {
            if (
                typeof repo?.[method] !==
                'function'
            ) {
                fail(
                    'invalid_ranked_debate_configuration',
                    `Ranked debate repository is missing ${method}().`
                );
            }
        }
    }

    function requireCompletionRepository() {
        requireRepositoryMethods([
            'findPlacementProfileForUpdate',
            'findPlacementTrialForUpdate',
            'completePlacementDebate',
            'completePlacementTrial',
            'loadPlacementCompletionSummary',
            'updatePlacementProfile',
            'insertPlacementTrialEvent',
            'insertPlacementCompletedEvent',
        ]);
    }

    function requireForfeitRepository() {
        requireRepositoryMethods([
            'findPlacementProfileForUpdate',
            'findPlacementTrialForUpdate',
            'forfeitPlacementDebate',
            'forfeitPlacementTrial',
            'loadPlacementCompletionSummary',
            'updatePlacementProfile',
            'insertPlacementTrialEvent',
            'insertPlacementCompletedEvent',
        ]);
    }

    async function authorize({
        installationId,
        accessToken,
    }) {
        const cleanInstallationId =
            requireInstallationId(
                installationId
            );

        const cleanAccessToken =
            requireString(
                accessToken,
                'accessToken',
                {
                    maximumLength:
                        16_384,
                }
            );

        try {
            const authorization =
                await accountAuthService
                    .authorizeAccessToken({
                        installationId:
                            cleanInstallationId,
                        accessToken:
                            cleanAccessToken,
                    });

            return normalizeAuthorization(
                authorization,
                cleanInstallationId
            );
        } catch (error) {
            throw mapDependencyError(
                error,
                {
                    code:
                        'invalid_access_token',
                    message:
                        'The Agora account session is invalid or expired.',
                    status: 401,
                    retryable: false,
                }
            );
        }
    }

    async function requirePro(
        accountId
    ) {
        try {
            return await proAccessService
                .requireCurrentProAccess({
                    accountId,
                });
        } catch (error) {
            throw mapDependencyError(
                error,
                {
                    code:
                        'pro_access_unavailable',
                    message:
                        'Agora Pro access could not be verified.',
                    status: 503,
                    retryable: true,
                }
            );
        }
    }

    async function loadLockedDebate({
        client,
        accountId,
        debateId,
    }) {
        const row =
            debateId
                ? await repo
                    .findDebateForUpdate(
                        client,
                        {
                            accountId,
                            debateId,
                        }
                    )
                : await repo
                    .findActiveDebateForUpdate(
                        client,
                        {
                            accountId,
                        }
                    );

        return normalizeDebate(
            row,
            accountId
        );
    }

    function requireActiveDebate(
        debate
    ) {
        if (
            debate.status !==
            'active'
        ) {
            fail(
                'ranked_debate_not_active',
                'This Ranked debate is no longer active.',
                {
                    status: 409,
                    retryable: false,
                }
            );
        }
    }

    function requireExpectedVersion(
        debate,
        expectedStateVersion
    ) {
        if (
            debate.stateVersion !==
            expectedStateVersion
        ) {
            fail(
                'ranked_state_conflict',
                'The Ranked debate changed before this request was applied.',
                {
                    status: 409,
                    retryable: true,
                    details: {
                        expectedStateVersion,
                        currentStateVersion:
                            debate
                                .stateVersion,
                    },
                }
            );
        }
    }

    async function persistMessages({
        client,
        debate,
        messages,
        installationId,
        activityAt,
        currentScoreText =
            debate.currentScoreText,
        currentScoreValue =
            debate.currentScoreValue,
        roundCount =
            debate.roundCount,
    }) {
        if (
            activityAt <
            debate.startedAt
        ) {
            fail(
                'invalid_ranked_debate_configuration',
                'now() cannot be earlier than the Ranked debate start time.'
            );
        }

        const updated =
            await repo
                .updateActiveDebate(
                    client,
                    {
                        accountId:
                            debate.accountId,
                        debateId:
                            debate.id,
                        expectedStateVersion:
                            debate
                                .stateVersion,
                        messages:
                            storagePayload(
                                messages
                            ),
                        currentScoreText,
                        currentScoreValue,
                        roundCount,
                        installationId,
                        activityAt,
                    }
                );

        if (!updated) {
            fail(
                'ranked_state_conflict',
                'The Ranked debate changed before this request was applied.',
                {
                    status: 409,
                    retryable: true,
                }
            );
        }

        return normalizeDebate(
            updated,
            debate.accountId
        );
    }

    async function resumeActiveDebate({
        installationId,
        accessToken,
        debateId = null,
    }) {
        const authorization =
            await authorize({
                installationId,
                accessToken,
            });

        await requirePro(
            authorization.accountId
        );

        const cleanDebateId =
            debateId == null
                ? null
                : requireUuid(
                    debateId,
                    'debateId'
                );

        const result =
            await repo.withTransaction(
                async (client) => {
                    const configuration =
                        normalizeConfiguration(
                            await repo
                                .loadConfiguration(
                                    client
                                )
                        );

                    requireContinuationEnabled(
                        configuration
                    );

                    const debate =
                        await loadLockedDebate({
                            client,
                            accountId:
                                authorization
                                    .accountId,
                            debateId:
                                cleanDebateId,
                        });

                    requireActiveDebate(
                        debate
                    );

                    return debate;
                }
            );

        return Object.freeze({
            schemaVersion:
                RANKED_DEBATE_SCHEMA_VERSION,
            accountId:
                authorization.accountId,
            installationId:
                authorization
                    .installationId,
            resumedAt:
                serviceDate(now),
            debate:
                publicDebate(result),
        });
    }

    async function reserveOpening({
        authorization,
        debateId,
        requestId,
        expectedStateVersion,
    }) {
        const checkedAt =
            serviceDate(now);

        return repo.withTransaction(
            async (client) => {
                const configuration =
                    normalizeConfiguration(
                        await repo
                            .loadConfiguration(
                                client
                            )
                    );

                requireContinuationEnabled(
                    configuration
                );

                const debate =
                    await loadLockedDebate({
                        client,
                        accountId:
                            authorization
                                .accountId,
                        debateId,
                    });

                requireActiveDebate(
                    debate
                );

                const hasExistingOpeningRequest =
                    completedOpening(
                        debate.messages
                    ) != null ||
                    assistantForRequest(
                        debate.messages,
                        requestId
                    ) != null;

                if (!hasExistingOpeningRequest) {
                    requireExpectedVersion(
                        debate,
                        expectedStateVersion
                    );
                }

                const reservation =
                    reserveOpeningMessages({
                        messages:
                            debate.messages,
                        requestId,
                        checkedAt,
                        createId,
                        generationLeaseMs,
                    });

                if (
                    reservation.action ===
                    'existing'
                ) {
                    return Object.freeze({
                        action:
                            'existing',
                        requestId:
                            reservation
                                .requestId,
                        debate,
                        reply:
                            reservation.reply,
                    });
                }

                const updatedDebate =
                    await persistMessages({
                        client,
                        debate,
                        messages:
                            reservation
                                .messages,
                        installationId:
                            authorization
                                .installationId,
                        activityAt:
                            checkedAt,
                    });

                return Object.freeze({
                    action:
                        'generate',
                    requestId,
                    generationId:
                        reservation
                            .generationId,
                    debate:
                        updatedDebate,
                });
            }
        );
    }

    async function reserveTurn({
        authorization,
        debateId,
        requestId,
        expectedStateVersion,
        content,
    }) {
        const checkedAt =
            serviceDate(now);

        return repo.withTransaction(
            async (client) => {
                const configuration =
                    normalizeConfiguration(
                        await repo
                            .loadConfiguration(
                                client
                            )
                    );

                requireContinuationEnabled(
                    configuration
                );

                const debate =
                    await loadLockedDebate({
                        client,
                        accountId:
                            authorization
                                .accountId,
                        debateId,
                    });

                requireActiveDebate(
                    debate
                );

                const hasExistingTurnRequest =
                    messagesForRequest(
                        debate.messages,
                        requestId
                    ).length > 0;

                if (
                    !hasExistingTurnRequest &&
                    debate.roundCount >=
                        MAX_ROUNDS
                ) {
                    fail(
                        'ranked_debate_round_limit_reached',
                        'This Ranked debate has reached its round limit.',
                        {
                            status: 409,
                            retryable: false,
                        }
                    );
                }

                if (!hasExistingTurnRequest) {
                    requireExpectedVersion(
                        debate,
                        expectedStateVersion
                    );
                }

                const nextRound =
                    hasExistingTurnRequest
                        ? debate.roundCount
                        : debate.roundCount + 1;

                const reservation =
                    reserveTurnMessages({
                        messages:
                            debate.messages,
                        requestId,
                        content,
                        roundNumber:
                            nextRound,
                        checkedAt,
                        createId,
                        generationLeaseMs,
                    });

                if (
                    reservation.action ===
                    'existing'
                ) {
                    return Object.freeze({
                        action:
                            'existing',
                        requestId,
                        debate,
                        reply:
                            reservation.reply,
                    });
                }

                const updatedDebate =
                    await persistMessages({
                        client,
                        debate,
                        messages:
                            reservation
                                .messages,
                        installationId:
                            authorization
                                .installationId,
                        activityAt:
                            checkedAt,
                        roundCount:
                            nextRound,
                    });

                return Object.freeze({
                    action:
                        'generate',
                    requestId,
                    generationId:
                        reservation
                            .generationId,
                    debate:
                        updatedDebate,
                });
            }
        );
    }

    async function markGenerationFailed({
        authorization,
        debateId,
        requestId,
        generationId,
        publicError,
    }) {
        const failedAt =
            serviceDate(now);

        try {
            await repo.withTransaction(
                async (client) => {
                    const debate =
                        await loadLockedDebate({
                            client,
                            accountId:
                                authorization
                                    .accountId,
                            debateId,
                        });

                    if (
                        debate.status !==
                        'active'
                    ) {
                        return;
                    }

                    const pending =
                        assistantForRequest(
                            debate.messages,
                            requestId
                        );

                    if (
                        !pending ||
                        pending.status !==
                            'pending' ||
                        pending.generationId !==
                            generationId
                    ) {
                        return;
                    }

                    const failure =
                        sanitizedFailure(
                            publicError
                        );

                    const next =
                        cloneMessages(
                            debate.messages
                        );

                    const index =
                        next.findIndex(
                            (message) =>
                                message.id ===
                                pending.id
                        );

                    next[index] = {
                        ...next[index],
                        status: 'failed',
                        visible: false,
                        content: '',
                        scoreText: null,
                        scoreValue: null,
                        failureCode:
                            failure.code,
                        failureRetryable:
                            failure.retryable,
                        completedAt:
                            failedAt,
                    };

                    await persistMessages({
                        client,
                        debate,
                        messages:
                            Object.freeze(
                                next
                            ),
                        installationId:
                            authorization
                                .installationId,
                        activityAt:
                            failedAt,
                    });
                }
            );
        } catch {
            // Preserve the original public generation error.
            // A stale request can be reclaimed with the same requestId.
        }
    }

    async function finalizeGeneration({
        authorization,
        debateId,
        requestId,
        generationId,
        engineResult,
        opening,
    }) {
        const completedAt =
            serviceDate(now);

        return repo.withTransaction(
            async (client) => {
                const configuration =
                    normalizeConfiguration(
                        await repo
                            .loadConfiguration(
                                client
                            )
                    );

                requireContinuationEnabled(
                    configuration
                );

                const debate =
                    await loadLockedDebate({
                        client,
                        accountId:
                            authorization
                                .accountId,
                        debateId,
                    });

                requireActiveDebate(
                    debate
                );

                const assistant =
                    assistantForRequest(
                        debate.messages,
                        requestId
                    );

                if (!assistant) {
                    fail(
                        'ranked_generation_state_unavailable',
                        'The Ranked generation reservation could not be found.',
                        {
                            status: 503,
                            retryable: true,
                        }
                    );
                }

                if (
                    assistant.status ===
                    'completed'
                ) {
                    return Object.freeze({
                        created: false,
                        debate,
                        reply:
                            assistant,
                    });
                }

                if (
                    assistant.generationId !==
                    generationId
                ) {
                    fail(
                        'ranked_generation_superseded',
                        'A newer attempt is generating this Ranked response.',
                        {
                            status: 409,
                            retryable: true,
                            details: {
                                requestId,
                            },
                        }
                    );
                }

                if (
                    assistant.status !==
                    'pending'
                ) {
                    fail(
                        'ranked_generation_state_unavailable',
                        'The Ranked generation reservation is not active.',
                        {
                            status: 409,
                            retryable:
                                Boolean(
                                    assistant
                                        .failureRetryable
                                ),
                        }
                    );
                }

                if (
                    assistant.kind !==
                    (
                        opening
                            ? 'opening'
                            : 'turn'
                    )
                ) {
                    fail(
                        'ranked_request_id_conflict',
                        'requestId belongs to a different Ranked action.',
                        { status: 409 }
                    );
                }

                const next =
                    cloneMessages(
                        debate.messages
                    );

                const index =
                    next.findIndex(
                        (message) =>
                            message.id ===
                            assistant.id
                    );

                next[index] = {
                    ...next[index],
                    status: 'completed',
                    visible: true,
                    content:
                        engineResult.text,
                    scoreText:
                        engineResult
                            .scoreText,
                    scoreValue:
                        engineResult
                            .scoreValue,
                    failureCode: null,
                    failureRetryable:
                        null,
                    completedAt,
                };

                const scoreText =
                    engineResult
                        .scoreText ??
                    debate
                        .currentScoreText;

                const scoreValue =
                    engineResult
                        .scoreValue ??
                    debate
                        .currentScoreValue;

                const updatedDebate =
                    await persistMessages({
                        client,
                        debate,
                        messages:
                            Object.freeze(
                                next
                            ),
                        installationId:
                            authorization
                                .installationId,
                        activityAt:
                            completedAt,
                        currentScoreText:
                            scoreText,
                        currentScoreValue:
                            scoreValue,
                    });

                const completedReply =
                    completedAssistantForRequest(
                        updatedDebate
                            .messages,
                        requestId
                    );

                if (!completedReply) {
                    fail(
                        'ranked_generation_state_unavailable',
                        'The completed Ranked response could not be loaded.',
                        {
                            status: 503,
                            retryable: true,
                        }
                    );
                }

                return Object.freeze({
                    created: true,
                    debate:
                        updatedDebate,
                    reply:
                        completedReply,
                });
            }
        );
    }

    async function generateOpening({
        installationId,
        accessToken,
        debateId,
        requestId,
        expectedStateVersion,
    }) {
        const authorization =
            await authorize({
                installationId,
                accessToken,
            });

        await requirePro(
            authorization.accountId
        );

        const cleanDebateId =
            requireUuid(
                debateId,
                'debateId'
            );

        const cleanRequestId =
            requireUuid(
                requestId,
                'requestId'
            );

        const cleanExpectedVersion =
            requireStateVersion(
                expectedStateVersion
            );

        const reservation =
            await reserveOpening({
                authorization,
                debateId:
                    cleanDebateId,
                requestId:
                    cleanRequestId,
                expectedStateVersion:
                    cleanExpectedVersion,
            });

        if (
            reservation.action ===
            'existing'
        ) {
            return Object.freeze({
                schemaVersion:
                    RANKED_DEBATE_SCHEMA_VERSION,
                accountId:
                    authorization.accountId,
                installationId:
                    authorization
                        .installationId,
                requestId:
                    reservation
                        .requestId,
                created: false,
                debate:
                    publicDebate(
                        reservation
                            .debate
                    ),
                reply:
                    publicMessage(
                        reservation
                            .reply
                    ),
            });
        }

        let engineResult;

        try {
            const raw =
                await debateEngineService
                    .generateOpening({
                        requestId:
                            cleanRequestId,
                        context:
                            generationContext(
                                reservation
                                    .debate
                            ),
                        conversation:
                            visibleConversation(
                                reservation
                                    .debate
                                    .messages
                            ),
                    });

            engineResult =
                normalizeEngineResult(
                    raw,
                    reservation.debate,
                    {
                        opening: true,
                    }
                );
        } catch (error) {
            const publicError =
                mapDependencyError(
                    error,
                    {
                        code:
                            'ranked_opening_generation_failed',
                        message:
                            'The Ranked opening could not be generated.',
                        status: 503,
                        retryable: true,
                    }
                );

            await markGenerationFailed({
                authorization,
                debateId:
                    cleanDebateId,
                requestId:
                    cleanRequestId,
                generationId:
                    reservation
                        .generationId,
                publicError,
            });

            throw publicError;
        }

        let finalized;

        try {
            finalized =
                await finalizeGeneration({
                    authorization,
                    debateId:
                        cleanDebateId,
                    requestId:
                        cleanRequestId,
                    generationId:
                        reservation
                            .generationId,
                    engineResult,
                    opening: true,
                });
        } catch (error) {
            if (
                error instanceof
                AccountRankedDebateError
            ) {
                throw error;
            }

            fail(
                'ranked_debate_persistence_failed',
                'The Ranked opening could not be saved.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }

        return Object.freeze({
            schemaVersion:
                RANKED_DEBATE_SCHEMA_VERSION,
            accountId:
                authorization.accountId,
            installationId:
                authorization
                    .installationId,
            requestId:
                cleanRequestId,
            created:
                finalized.created,
            debate:
                publicDebate(
                    finalized.debate
                ),
            reply:
                publicMessage(
                    finalized.reply
                ),
        });
    }

    async function submitTurn({
        installationId,
        accessToken,
        debateId,
        requestId,
        expectedStateVersion,
        content,
    }) {
        const authorization =
            await authorize({
                installationId,
                accessToken,
            });

        await requirePro(
            authorization.accountId
        );

        const cleanDebateId =
            requireUuid(
                debateId,
                'debateId'
            );

        const cleanRequestId =
            requireUuid(
                requestId,
                'requestId'
            );

        const cleanExpectedVersion =
            requireStateVersion(
                expectedStateVersion
            );

        const cleanContent =
            requireUserContent(
                content
            );

        const reservation =
            await reserveTurn({
                authorization,
                debateId:
                    cleanDebateId,
                requestId:
                    cleanRequestId,
                expectedStateVersion:
                    cleanExpectedVersion,
                content:
                    cleanContent,
            });

        if (
            reservation.action ===
            'existing'
        ) {
            return Object.freeze({
                schemaVersion:
                    RANKED_DEBATE_SCHEMA_VERSION,
                accountId:
                    authorization.accountId,
                installationId:
                    authorization
                        .installationId,
                requestId:
                    cleanRequestId,
                created: false,
                debate:
                    publicDebate(
                        reservation
                            .debate
                    ),
                reply:
                    publicMessage(
                        reservation
                            .reply
                    ),
            });
        }

        let engineResult;

        try {
            const raw =
                await debateEngineService
                    .generateReply({
                        requestId:
                            cleanRequestId,
                        context:
                            generationContext(
                                reservation
                                    .debate
                            ),
                        conversation:
                            visibleConversation(
                                reservation
                                    .debate
                                    .messages
                            ),
                        roundNumber:
                            reservation
                                .debate
                                .roundCount,
                    });

            engineResult =
                normalizeEngineResult(
                    raw,
                    reservation.debate,
                    {
                        opening: false,
                        roundNumber:
                            reservation
                                .debate
                                .roundCount,
                    }
                );
        } catch (error) {
            const publicError =
                mapDependencyError(
                    error,
                    {
                        code:
                            'ranked_reply_generation_failed',
                        message:
                            'The Ranked response could not be generated.',
                        status: 503,
                        retryable: true,
                    }
                );

            await markGenerationFailed({
                authorization,
                debateId:
                    cleanDebateId,
                requestId:
                    cleanRequestId,
                generationId:
                    reservation
                        .generationId,
                publicError,
            });

            throw publicError;
        }

        let finalized;

        try {
            finalized =
                await finalizeGeneration({
                    authorization,
                    debateId:
                        cleanDebateId,
                    requestId:
                        cleanRequestId,
                    generationId:
                        reservation
                            .generationId,
                    engineResult,
                    opening: false,
                });
        } catch (error) {
            if (
                error instanceof
                AccountRankedDebateError
            ) {
                throw error;
            }

            fail(
                'ranked_debate_persistence_failed',
                'The Ranked response could not be saved.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }

        return Object.freeze({
            schemaVersion:
                RANKED_DEBATE_SCHEMA_VERSION,
            accountId:
                authorization.accountId,
            installationId:
                authorization
                    .installationId,
            requestId:
                cleanRequestId,
            created:
                finalized.created,
            debate:
                publicDebate(
                    finalized.debate
                ),
            reply:
                publicMessage(
                    finalized.reply
                ),
        });
    }


    async function completeDebate({
        installationId,
        accessToken,
        debateId,
        requestId,
        expectedStateVersion,
    }) {
        const authorization =
            await authorize({
                installationId,
                accessToken,
            });

        await requirePro(
            authorization.accountId
        );

        requireCompletionRepository();

        const cleanDebateId =
            requireUuid(
                debateId,
                'debateId'
            );

        const cleanRequestId =
            requireUuid(
                requestId,
                'requestId'
            );

        const cleanExpectedVersion =
            requireStateVersion(
                expectedStateVersion
            );

        const completedAt =
            serviceDate(now);

        let result;

        try {
            result =
                await repo.withTransaction(
                    async (client) => {
                        const configuration =
                            normalizeConfiguration(
                                await repo
                                    .loadConfiguration(
                                        client
                                    )
                            );

                        requireContinuationEnabled(
                            configuration
                        );

                        const debate =
                            await loadLockedDebate({
                                client,
                                accountId:
                                    authorization
                                        .accountId,
                                debateId:
                                    cleanDebateId,
                            });

                        if (
                            debate.status ===
                                'completed'
                        ) {
                            if (
                                debate
                                    .completionRequestId !==
                                cleanRequestId
                            ) {
                                fail(
                                    'ranked_completion_request_conflict',
                                    'This Ranked debate was already completed by a different request.',
                                    {
                                        status: 409,
                                        retryable: false,
                                        details: {
                                            requestId:
                                                debate
                                                    .completionRequestId,
                                        },
                                    }
                                );
                            }

                            const profile =
                                normalizeCompletionProfile(
                                    await repo
                                        .findPlacementProfileForUpdate(
                                            client,
                                            {
                                                accountId:
                                                    authorization
                                                        .accountId,
                                            }
                                        ),
                                    authorization
                                        .accountId
                                );

                            const trial =
                                normalizeCompletionTrial(
                                    await repo
                                        .findPlacementTrialForUpdate(
                                            client,
                                            {
                                                accountId:
                                                    authorization
                                                        .accountId,
                                                trialNumber:
                                                    debate
                                                        .placementTrialNumber,
                                            }
                                        ),
                                    authorization
                                        .accountId
                                );

                            if (
                                trial.status !==
                                    'completed' ||
                                trial.rankedDebateId !==
                                    debate.id
                            ) {
                                fail(
                                    'ranked_placement_state_unavailable',
                                    'The completed Ranked debate does not match its placement trial.',
                                    {
                                        status: 503,
                                        retryable: true,
                                    }
                                );
                            }

                            return Object.freeze({
                                created: false,
                                debate,
                                trial,
                                profile,
                            });
                        }

                        requireActiveDebate(
                            debate
                        );

                        requireExpectedVersion(
                            debate,
                            cleanExpectedVersion
                        );

                        if (
                            debate.debateKind !==
                                'placement'
                        ) {
                            fail(
                                'ranked_ladder_completion_not_available',
                                'Ladder completion is not available in this release.',
                                {
                                    status: 409,
                                    retryable: false,
                                }
                            );
                        }

                        if (
                            debate.startRequestId ===
                                cleanRequestId ||
                            messagesForRequest(
                                debate.messages,
                                cleanRequestId
                            ).length > 0
                        ) {
                            fail(
                                'ranked_request_id_conflict',
                                'requestId was already used for another action in this Ranked debate.',
                                {
                                    status: 409,
                                    retryable: false,
                                    details: {
                                        requestId:
                                            cleanRequestId,
                                    },
                                }
                            );
                        }

                        if (
                            !completedOpening(
                                debate.messages
                            )
                        ) {
                            fail(
                                'ranked_completion_not_ready',
                                'The Ranked opening must finish before the debate can be completed.',
                                {
                                    status: 409,
                                    retryable: false,
                                }
                            );
                        }

                        const unresolved =
                            unresolvedAssistant(
                                debate.messages
                            );

                        if (unresolved) {
                            fail(
                                unresolved.status ===
                                    'pending'
                                    ? 'ranked_generation_in_progress'
                                    : 'ranked_generation_failed',
                                unresolved.status ===
                                    'pending'
                                    ? 'The current Ranked response is still being generated.'
                                    : 'The failed Ranked response must be retried before completion.',
                                {
                                    status: 409,
                                    retryable:
                                        unresolved.status ===
                                            'pending' ||
                                        Boolean(
                                            unresolved
                                                .failureRetryable
                                        ),
                                    details: {
                                        requestId:
                                            unresolved
                                                .requestId,
                                    },
                                }
                            );
                        }

                        const completedUserTurns =
                            debate.messages.filter(
                                (message) =>
                                    message.role ===
                                        'user' &&
                                    message.kind ===
                                        'turn' &&
                                    message.status ===
                                        'completed'
                            ).length;

                        if (
                            completedUserTurns <
                            MIN_COMPLETION_USER_TURNS
                        ) {
                            fail(
                                'ranked_completion_not_ready',
                                `At least ${MIN_COMPLETION_USER_TURNS} completed user responses are required.`,
                                {
                                    status: 409,
                                    retryable: false,
                                    details: {
                                        minimumUserTurns:
                                            MIN_COMPLETION_USER_TURNS,
                                        currentUserTurns:
                                            completedUserTurns,
                                    },
                                }
                            );
                        }

                        const score =
                            calculateFinalScore(
                                debate.messages
                            );

                        const profileBefore =
                            normalizeCompletionProfile(
                                await repo
                                    .findPlacementProfileForUpdate(
                                        client,
                                        {
                                            accountId:
                                                authorization
                                                    .accountId,
                                        }
                                    ),
                                authorization
                                    .accountId
                            );

                        const trialBefore =
                            normalizeCompletionTrial(
                                await repo
                                    .findPlacementTrialForUpdate(
                                        client,
                                        {
                                            accountId:
                                                authorization
                                                    .accountId,
                                            trialNumber:
                                                debate
                                                    .placementTrialNumber,
                                        }
                                    ),
                                authorization
                                    .accountId
                            );

                        const expectedCompletedTrials =
                            debate
                                .placementTrialNumber -
                            1;

                        if (
                            profileBefore
                                .placementStatus !==
                                'in_progress' ||
                            profileBefore
                                .placementTrialsCompleted !==
                                expectedCompletedTrials
                        ) {
                            fail(
                                'ranked_placement_state_conflict',
                                'The Ranked profile changed before this placement could be completed.',
                                {
                                    status: 409,
                                    retryable: true,
                                }
                            );
                        }

                        if (
                            trialBefore.status !==
                                'active' ||
                            trialBefore
                                .rankedDebateId !==
                                debate.id ||
                            trialBefore
                                .trialNumber !==
                                debate
                                    .placementTrialNumber ||
                            trialBefore
                                .requiredMode !==
                                debate.debateMode ||
                            trialBefore
                                .philosopherId !==
                                debate.philosopherId ||
                            trialBefore
                                .philosopherName !==
                                debate.philosopherName ||
                            trialBefore
                                .topicFingerprint !==
                                debate.topicFingerprint
                        ) {
                            fail(
                                'ranked_placement_state_conflict',
                                'The active placement trial no longer matches this Ranked debate.',
                                {
                                    status: 409,
                                    retryable: true,
                                }
                            );
                        }

                        const weightedScoreContribution =
                            roundDecimal(
                                score
                                    .finalScoreValue *
                                trialBefore
                                    .weightBasisPoints /
                                10_000,
                                4
                            );

                        const completedDebateRow =
                            await repo
                                .completePlacementDebate(
                                    client,
                                    {
                                        accountId:
                                            authorization
                                                .accountId,
                                        debateId:
                                            debate.id,
                                        expectedStateVersion:
                                            debate
                                                .stateVersion,
                                        requestId:
                                            cleanRequestId,
                                        finalScoreText:
                                            score
                                                .finalScoreText,
                                        finalScoreValue:
                                            score
                                                .finalScoreValue,
                                        installationId:
                                            authorization
                                                .installationId,
                                        completedAt,
                                    }
                                );

                        if (!completedDebateRow) {
                            fail(
                                'ranked_state_conflict',
                                'The Ranked debate changed before completion was applied.',
                                {
                                    status: 409,
                                    retryable: true,
                                    details: {
                                        expectedStateVersion:
                                            cleanExpectedVersion,
                                    },
                                }
                            );
                        }

                        const completedDebate =
                            normalizeDebate(
                                completedDebateRow,
                                authorization
                                    .accountId
                            );

                        const completedTrialRow =
                            await repo
                                .completePlacementTrial(
                                    client,
                                    {
                                        accountId:
                                            authorization
                                                .accountId,
                                        trialNumber:
                                            trialBefore
                                                .trialNumber,
                                        debateId:
                                            debate.id,
                                        finalScoreValue:
                                            score
                                                .finalScoreValue,
                                        weightedScoreContribution,
                                        completedAt,
                                    }
                                );

                        if (!completedTrialRow) {
                            fail(
                                'ranked_placement_state_conflict',
                                'The Ranked placement trial changed before completion was applied.',
                                {
                                    status: 409,
                                    retryable: true,
                                }
                            );
                        }

                        const completedTrial =
                            normalizeCompletionTrial(
                                completedTrialRow,
                                authorization
                                    .accountId
                            );

                        const summary =
                            normalizeCompletionSummary(
                                await repo
                                    .loadPlacementCompletionSummary(
                                        client,
                                        {
                                            accountId:
                                                authorization
                                                    .accountId,
                                        }
                                    )
                            );

                        if (
                            summary.completedTrials !==
                            trialBefore.trialNumber
                        ) {
                            fail(
                                'ranked_placement_state_conflict',
                                'The completed placement count is inconsistent.',
                                {
                                    status: 409,
                                    retryable: true,
                                }
                            );
                        }

                        const placementCompleted =
                            summary.completedTrials ===
                            PLACEMENT_TRIALS_REQUIRED;

                        const placementWeightedScore =
                            placementCompleted
                                ? roundDecimal(
                                    summary
                                        .weightedScore,
                                    4
                                )
                                : null;

                        const placement =
                            placementCompleted
                                ? placementForScore(
                                    placementWeightedScore
                                )
                                : null;

                        const profileAfterRow =
                            await repo
                                .updatePlacementProfile(
                                    client,
                                    {
                                        accountId:
                                            authorization
                                                .accountId,
                                        expectedStateVersion:
                                            profileBefore
                                                .stateVersion,
                                        placementStatus:
                                            placementCompleted
                                                ? 'completed'
                                                : 'in_progress',
                                        placementTrialsCompleted:
                                            summary
                                                .completedTrials,
                                        placementWeightedScore,
                                        rankKey:
                                            placement
                                                ?.rankKey ??
                                            null,
                                        division:
                                            placement
                                                ?.division ??
                                            null,
                                        rp:
                                            placement
                                                ?.rp ??
                                            null,
                                        completedAt,
                                        incrementRankedDebatesCompleted:
                                            true,
                                    }
                                );

                        if (!profileAfterRow) {
                            fail(
                                'ranked_placement_state_conflict',
                                'The Ranked profile changed before completion was applied.',
                                {
                                    status: 409,
                                    retryable: true,
                                }
                            );
                        }

                        const profileAfter =
                            normalizeCompletionProfile(
                                profileAfterRow,
                                authorization
                                    .accountId
                            );

                        await repo
                            .insertPlacementTrialEvent(
                                client,
                                {
                                    accountId:
                                        authorization
                                            .accountId,
                                    debate:
                                        completedDebate,
                                    trial:
                                        completedTrial,
                                    finalScoreValue:
                                        score
                                            .finalScoreValue,
                                    weightedScoreContribution,
                                    occurredAt:
                                        completedAt,
                                }
                            );

                        if (
                            placementCompleted
                        ) {
                            await repo
                                .insertPlacementCompletedEvent(
                                    client,
                                    {
                                        accountId:
                                            authorization
                                                .accountId,
                                        debate:
                                            completedDebate,
                                        placementWeightedScore,
                                        placement,
                                        occurredAt:
                                            completedAt,
                                    }
                                );
                        }

                        return Object.freeze({
                            created: true,
                            debate:
                                completedDebate,
                            trial:
                                completedTrial,
                            profile:
                                profileAfter,
                        });
                    }
                );
        } catch (error) {
            if (
                error instanceof
                AccountRankedDebateError
            ) {
                throw error;
            }

            const mapped =
                mapCompletionPersistenceError(
                    error
                );

            if (mapped) {
                throw mapped;
            }

            fail(
                'ranked_completion_persistence_failed',
                'The Ranked debate completion could not be saved.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }

        return Object.freeze({
            schemaVersion:
                RANKED_DEBATE_SCHEMA_VERSION,
            accountId:
                authorization.accountId,
            installationId:
                authorization
                    .installationId,
            requestId:
                cleanRequestId,
            created:
                result.created,
            debate:
                publicDebate(
                    result.debate
                ),
            completion:
                placementCompletionPayload({
                    debate:
                        result.debate,
                    trial:
                        result.trial,
                    profile:
                        result.profile,
                }),
        });
    }



    async function forfeitDebate({
        installationId,
        accessToken,
        debateId,
        requestId,
        expectedStateVersion,
    }) {
        const authorization =
            await authorize({
                installationId,
                accessToken,
            });

        await requirePro(
            authorization.accountId
        );

        requireForfeitRepository();

        const cleanDebateId =
            requireUuid(
                debateId,
                'debateId'
            );

        const cleanRequestId =
            requireUuid(
                requestId,
                'requestId'
            );

        const cleanExpectedVersion =
            requireStateVersion(
                expectedStateVersion
            );

        const forfeitedAt =
            serviceDate(now);

        let result;

        try {
            result =
                await repo.withTransaction(
                    async (client) => {
                        const configuration =
                            normalizeConfiguration(
                                await repo
                                    .loadConfiguration(
                                        client
                                    )
                            );

                        requireContinuationEnabled(
                            configuration
                        );

                        const debate =
                            await loadLockedDebate({
                                client,
                                accountId:
                                    authorization
                                        .accountId,
                                debateId:
                                    cleanDebateId,
                            });

                        if (
                            debate.status ===
                                'forfeited'
                        ) {
                            if (
                                debate
                                    .forfeitRequestId !==
                                cleanRequestId
                            ) {
                                fail(
                                    'ranked_forfeit_request_conflict',
                                    'This Ranked debate was already forfeited by a different request.',
                                    {
                                        status: 409,
                                        retryable: false,
                                        details: {
                                            requestId:
                                                debate
                                                    .forfeitRequestId,
                                        },
                                    }
                                );
                            }

                            const profile =
                                normalizeCompletionProfile(
                                    await repo
                                        .findPlacementProfileForUpdate(
                                            client,
                                            {
                                                accountId:
                                                    authorization
                                                        .accountId,
                                            }
                                        ),
                                    authorization
                                        .accountId
                                );

                            const trial =
                                normalizeCompletionTrial(
                                    await repo
                                        .findPlacementTrialForUpdate(
                                            client,
                                            {
                                                accountId:
                                                    authorization
                                                        .accountId,
                                                trialNumber:
                                                    debate
                                                        .placementTrialNumber,
                                            }
                                        ),
                                    authorization
                                        .accountId
                                );

                            if (
                                trial.status !==
                                    'forfeited' ||
                                trial.rankedDebateId !==
                                    debate.id ||
                                trial.finalScoreValue !==
                                    0 ||
                                trial.weightedScoreContribution !==
                                    0
                            ) {
                                fail(
                                    'ranked_placement_state_unavailable',
                                    'The forfeited Ranked debate does not match its placement trial.',
                                    {
                                        status: 503,
                                        retryable: true,
                                    }
                                );
                            }

                            return Object.freeze({
                                created: false,
                                debate,
                                trial,
                                profile,
                            });
                        }

                        if (
                            debate.status ===
                                'completed'
                        ) {
                            fail(
                                'ranked_debate_already_completed',
                                'This Ranked debate has already been completed and cannot be forfeited.',
                                {
                                    status: 409,
                                    retryable: false,
                                }
                            );
                        }

                        requireActiveDebate(
                            debate
                        );

                        requireExpectedVersion(
                            debate,
                            cleanExpectedVersion
                        );

                        if (
                            debate.debateKind !==
                                'placement'
                        ) {
                            fail(
                                'ranked_ladder_forfeit_not_available',
                                'Ladder forfeits are not available in this release.',
                                {
                                    status: 409,
                                    retryable: false,
                                }
                            );
                        }

                        if (
                            debate.startRequestId ===
                                cleanRequestId ||
                            messagesForRequest(
                                debate.messages,
                                cleanRequestId
                            ).length > 0
                        ) {
                            fail(
                                'ranked_request_id_conflict',
                                'requestId was already used for another action in this Ranked debate.',
                                {
                                    status: 409,
                                    retryable: false,
                                    details: {
                                        requestId:
                                            cleanRequestId,
                                    },
                                }
                            );
                        }

                        const profileBefore =
                            normalizeCompletionProfile(
                                await repo
                                    .findPlacementProfileForUpdate(
                                        client,
                                        {
                                            accountId:
                                                authorization
                                                    .accountId,
                                        }
                                    ),
                                authorization
                                    .accountId
                            );

                        const trialBefore =
                            normalizeCompletionTrial(
                                await repo
                                    .findPlacementTrialForUpdate(
                                        client,
                                        {
                                            accountId:
                                                authorization
                                                    .accountId,
                                            trialNumber:
                                                debate
                                                    .placementTrialNumber,
                                        }
                                    ),
                                authorization
                                    .accountId
                            );

                        const expectedCompletedTrials =
                            debate
                                .placementTrialNumber -
                            1;

                        if (
                            profileBefore
                                .placementStatus !==
                                'in_progress' ||
                            profileBefore
                                .placementTrialsCompleted !==
                                expectedCompletedTrials
                        ) {
                            fail(
                                'ranked_placement_state_conflict',
                                'The Ranked profile changed before this placement could be forfeited.',
                                {
                                    status: 409,
                                    retryable: true,
                                }
                            );
                        }

                        if (
                            trialBefore.status !==
                                'active' ||
                            trialBefore
                                .rankedDebateId !==
                                debate.id ||
                            trialBefore
                                .trialNumber !==
                                debate
                                    .placementTrialNumber ||
                            trialBefore
                                .requiredMode !==
                                debate.debateMode ||
                            trialBefore
                                .philosopherId !==
                                debate.philosopherId ||
                            trialBefore
                                .philosopherName !==
                                debate.philosopherName ||
                            trialBefore
                                .topicFingerprint !==
                                debate.topicFingerprint
                        ) {
                            fail(
                                'ranked_placement_state_conflict',
                                'The active placement trial no longer matches this Ranked debate.',
                                {
                                    status: 409,
                                    retryable: true,
                                }
                            );
                        }

                        const forfeitedDebateRow =
                            await repo
                                .forfeitPlacementDebate(
                                    client,
                                    {
                                        accountId:
                                            authorization
                                                .accountId,
                                        debateId:
                                            debate.id,
                                        expectedStateVersion:
                                            debate
                                                .stateVersion,
                                        requestId:
                                            cleanRequestId,
                                        installationId:
                                            authorization
                                                .installationId,
                                        forfeitedAt,
                                    }
                                );

                        if (!forfeitedDebateRow) {
                            fail(
                                'ranked_state_conflict',
                                'The Ranked debate changed before the forfeit was applied.',
                                {
                                    status: 409,
                                    retryable: true,
                                    details: {
                                        expectedStateVersion:
                                            cleanExpectedVersion,
                                    },
                                }
                            );
                        }

                        const forfeitedDebate =
                            normalizeDebate(
                                forfeitedDebateRow,
                                authorization
                                    .accountId
                            );

                        const forfeitedTrialRow =
                            await repo
                                .forfeitPlacementTrial(
                                    client,
                                    {
                                        accountId:
                                            authorization
                                                .accountId,
                                        trialNumber:
                                            trialBefore
                                                .trialNumber,
                                        debateId:
                                            debate.id,
                                        forfeitedAt,
                                    }
                                );

                        if (!forfeitedTrialRow) {
                            fail(
                                'ranked_placement_state_conflict',
                                'The Ranked placement trial changed before the forfeit was applied.',
                                {
                                    status: 409,
                                    retryable: true,
                                }
                            );
                        }

                        const forfeitedTrial =
                            normalizeCompletionTrial(
                                forfeitedTrialRow,
                                authorization
                                    .accountId
                            );

                        const summary =
                            normalizeCompletionSummary(
                                await repo
                                    .loadPlacementCompletionSummary(
                                        client,
                                        {
                                            accountId:
                                                authorization
                                                    .accountId,
                                        }
                                    )
                            );

                        if (
                            summary.completedTrials !==
                            trialBefore.trialNumber
                        ) {
                            fail(
                                'ranked_placement_state_conflict',
                                'The resolved placement count is inconsistent.',
                                {
                                    status: 409,
                                    retryable: true,
                                }
                            );
                        }

                        const placementCompleted =
                            summary.completedTrials ===
                            PLACEMENT_TRIALS_REQUIRED;

                        const placementWeightedScore =
                            placementCompleted
                                ? roundDecimal(
                                    summary
                                        .weightedScore,
                                    4
                                )
                                : null;

                        const placement =
                            placementCompleted
                                ? placementForScore(
                                    placementWeightedScore
                                )
                                : null;

                        const profileAfterRow =
                            await repo
                                .updatePlacementProfile(
                                    client,
                                    {
                                        accountId:
                                            authorization
                                                .accountId,
                                        expectedStateVersion:
                                            profileBefore
                                                .stateVersion,
                                        placementStatus:
                                            placementCompleted
                                                ? 'completed'
                                                : 'in_progress',
                                        placementTrialsCompleted:
                                            summary
                                                .completedTrials,
                                        placementWeightedScore,
                                        rankKey:
                                            placement
                                                ?.rankKey ??
                                            null,
                                        division:
                                            placement
                                                ?.division ??
                                            null,
                                        rp:
                                            placement
                                                ?.rp ??
                                            null,
                                        completedAt:
                                            forfeitedAt,
                                        incrementRankedDebatesCompleted:
                                            false,
                                    }
                                );

                        if (!profileAfterRow) {
                            fail(
                                'ranked_placement_state_conflict',
                                'The Ranked profile changed before the forfeit was applied.',
                                {
                                    status: 409,
                                    retryable: true,
                                }
                            );
                        }

                        const profileAfter =
                            normalizeCompletionProfile(
                                profileAfterRow,
                                authorization
                                    .accountId
                            );

                        await repo
                            .insertPlacementTrialEvent(
                                client,
                                {
                                    accountId:
                                        authorization
                                            .accountId,
                                    debate:
                                        forfeitedDebate,
                                    trial:
                                        forfeitedTrial,
                                    finalScoreValue: 0,
                                    weightedScoreContribution:
                                        0,
                                    occurredAt:
                                        forfeitedAt,
                                    forfeited: true,
                                }
                            );

                        if (
                            placementCompleted
                        ) {
                            await repo
                                .insertPlacementCompletedEvent(
                                    client,
                                    {
                                        accountId:
                                            authorization
                                                .accountId,
                                        debate:
                                            forfeitedDebate,
                                        placementWeightedScore,
                                        placement,
                                        occurredAt:
                                            forfeitedAt,
                                    }
                                );
                        }

                        return Object.freeze({
                            created: true,
                            debate:
                                forfeitedDebate,
                            trial:
                                forfeitedTrial,
                            profile:
                                profileAfter,
                        });
                    }
                );
        } catch (error) {
            if (
                error instanceof
                AccountRankedDebateError
            ) {
                throw error;
            }

            const mapped =
                mapCompletionPersistenceError(
                    error
                );

            if (mapped) {
                throw mapped;
            }

            fail(
                'ranked_forfeit_persistence_failed',
                'The Ranked debate forfeit could not be saved.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }

        return Object.freeze({
            schemaVersion:
                RANKED_DEBATE_SCHEMA_VERSION,
            accountId:
                authorization.accountId,
            installationId:
                authorization
                    .installationId,
            requestId:
                cleanRequestId,
            created:
                result.created,
            debate:
                publicDebate(
                    result.debate
                ),
            completion:
                placementCompletionPayload({
                    debate:
                        result.debate,
                    trial:
                        result.trial,
                    profile:
                        result.profile,
                }),
        });
    }

    return Object.freeze({
        resumeActiveDebate,
        generateOpening,
        submitTurn,
        completeDebate,
        forfeitDebate,
    });
}

export const accountRankedDebateConstants =
    Object.freeze({
        schemaVersion:
            RANKED_DEBATE_SCHEMA_VERSION,
        storedMessageSchemaVersion:
            STORED_MESSAGE_SCHEMA_VERSION,
        generationLeaseMs:
            GENERATION_LEASE_MS,
        maxUserMessageLength:
            MAX_USER_MESSAGE_LENGTH,
        maxAssistantMessageLength:
            MAX_ASSISTANT_MESSAGE_LENGTH,
        maxScoreTextLength:
            MAX_SCORE_TEXT_LENGTH,
        maxMessages:
            MAX_MESSAGES,
        maxRounds:
            MAX_ROUNDS,
        maxStoredMessagesJsonBytes:
            MAX_STORED_MESSAGES_JSON_BYTES,
        placementTrialsRequired:
            PLACEMENT_TRIALS_REQUIRED,
        minimumCompletionUserTurns:
            MIN_COMPLETION_USER_TURNS,
    });
