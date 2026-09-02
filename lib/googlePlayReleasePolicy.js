function normalizedBoolean(value, defaultValue) {
    if (
        value == null ||
        String(value).trim() === ''
    ) {
        return defaultValue;
    }

    switch (
        String(value)
            .trim()
            .toLowerCase()
    ) {
        case 'true':
        case '1':
        case 'yes':
        case 'on':
            return true;

        case 'false':
        case '0':
        case 'no':
        case 'off':
            return false;

        default:
            return null;
    }
}

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
    const rankedRequiresPro =
        normalizedBoolean(
            environment?.RANKED_REQUIRE_PRO,
            true
        );

    return Object.freeze({
        rankedProEnforced:
            rankedRequiresPro === true,
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
                'RANKED_REQUIRE_PRO',
                'EXPANDED_AGORA_TEST_PRO_USER_IDS',
            ]),
    });
