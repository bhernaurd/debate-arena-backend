import {
    RankedDebateEngineError,
    createRankedDebateEngineService as createCoreRankedDebateEngineService,
    createRawAnthropicRankedMessage as createCoreRawAnthropicRankedMessage,
    rankedDebateEngineConstants,
} from './rankedDebateEngineCoreService.js';
import {
    applyAgoraAiSafetyPolicyToAnthropicPayload,
} from './aiSafetyPolicy.js';

function safetyWrappedProvider(provider) {
    return async function safeRankedProvider(
        payload,
        label
    ) {
        return provider(
            applyAgoraAiSafetyPolicyToAnthropicPayload(
                payload
            ),
            label
        );
    };
}

export function createRawAnthropicRankedMessage(
    options = {}
) {
    return safetyWrappedProvider(
        createCoreRawAnthropicRankedMessage(
            options
        )
    );
}

export function createRankedDebateEngineService(
    options = {}
) {
    const source =
        options &&
        typeof options === 'object' &&
        !Array.isArray(options)
            ? options
            : options;

    if (
        !source ||
        typeof source !== 'object' ||
        Array.isArray(source)
    ) {
        return createCoreRankedDebateEngineService(
            source
        );
    }

    const baseProvider =
        source.createMessage ??
        createCoreRawAnthropicRankedMessage(
            source.rawAnthropicOptions ?? {}
        );

    if (
        typeof baseProvider !== 'function'
    ) {
        return createCoreRankedDebateEngineService(
            source
        );
    }

    return createCoreRankedDebateEngineService({
        ...source,
        createMessage:
            safetyWrappedProvider(
                baseProvider
            ),
    });
}

export {
    RankedDebateEngineError,
    rankedDebateEngineConstants,
};
