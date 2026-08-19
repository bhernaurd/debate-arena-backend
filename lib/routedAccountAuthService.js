function tokenAudiences(identityToken) {
    if (typeof identityToken !== 'string') return [];

    const parts = identityToken.trim().split('.');
    if (parts.length !== 3) return [];

    try {
        const payload = JSON.parse(
            Buffer.from(parts[1], 'base64url').toString('utf8')
        );
        const audience = payload?.aud;
        if (typeof audience === 'string') return [audience];
        if (Array.isArray(audience)) {
            return audience.filter((value) => typeof value === 'string');
        }
    } catch {
        // Audience parsing is only a routing hint. The selected service still
        // performs the authoritative Apple signature/audience verification.
    }

    return [];
}

/**
 * Routes only Apple-credential operations between the native App ID and the
 * web Services ID. All Agora session/token operations are platform-neutral and
 * stay on the native service because both services share the same repository
 * and account-crypto configuration.
 */
export function createRoutedAccountAuthService({
    nativeService,
    webService = null,
    webClientId = null,
}) {
    if (!nativeService) {
        throw new Error('nativeService is required.');
    }

    const chooseAppleService = (identityToken) => {
        if (
            webService &&
            typeof webClientId === 'string' &&
            webClientId.trim() &&
            tokenAudiences(identityToken).includes(webClientId.trim())
        ) {
            return webService;
        }

        return nativeService;
    };

    return Object.freeze({
        createAppleChallenge: (...args) =>
            nativeService.createAppleChallenge(...args),

        signInWithApple: (input) =>
            chooseAppleService(input?.identityToken)
                .signInWithApple(input),

        refreshSession: (...args) =>
            nativeService.refreshSession(...args),

        authorizeAccessToken: (...args) =>
            nativeService.authorizeAccessToken(...args),

        deleteAccount: (input) =>
            chooseAppleService(input?.identityToken)
                .deleteAccount(input),

        decryptStoredAppleRefreshToken: (...args) =>
            nativeService.decryptStoredAppleRefreshToken(...args),
    });
}
