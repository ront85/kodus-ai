import axios from 'axios';
import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { createLogger } from '@kodus/flow';

const logger = createLogger('AnthropicTokenRefresh');

const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/api/oauth/token';
const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export interface AnthropicRefreshResult {
    accessToken: string;
    encryptedAccessToken: string;
    tokenExpiresAt: number;
}

/**
 * Refreshes an Anthropic OAuth access token using a refresh token.
 *
 * @param encryptedRefreshToken - The encrypted refresh token (sk-ant-ort01-*)
 * @returns New access token (decrypted + encrypted) and expiry timestamp
 */
export async function refreshAnthropicAccessToken(
    encryptedRefreshToken: string,
): Promise<AnthropicRefreshResult> {
    const refreshToken = decrypt(encryptedRefreshToken);

    const response = await axios.post(ANTHROPIC_TOKEN_URL, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    });

    const { access_token, expires_in } = response.data;

    if (!access_token) {
        throw new Error('Anthropic token refresh returned no access_token');
    }

    const tokenExpiresAt = Date.now() + (expires_in ?? 28800) * 1000;

    logger.log({
        message: 'Anthropic OAuth token refreshed successfully',
        metadata: {
            expiresIn: expires_in,
            tokenExpiresAt: new Date(tokenExpiresAt).toISOString(),
        },
    });

    return {
        accessToken: access_token,
        encryptedAccessToken: encrypt(access_token),
        tokenExpiresAt,
    };
}
