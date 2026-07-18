import axios from 'axios';
import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { createLogger } from '@libs/core/log/logger';

const logger = createLogger('OpenAITokenRefresh');

// OpenAI / ChatGPT (Codex CLI) OAuth. The client_id is the public client id
// embedded in every codex auth.json access_token (claim `client_id`), and the
// issuer (`iss`) is auth.openai.com — so the refresh is a standard OAuth2
// refresh_token grant against its token endpoint.
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export interface OpenAIRefreshResult {
    accessToken: string;
    encryptedAccessToken: string;
    /**
     * OpenAI ROTATES the refresh token on every refresh — the old one is
     * invalidated. The caller MUST persist this new encrypted refresh token,
     * or the next refresh will fail.
     */
    encryptedRefreshToken: string;
    tokenExpiresAt: number;
}

/**
 * Refreshes an OpenAI/Codex (ChatGPT subscription) OAuth access token using a
 * refresh token. Mirrors `refreshAnthropicAccessToken`, but returns the
 * rotated refresh token so the caller can persist it.
 *
 * @param encryptedRefreshToken - The encrypted OAuth refresh token
 * @returns New access token + rotated refresh token (both encrypted) and expiry
 */
export async function refreshOpenAIAccessToken(
    encryptedRefreshToken: string,
): Promise<OpenAIRefreshResult> {
    const refreshToken = decrypt(encryptedRefreshToken);

    const response = await axios.post(
        OPENAI_TOKEN_URL,
        {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: OPENAI_OAUTH_CLIENT_ID,
        },
        { headers: { 'Content-Type': 'application/json' } },
    );

    const {
        access_token,
        refresh_token: newRefreshToken,
        expires_in,
    } = response.data;

    if (!access_token) {
        throw new Error('OpenAI token refresh returned no access_token');
    }

    // Default to 10 days (864000s) — the observed Codex token lifetime — when
    // the response omits expires_in.
    const tokenExpiresAt = Date.now() + (expires_in ?? 864000) * 1000;

    logger.log({
        message: 'OpenAI/Codex OAuth token refreshed successfully',
        context: 'OpenAITokenRefresh',
        metadata: {
            expiresIn: expires_in,
            tokenExpiresAt: new Date(tokenExpiresAt).toISOString(),
            rotatedRefreshToken: !!newRefreshToken,
        },
    });

    return {
        accessToken: access_token,
        encryptedAccessToken: encrypt(access_token),
        // If the provider didn't rotate (it normally does), keep the existing one.
        encryptedRefreshToken: newRefreshToken
            ? encrypt(newRefreshToken)
            : encryptedRefreshToken,
        tokenExpiresAt,
    };
}
