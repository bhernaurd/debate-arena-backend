const IOS_VERSION_RE = /^\d+(?:\.\d+){0,3}$/;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;

function hasValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}

export function parseOptionalIosVersion(value) {
    if (!hasValue(value) || typeof value !== 'string') {
        return null;
    }

    const cleaned = value.trim();

    if (!IOS_VERSION_RE.test(cleaned)) {
        return null;
    }

    const parts = cleaned.split('.').map((component) => Number(component));

    if (
        parts.some(
            (component) =>
                !Number.isSafeInteger(component) || component < 0
        )
    ) {
        return null;
    }

    while (parts.length > 1 && parts[parts.length - 1] === 0) {
        parts.pop();
    }

    return {
        raw: cleaned,
        normalized: parts.join('.'),
        parts,
    };
}

export function parseOptionalPositiveInteger(value) {
    if (!hasValue(value)) {
        return null;
    }

    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value > 0
            ? value
            : null;
    }

    if (typeof value !== 'string') {
        return null;
    }

    const cleaned = value.trim();

    if (!POSITIVE_INTEGER_RE.test(cleaned)) {
        return null;
    }

    const parsed = Number(cleaned);

    return Number.isSafeInteger(parsed) && parsed > 0
        ? parsed
        : null;
}

export function compareIosVersions(leftVersion, rightVersion) {
    const left = parseOptionalIosVersion(leftVersion);
    const right = parseOptionalIosVersion(rightVersion);

    if (!left || !right) {
        return null;
    }

    const componentCount = Math.max(
        left.parts.length,
        right.parts.length
    );

    for (let index = 0; index < componentCount; index += 1) {
        const leftComponent = left.parts[index] ?? 0;
        const rightComponent = right.parts[index] ?? 0;

        if (leftComponent > rightComponent) {
            return 1;
        }

        if (leftComponent < rightComponent) {
            return -1;
        }
    }

    return 0;
}

function compatibilityResult({
    satisfied,
    reason,
    comparisonMode,
    clientVersion,
    clientBuild,
    minimumVersion,
    minimumBuild,
    minimumLegacyBuild,
}) {
    return {
        satisfied,
        reason,
        comparisonMode,
        clientVersion,
        clientBuild,
        minimumVersion,
        minimumBuild,
        minimumLegacyBuild,
    };
}

