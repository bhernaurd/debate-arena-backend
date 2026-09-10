function hasNonEmptyCsvEntry(value) {
    return String(value ?? '')
        .split(',')
        .some(
            (entry) =>
                entry.trim().length > 0
        );
}

export function googlePlayProductionBypassChecks(
    environment = process.env
) {
    return Object.freeze({
        expandedAgoraTestProAllowlistDisabled:
            !hasNonEmptyCsvEntry(
                environment?.EXPANDED_AGORA_TEST_PRO_USER_IDS
            ),
    });
}

export const googlePlayReleasePolicyConstants =
    Object.freeze({
        productionBypassEnvironmentVariables:
            Object.freeze([
                'EXPANDED_AGORA_TEST_PRO_USER_IDS',
            ]),
    });
