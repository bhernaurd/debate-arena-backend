import { createAppleWebAuthRouter } from '../appleWebAuthRoutes.js';
import { createAccountAuthService } from './accountAuthService.js';
import { createAppleWebAuthFlow, loadAppleWebAuthFlowConfig } from './appleWebAuthFlow.js';
import { loadAppleSignInConfig } from './appleSignIn.js';
import { createCrossPlatformAccountAuthRepository } from './crossPlatformAccountAuthRepository.js';
import { createRoutedAccountAuthService } from './routedAccountAuthService.js';

/**
 * Creates one account-auth runtime shared by native iOS and Android's browser
 * Sign in with Apple flow. The Android web bridge is deliberately optional so
 * production keeps working until its dedicated Apple Services ID variables are
 * configured.
 */
export function createAccountAuthRuntime({ pool, env = process.env } = {}) {
    const repository = createCrossPlatformAccountAuthRepository(pool);

    const nativeService = createAccountAuthService({
        repository,
    });

    const webConfig = loadAppleWebAuthFlowConfig(env);
    let webService = null;
    let webFlow = null;

    if (webConfig.enabled) {
        const webAppleConfig = loadAppleSignInConfig({
            ...env,
            APPLE_SIGN_IN_CLIENT_ID: webConfig.clientId,
        });

        webService = createAccountAuthService({
            repository,
            appleConfig: webAppleConfig,
        });
        webFlow = createAppleWebAuthFlow(webConfig);
    }

    const service = createRoutedAccountAuthService({
        nativeService,
        webService,
        webClientId: webConfig.clientId,
    });

    return Object.freeze({
        service,
        appleWebAuthEnabled: webConfig.enabled,
        appleWebAuthMissingConfiguration: webConfig.missing,
        appleWebAuthRouter: createAppleWebAuthRouter({
            config: webConfig,
            flow: webFlow,
        }),
    });
}