export function evaluateMinimumIosClient({
    clientVersion = null,
    clientBuild = null,
    minimumVersion = null,
    minimumBuild = null,
    minimumLegacyBuild = null,
} = {}) {
    const minimumVersionProvided = hasValue(minimumVersion);
    const minimumBuildProvided = hasValue(minimumBuild);
    const minimumLegacyBuildProvided = hasValue(minimumLegacyBuild);

    const parsedMinimumVersion = parseOptionalIosVersion(minimumVersion);
    const parsedMinimumBuild = parseOptionalPositiveInteger(minimumBuild);
    const parsedMinimumLegacyBuild = parseOptionalPositiveInteger(
        minimumLegacyBuild
    );

    if (
        (minimumVersionProvided && !parsedMinimumVersion) ||
        (minimumBuildProvided && !parsedMinimumBuild) ||
        (minimumLegacyBuildProvided && !parsedMinimumLegacyBuild) ||
        (!parsedMinimumVersion && parsedMinimumLegacyBuild)
    ) {
        return compatibilityResult({
            satisfied: false,
            reason: 'invalid_minimum_configuration',
            comparisonMode: 'configuration',
            clientVersion: null,
            clientBuild: null,
            minimumVersion: parsedMinimumVersion?.normalized ?? null,
            minimumBuild: parsedMinimumBuild,
            minimumLegacyBuild: parsedMinimumLegacyBuild,
        });
    }

    if (!parsedMinimumVersion && !parsedMinimumBuild) {
        return compatibilityResult({
            satisfied: true,
            reason: 'no_minimum_requirement',
            comparisonMode: 'none',
            clientVersion: null,
            clientBuild: null,
            minimumVersion: null,
            minimumBuild: null,
            minimumLegacyBuild: null,
        });
    }

    const clientVersionProvided = hasValue(clientVersion);
    const clientBuildProvided = hasValue(clientBuild);
    const parsedClientVersion = parseOptionalIosVersion(clientVersion);
    const parsedClientBuild = parseOptionalPositiveInteger(clientBuild);

    if (clientVersionProvided && !parsedClientVersion) {
        return compatibilityResult({
            satisfied: false,
            reason: 'invalid_client_version',
            comparisonMode: 'version',
            clientVersion: null,
            clientBuild: parsedClientBuild,
            minimumVersion: parsedMinimumVersion?.normalized ?? null,
            minimumBuild: parsedMinimumBuild,
            minimumLegacyBuild: parsedMinimumLegacyBuild,
        });
    }

    if (clientBuildProvided && !parsedClientBuild) {
        return compatibilityResult({
            satisfied: false,
            reason: 'invalid_client_build',
            comparisonMode: parsedMinimumVersion
                ? 'version_and_build'
                : 'legacy_build_only',
            clientVersion: parsedClientVersion?.normalized ?? null,
            clientBuild: null,
            minimumVersion: parsedMinimumVersion?.normalized ?? null,
            minimumBuild: parsedMinimumBuild,
            minimumLegacyBuild: parsedMinimumLegacyBuild,
        });
    }

    if (!parsedMinimumVersion) {
        if (!clientBuildProvided) {
            return compatibilityResult({
                satisfied: false,
                reason: 'missing_client_build',
                comparisonMode: 'legacy_build_only',
                clientVersion: parsedClientVersion?.normalized ?? null,
                clientBuild: null,
                minimumVersion: null,
                minimumBuild: parsedMinimumBuild,
                minimumLegacyBuild: null,
            });
        }

        if (!parsedClientBuild) {
            return compatibilityResult({
                satisfied: false,
                reason: 'invalid_client_build',
                comparisonMode: 'legacy_build_only',
                clientVersion: parsedClientVersion?.normalized ?? null,
                clientBuild: null,
                minimumVersion: null,
                minimumBuild: parsedMinimumBuild,
                minimumLegacyBuild: null,
            });
        }

        return compatibilityResult({
            satisfied: parsedClientBuild >= parsedMinimumBuild,
            reason:
                parsedClientBuild >= parsedMinimumBuild
                    ? 'legacy_build_satisfied'
                    : 'legacy_build_too_old',
            comparisonMode: 'legacy_build_only',
            clientVersion: parsedClientVersion?.normalized ?? null,
            clientBuild: parsedClientBuild,
            minimumVersion: null,
            minimumBuild: parsedMinimumBuild,
            minimumLegacyBuild: null,
        });
    }

    if (!clientVersionProvided) {
        if (!parsedMinimumLegacyBuild) {
            return compatibilityResult({
                satisfied: false,
                reason: 'legacy_client_not_supported',
                comparisonMode: 'legacy_build',
                clientVersion: null,
                clientBuild: parsedClientBuild,
                minimumVersion: parsedMinimumVersion.normalized,
                minimumBuild: parsedMinimumBuild,
                minimumLegacyBuild: null,
            });
        }

        if (!clientBuildProvided) {
            return compatibilityResult({
                satisfied: false,
                reason: 'missing_client_build',
                comparisonMode: 'legacy_build',
                clientVersion: null,
                clientBuild: null,
                minimumVersion: parsedMinimumVersion.normalized,
                minimumBuild: parsedMinimumBuild,
                minimumLegacyBuild: parsedMinimumLegacyBuild,
            });
        }

        if (!parsedClientBuild) {
            return compatibilityResult({
                satisfied: false,
                reason: 'invalid_client_build',
                comparisonMode: 'legacy_build',
                clientVersion: null,
                clientBuild: null,
                minimumVersion: parsedMinimumVersion.normalized,
                minimumBuild: parsedMinimumBuild,
                minimumLegacyBuild: parsedMinimumLegacyBuild,
            });
        }

        return compatibilityResult({
            satisfied: parsedClientBuild >= parsedMinimumLegacyBuild,
            reason:
                parsedClientBuild >= parsedMinimumLegacyBuild
                    ? 'legacy_build_satisfied'
                    : 'legacy_build_too_old',
            comparisonMode: 'legacy_build',
            clientVersion: null,
            clientBuild: parsedClientBuild,
            minimumVersion: parsedMinimumVersion.normalized,
            minimumBuild: parsedMinimumBuild,
            minimumLegacyBuild: parsedMinimumLegacyBuild,
        });
    }

    const versionComparison = compareIosVersions(
        parsedClientVersion.normalized,
        parsedMinimumVersion.normalized
    );

    if (versionComparison > 0) {
        return compatibilityResult({
            satisfied: true,
            reason: 'client_version_newer',
            comparisonMode: 'version',
            clientVersion: parsedClientVersion.normalized,
            clientBuild: parsedClientBuild,
            minimumVersion: parsedMinimumVersion.normalized,
            minimumBuild: parsedMinimumBuild,
            minimumLegacyBuild: parsedMinimumLegacyBuild,
        });
    }

    if (versionComparison < 0) {
        return compatibilityResult({
            satisfied: false,
            reason: 'client_version_too_old',
            comparisonMode: 'version',
            clientVersion: parsedClientVersion.normalized,
            clientBuild: parsedClientBuild,
            minimumVersion: parsedMinimumVersion.normalized,
            minimumBuild: parsedMinimumBuild,
            minimumLegacyBuild: parsedMinimumLegacyBuild,
        });
    }

    if (!parsedMinimumBuild) {
        return compatibilityResult({
            satisfied: true,
            reason: 'client_version_satisfied',
            comparisonMode: 'version',
            clientVersion: parsedClientVersion.normalized,
            clientBuild: parsedClientBuild,
            minimumVersion: parsedMinimumVersion.normalized,
            minimumBuild: null,
            minimumLegacyBuild: parsedMinimumLegacyBuild,
        });
    }

    if (!clientBuildProvided) {
        return compatibilityResult({
            satisfied: false,
            reason: 'missing_client_build',
            comparisonMode: 'version_and_build',
            clientVersion: parsedClientVersion.normalized,
            clientBuild: null,
            minimumVersion: parsedMinimumVersion.normalized,
            minimumBuild: parsedMinimumBuild,
            minimumLegacyBuild: parsedMinimumLegacyBuild,
        });
    }

    if (!parsedClientBuild) {
        return compatibilityResult({
            satisfied: false,
            reason: 'invalid_client_build',
            comparisonMode: 'version_and_build',
            clientVersion: parsedClientVersion.normalized,
            clientBuild: null,
            minimumVersion: parsedMinimumVersion.normalized,
            minimumBuild: parsedMinimumBuild,
            minimumLegacyBuild: parsedMinimumLegacyBuild,
        });
    }

    return compatibilityResult({
        satisfied: parsedClientBuild >= parsedMinimumBuild,
        reason:
            parsedClientBuild >= parsedMinimumBuild
                ? 'client_build_satisfied'
                : 'client_build_too_old',
        comparisonMode: 'version_and_build',
        clientVersion: parsedClientVersion.normalized,
        clientBuild: parsedClientBuild,
        minimumVersion: parsedMinimumVersion.normalized,
        minimumBuild: parsedMinimumBuild,
        minimumLegacyBuild: parsedMinimumLegacyBuild,
    });
}
