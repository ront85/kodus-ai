import {
    BYOKProvider,
    getModelCapabilities,
    ReasoningConfig,
} from '@kodus/kodus-common/llm';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ProviderService } from '@libs/core/infrastructure/services/providers/provider.service';
import { decrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { createLogger } from '@libs/core/log/logger';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import axios from 'axios';

import { resolveByokSlot } from './byok-credentials.util';
import { assertSafeOpenAICompatibleUrl } from './test-byok-connection.use-case';

// Interfaces for API responses
interface OpenAIModel {
    id: string;
    object: string;
    created: number;
    owned_by: string;
}

interface OpenAIResponse {
    object: string;
    data: OpenAIModel[];
}

interface AnthropicModel {
    id: string;
    display_name?: string;
    context_length: number;
    pricing: {
        prompt: string;
        completion: string;
    };
}

interface AnthropicResponse {
    data: AnthropicModel[];
}

interface GeminiModel {
    name: string;
    displayName?: string;
    description?: string;
    supportedGenerationMethods: string[];
}

interface GeminiResponse {
    models: GeminiModel[];
}

/**
 * Providers whose model list is a CURATED static catalog (not fetched live), so
 * it isn't exhaustive — a model missing from it is NOT proof the model is
 * invalid. Callers must not treat a miss as a hard mismatch/failure for these.
 */
export const CURATED_CATALOG_PROVIDERS = new Set<BYOKProvider>([
    BYOKProvider.AMAZON_BEDROCK,
    BYOKProvider.GOOGLE_VERTEX,
]);

export interface ModelResponse {
    provider: BYOKProvider;
    models: Array<{
        id: string;
        name: string;
        supportsReasoning?: boolean;
        reasoningConfig?: ReasoningConfig;
    }>;
}

@Injectable()
export class GetModelsByProviderUseCase {
    private readonly logger = createLogger(GetModelsByProviderUseCase.name);

    constructor(
        private readonly providerService: ProviderService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async testCredential(
        provider: string,
        credentialType: string,
        credentials: { apiKey?: string; subscriptionToken?: string },
        organizationId?: string,
    ): Promise<{ success: boolean; message: string }> {
        try {
            if (credentialType === 'subscription_token') {
                let token = credentials.subscriptionToken?.trim();
                let savedAccountId: string | undefined;

                // If no token provided, try loading the saved one from DB
                if (!token && organizationId) {
                    const saved = await this.loadSavedCredentials(provider, organizationId);
                    if (saved?.subscriptionToken) {
                        token = saved.subscriptionToken;
                        savedAccountId = saved.chatgptAccountId;
                    }
                }

                if (!token) {
                    return { success: false, message: 'No token provided' };
                }

                // Parse JSON credentials if user pasted the full file
                if (token.startsWith('{')) {
                    try {
                        const parsed = JSON.parse(token);
                        if (provider === BYOKProvider.OPENAI) {
                            token = parsed?.tokens?.access_token;
                            if (!token) {
                                return { success: false, message: 'Could not find tokens.access_token in auth.json' };
                            }
                        } else if (provider === BYOKProvider.ANTHROPIC) {
                            const oauthBlock = parsed?.claudeAiOauth ?? parsed;
                            token = oauthBlock?.accessToken;
                            if (!token) {
                                return { success: false, message: 'Could not find accessToken in credentials JSON' };
                            }
                        }
                    } catch {
                        return { success: false, message: 'Invalid JSON format' };
                    }
                }

                if (provider === BYOKProvider.OPENAI) {
                    // Decode JWT and check expiry (only OpenAI tokens are JWTs)
                    try {
                        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
                        if (payload.exp && payload.exp * 1000 < Date.now()) {
                            return { success: false, message: 'Token is expired. Run codex login again.' };
                        }
                    } catch {
                        return { success: false, message: 'Could not decode JWT — is this a valid token?' };
                    }
                    // Use saved account ID if available, otherwise extract from JWT
                    let chatgptAccountId = savedAccountId ?? '';
                    if (!chatgptAccountId) {
                        try {
                            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
                            chatgptAccountId = payload['https://api.openai.com/auth']?.chatgpt_account_id
                                ?? payload['https://api.openai.com/auth']?.user_id
                                ?? '';
                        } catch { /* ignore */ }
                    }

                    // If user pasted the full auth.json, also try account_id field
                    if (!chatgptAccountId && credentials.subscriptionToken?.trim()?.startsWith('{')) {
                        try {
                            const parsed = JSON.parse(credentials.subscriptionToken.trim());
                            chatgptAccountId = parsed?.tokens?.account_id ?? '';
                        } catch { /* ignore */ }
                    }

                    // Test with a minimal Codex API call using correct Codex CLI headers
                    // Codex API requires stream:true and store:false
                    const response = await axios.post(
                        'https://chatgpt.com/backend-api/codex/responses',
                        {
                            model: 'gpt-5.1-codex',
                            instructions: 'Say ok',
                            input: [{ role: 'user', content: 'test' }],
                            store: false,
                            stream: true,
                        },
                        {
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                ...(chatgptAccountId ? { 'ChatGPT-Account-ID': chatgptAccountId } : {}),
                                'originator': 'codex_cli_rs',
                                'User-Agent': 'codex_cli_rs/0.1.0',
                                'Content-Type': 'application/json',
                                'Accept': 'text/event-stream',
                            },
                            timeout: 15000,
                            responseType: 'stream',
                            // We don't need to read the full response — just confirm 2xx status
                            validateStatus: (status) => status >= 200 && status < 300,
                        },
                    );
                    // Abort the stream immediately — we only needed to confirm auth works
                    response.data?.destroy?.();
                    return { success: true, message: 'Token is valid — Codex API responded successfully.' };
                }

                if (provider === BYOKProvider.ANTHROPIC) {
                    // Test Anthropic subscription token via models endpoint
                    await axios.get('https://api.anthropic.com/v1/models', {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'anthropic-version': '2023-06-01',
                            'anthropic-beta': [
                                'claude-code-20250219',
                                'oauth-2025-04-20',
                            ].join(','),
                        },
                        timeout: 10000,
                    });
                    return { success: true, message: 'Token is valid — Anthropic API responded successfully.' };
                }

                return { success: false, message: `Subscription tokens are not supported for ${provider}` };
            }

            // API key test — just try listing models
            if (!credentials.apiKey?.trim()) {
                return { success: false, message: 'No API key provided' };
            }

            const result = await this.execute(provider, { apiKey: credentials.apiKey });
            if (result.models.length > 0) {
                return { success: true, message: `API key is valid — found ${result.models.length} models.` };
            }
            return { success: false, message: 'API key returned no models' };
        } catch (error) {
            const msg = (error as any)?.response?.data?.detail
                || (error as any)?.response?.data?.error?.message
                || (error as any)?.response?.data?.message
                || (error as Error).message
                || 'Unknown error';
            return { success: false, message: `Test failed: ${msg}` };
        }
    }

    async execute(
        provider: string,
        userCredentials?: OrganizationAndTeamData & {
            apiKey?: string;
            subscriptionToken?: string;
            chatgptAccountId?: string;
            baseURL?: string;
        },
    ): Promise<ModelResponse> {
        if (!this.providerService.isProviderSupported(provider)) {
            throw new BadRequestException(`Unsupported provider: ${provider}`);
        }

        // Parse JSON credentials if user pasted a full credentials file
        let credentials = userCredentials ? { ...userCredentials } : userCredentials;
        if (credentials?.subscriptionToken?.trimStart().startsWith('{')) {
            try {
                const parsed = JSON.parse(credentials.subscriptionToken);
                if (provider === BYOKProvider.OPENAI) {
                    credentials.chatgptAccountId =
                        parsed?.tokens?.account_id ??
                        credentials.chatgptAccountId;
                    credentials.subscriptionToken =
                        parsed?.tokens?.access_token ??
                        credentials.subscriptionToken;
                } else if (provider === BYOKProvider.ANTHROPIC) {
                    const oauthBlock = parsed?.claudeAiOauth ?? parsed;
                    credentials.subscriptionToken = oauthBlock?.accessToken ?? credentials.subscriptionToken;
                }
            } catch {
                // Not valid JSON — use as-is
            }
        }

        if (credentials?.subscriptionToken) {
            credentials.subscriptionToken =
                credentials.subscriptionToken.trim();
        }
        if (credentials?.chatgptAccountId) {
            credentials.chatgptAccountId =
                credentials.chatgptAccountId.trim();
        }

        const byokProvider = provider as BYOKProvider;

        // Prefer the org's OWN saved BYOK credentials so the catalog reflects
        // the user's actual endpoint/key (e.g. an openai_compatible proxy like
        // Moonshot) rather than Kodus' bundled env keys — otherwise the list is
        // for the wrong account and the user's real models all look "unknown".
        // Falls back to env when no saved slot matches (e.g. the setup wizard,
        // before the config is saved).
        const creds = await resolveByokSlot(
            this.organizationParametersService,
            byokProvider,
            userCredentials,
        );

        const apiKey = credentials?.apiKey ?? creds?.apiKey;
        const subscriptionToken =
            credentials?.subscriptionToken ?? creds?.subscriptionToken;
        const chatgptAccountId =
            credentials?.chatgptAccountId ?? creds?.chatgptAccountId;
        const baseURL = credentials?.baseURL ?? creds?.baseURL;

        switch (byokProvider) {
            case BYOKProvider.OPENAI: {
                // Subscription token = Codex via ChatGPT Plus — return static Codex model list
                if (subscriptionToken) {
                    return this.getOpenAICodexStaticModels();
                }
                const openaiKey = apiKey || process.env.API_OPEN_AI_API_KEY;
                // No API key available — return static list instead of a guaranteed 401
                if (!openaiKey) {
                    return this.getOpenAICodexStaticModels();
                }
                return this.getOpenAIModels(openaiKey);
            }

            case BYOKProvider.ANTHROPIC:
                return this.getAnthropicModels(
                    apiKey || process.env.API_ANTHROPIC_API_KEY,
                    subscriptionToken,
                );

            case BYOKProvider.GOOGLE_GEMINI:
                return this.getGeminiModels(
                    apiKey ?? process.env.API_GOOGLE_AI_API_KEY,
                );

            case BYOKProvider.GOOGLE_VERTEX:
                return this.getVertexModels();

            case BYOKProvider.OPEN_ROUTER:
                return this.getOpenRouterModels(
                    apiKey ?? process.env.API_OPEN_ROUTER_API_KEY,
                );

            case BYOKProvider.NOVITA:
                return this.getNovitaModels(
                    apiKey ?? process.env.API_NOVITA_AI_API_KEY,
                );

            case BYOKProvider.OPENAI_COMPATIBLE:
                return this.getOpenAICompatibleModels(
                    apiKey ?? process.env.API_OPEN_AI_API_KEY,
                    baseURL ??
                        (process.env.API_OPENAI_FORCE_BASE_URL ||
                            'https://api.openai.com'),
                );

            case BYOKProvider.AMAZON_BEDROCK:
                return this.getBedrockModels();

            case BYOKProvider.ANTHROPIC_COMPATIBLE:
                // Listing needs the user's baseURL + key, which aren't
                // available here; the frontend forces free-form model input
                // for baseURL-requiring providers, so this is never called
                // in the normal flow.
                throw new BadRequestException(
                    'Model listing is not available for anthropic_compatible — enter the model ID manually.',
                );

            default:
                throw new BadRequestException(
                    `Unsupported provider: ${provider}`,
                );
        }
    }

    /**
     * Bedrock model IDs are region-scoped and cross-region inference
     * profiles vary by AWS account. We can't list them generically without
     * the user's AWS credentials (which are entered later in the wizard),
     * so this returns a curated set of "us.*" cross-region inference
     * profiles that cover the most common code-review use cases.
     *
     * Users on eu/apac regions or with custom inference profiles can still
     * paste a model ID manually — the frontend allows free-form input on
     * the Bedrock model field.
     */
    private getBedrockModels(): ModelResponse {
        // Lookup by the Anthropic-style suffix (everything after
        // "us.anthropic.") so we still pick up reasoning config from
        // getModelCapabilities even though the catalog ID is prefixed.
        const reasoningKeyOf = (id: string): string => {
            const match = id.match(/^[a-z]{2,5}\.anthropic\.(.+?)-v\d+:\d+$/);
            return match ? match[1] : id;
        };

        const catalog: Array<{ id: string; name: string }> = [
            {
                id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                name: 'Claude Sonnet 4.5 (us, cross-region)',
            },
            {
                id: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
                name: 'Claude Sonnet 4 (us, cross-region)',
            },
            {
                id: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
                name: 'Claude Opus 4.1 (us, cross-region)',
            },
            {
                id: 'us.anthropic.claude-opus-4-20250514-v1:0',
                name: 'Claude Opus 4 (us, cross-region)',
            },
            {
                id: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
                name: 'Claude 3.7 Sonnet (us, cross-region)',
            },
            {
                id: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
                name: 'Claude 3.5 Sonnet v2 (us, cross-region)',
            },
            {
                id: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
                name: 'Claude 3.5 Haiku (us, cross-region)',
            },
        ];

        return {
            provider: BYOKProvider.AMAZON_BEDROCK,
            models: catalog.map(({ id, name }) => {
                const capabilities = getModelCapabilities(reasoningKeyOf(id));
                return {
                    id,
                    name,
                    ...(capabilities.supportsReasoning && {
                        supportsReasoning: true,
                        reasoningConfig: capabilities.reasoningConfig,
                    }),
                };
            }),
        };
    }

    private async loadSavedCredentials(
        provider: string,
        organizationId: string,
    ): Promise<{ subscriptionToken?: string; chatgptAccountId?: string } | null> {
        try {
            const param = await this.organizationParametersService.findByKey(
                OrganizationParametersKey.BYOK_CONFIG,
                { organizationId },
            );
            if (!param?.configValue) return null;

            // Check main first, then fallback
            for (const slot of ['main', 'fallback'] as const) {
                const cfg = param.configValue[slot];
                if (cfg?.provider === provider && cfg?.subscriptionToken) {
                    return {
                        subscriptionToken: decrypt(cfg.subscriptionToken),
                        chatgptAccountId: cfg.chatgptAccountId,
                    };
                }
            }
            return null;
        } catch (error) {
            this.logger.error({
                message: 'Error loading saved credentials for test',
                context: GetModelsByProviderUseCase.name,
                error: error instanceof Error ? error : new Error(String(error)),
            });
            return null;
        }
    }

    private getOpenAICodexStaticModels(): ModelResponse {
        const codexModels = [
            { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
            { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
            { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
            { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
            { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
            { id: 'gpt-5-codex-mini', name: 'GPT-5 Codex Mini' },
        ];

        return {
            provider: BYOKProvider.OPENAI,
            models: codexModels.map(({ id, name }) => {
                const capabilities = getModelCapabilities(id);
                return {
                    id,
                    name,
                    ...(capabilities.supportsReasoning && {
                        supportsReasoning: true,
                        reasoningConfig: capabilities.reasoningConfig,
                    }),
                };
            }),
        };
    }

    private async getOpenAIModels(apiKey?: string): Promise<ModelResponse> {
        try {
            const response = await axios.get<OpenAIResponse>(
                'https://api.openai.com/v1/models',
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                },
            );

            const models = {
                provider: BYOKProvider.OPENAI,
                models: response.data.data.map((model: OpenAIModel) => {
                    const capabilities = getModelCapabilities(model.id);
                    const modelResult = {
                        id: model.id,
                        name: model.id,
                        ...(capabilities.supportsReasoning && {
                            supportsReasoning: true,
                            reasoningConfig: capabilities.reasoningConfig,
                        }),
                    };

                    return modelResult;
                }),
            };

            return models;
        } catch (error) {
            throw new BadRequestException(
                `Error fetching OpenAI models: ${(error as Error).message}`,
            );
        }
    }

    private async getAnthropicModels(apiKey?: string, subscriptionToken?: string): Promise<ModelResponse> {
        // If no credential at all, return static list
        if (!apiKey && !subscriptionToken) {
            return this.getAnthropicStaticModels();
        }

        try {
            const headers: Record<string, string> = {
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            };

            if (subscriptionToken) {
                headers['Authorization'] = `Bearer ${subscriptionToken}`;
                headers['anthropic-beta'] = [
                    'claude-code-20250219',
                    'oauth-2025-04-20',
                    'fine-grained-tool-streaming-2025-05-14',
                    'interleaved-thinking-2025-05-14',
                ].join(',');
            } else {
                headers['x-api-key'] = apiKey!;
            }

            const response = await axios.get<AnthropicResponse>(
                'https://api.anthropic.com/v1/models',
                { headers },
            );

            return {
                provider: BYOKProvider.ANTHROPIC,
                models: response.data.data.map((model: AnthropicModel) => {
                    const capabilities = getModelCapabilities(model.id);
                    return {
                        id: model.id,
                        name: model.display_name || model.id,
                        ...(capabilities.supportsReasoning && {
                            supportsReasoning: true,
                            reasoningConfig: capabilities.reasoningConfig,
                        }),
                    };
                }),
            };
        } catch (error) {
            // Fall back to static list on any auth/network error
            this.logger.warn({
                message: `Anthropic models API failed (${(error as Error).message}), returning static list`,
                context: GetModelsByProviderUseCase.name,
            });
            return this.getAnthropicStaticModels();
        }
    }

    private getAnthropicStaticModels(): ModelResponse {
        const staticModels = [
            { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
            { id: 'claude-sonnet-4-5-20251101', name: 'Claude Sonnet 4.5' },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
            { id: 'claude-opus-4-0-20250514', name: 'Claude Opus 4' },
            { id: 'claude-sonnet-4-0-20250514', name: 'Claude Sonnet 4' },
            { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
            { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
            { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
        ];

        return {
            provider: BYOKProvider.ANTHROPIC,
            models: staticModels.map(({ id, name }) => {
                const capabilities = getModelCapabilities(id);
                return {
                    id,
                    name,
                    ...(capabilities.supportsReasoning && {
                        supportsReasoning: true,
                        reasoningConfig: capabilities.reasoningConfig,
                    }),
                };
            }),
        };
    }

    private async getGeminiModels(apiKey?: string): Promise<ModelResponse> {
        try {
            const response = await axios.get<GeminiResponse>(
                'https://generativelanguage.googleapis.com/v1beta/models',
                {
                    headers: {
                        'x-goog-api-key': apiKey,
                    },
                    timeout: 10000, // 10 segundos timeout
                },
            );

            const models = {
                provider: BYOKProvider.GOOGLE_GEMINI,
                models: response.data.models
                    .filter((model: GeminiModel) =>
                        model.name.includes('gemini'),
                    )
                    .map((model: GeminiModel) => {
                        const modelId = model.name.split('/')[1];
                        const capabilities = getModelCapabilities(modelId);

                        const formatModelName = (str: string): string => {
                            return str
                                .split('-')
                                .map((word, index) => {
                                    if (index === 0) {
                                        // First word always capitalized
                                        return (
                                            word.charAt(0).toUpperCase() +
                                            word.slice(1).toLowerCase()
                                        );
                                    }
                                    // Numbers with dots stay as they are
                                    if (/^\d+\.\d+$/.test(word)) {
                                        return word;
                                    }
                                    // Other words capitalize first letter
                                    return (
                                        word.charAt(0).toUpperCase() +
                                        word.slice(1).toLowerCase()
                                    );
                                })
                                .join(' ');
                        };

                        return {
                            id: modelId,
                            name: formatModelName(modelId),
                            ...(capabilities.supportsReasoning && {
                                supportsReasoning: true,
                                reasoningConfig: capabilities.reasoningConfig,
                            }),
                        };
                    }),
            };

            return models;
        } catch (error) {
            throw new BadRequestException(
                `Error fetching Gemini models: ${(error as Error).message}`,
            );
        }
    }
    private async getOpenRouterModels(apiKey?: string): Promise<ModelResponse> {
        try {
            const response = await axios.get<OpenAIResponse>(
                'https://openrouter.ai/api/v1/models',
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                },
            );

            return {
                provider: BYOKProvider.OPEN_ROUTER,
                models: response.data.data.map((model: OpenAIModel) => ({
                    id: model.id,
                    name: model.id,
                })),
            };
        } catch (error) {
            throw new BadRequestException(
                `Error fetching OpenRouter models: ${(error as Error).message}`,
            );
        }
    }

    private async getNovitaModels(apiKey?: string): Promise<ModelResponse> {
        try {
            const response = await axios.get<OpenAIResponse>(
                'https://api.novita.ai/v3/openai/models',
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                },
            );

            return {
                provider: BYOKProvider.NOVITA,
                models: response.data.data.map((model: OpenAIModel) => ({
                    id: model.id,
                    name: model.id,
                })),
            };
        } catch (error) {
            throw new BadRequestException(
                `Error fetching Novita models: ${(error as Error).message}`,
            );
        }
    }

    private async getOpenAICompatibleModels(
        apiKey?: string,
        baseUrl?: string,
    ): Promise<ModelResponse> {
        if (!baseUrl) {
            throw new BadRequestException(
                'baseUrl is required for OpenAI Compatible',
            );
        }

        // SSRF guard: the baseURL can come from the org's stored BYOK config
        // (user-controlled), so reject private/reserved IPs, the cloud metadata
        // endpoint, and non-https schemes before making the server-side request
        // — the same guard the connection probe uses.
        await assertSafeOpenAICompatibleUrl(baseUrl);

        try {
            // Trim trailing slashes without a regex (backtracking-safe), then
            // only add `/v1` when the base URL doesn't already end in a version
            // segment — a stored openai_compatible baseURL usually includes
            // `/v1` (e.g. Moonshot's `https://api.moonshot.ai/v1`), so a naive
            // `${baseUrl}/v1/models` would 404 on `/v1/v1/models`. Mirrors the
            // connection probe's URL logic.
            let trimmed = baseUrl;
            while (trimmed.endsWith('/')) {
                trimmed = trimmed.slice(0, -1);
            }
            const needsV1 = !/\/v\d+$/i.test(trimmed);
            const modelsUrl = needsV1
                ? `${trimmed}/v1/models`
                : `${trimmed}/models`;

            const response = await axios.get<OpenAIResponse>(modelsUrl, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                // The SSRF guard only validates the base host: without these a
                // public URL could 302-redirect the request onto a private IP /
                // the cloud metadata endpoint (169.254.169.254), or hang. Mirror
                // the connection probe: never follow redirects, bounded timeout.
                maxRedirects: 0,
                timeout: 15_000,
            });

            return {
                provider: BYOKProvider.OPENAI_COMPATIBLE,
                models: response.data.data.map((model: OpenAIModel) => ({
                    id: model.id,
                    name: model.id,
                })),
            };
        } catch (error) {
            throw new BadRequestException(
                `Error fetching OpenAI Compatible models: ${(error as Error).message}`,
            );
        }
    }

    /**
     * Vertex models can't be listed generically: per-project/region
     * availability requires the user's service-account JSON, which isn't
     * available to this (GET, credential-less) endpoint. Listing it live
     * would mean putting a sensitive ~3KB SA JSON in a query string.
     *
     * So, like Bedrock, return a curated catalog. It covers both Vertex
     * model families served via different protocols:
     *   - Gemini (`gemini-*`)  → Gemini protocol  (createVertex)
     *   - Claude (`claude-*@…`) → Anthropic protocol on Vertex MaaS
     *                            (createVertexAnthropic)
     * Model-id routing happens in `byok-to-vercel.ts`. Users on other
     * regions or with custom/newer models can still paste a model ID —
     * the Vertex model field allows free-form input.
     *
     * Vertex Claude ID convention (per Anthropic's official Vertex docs):
     * recent models use a bare id (e.g. `claude-opus-4-8`), older ones use
     * the `@<version>` suffix (e.g. `claude-sonnet-4-5@20250929`). Both
     * route through createVertexAnthropic. Catalog reflects models that are
     * current (non-deprecated) on Vertex as of 2026-06.
     */
    private getVertexModels(): ModelResponse {
        const catalog: Array<{ id: string; name: string }> = [
            // gemini-3-pro-preview was discontinued on Vertex (2026-03-26);
            // Google's migration target is gemini-3.1-pro-preview.
            { id: 'gemini-3.1-pro-preview', name: 'Vertex Gemini 3.1 Pro' },
            { id: 'gemini-3.5-flash', name: 'Vertex Gemini 3.5 Flash' },
            { id: 'gemini-2.5-pro', name: 'Vertex Gemini 2.5 Pro' },
            { id: 'gemini-2.5-flash', name: 'Vertex Gemini 2.5 Flash' },
            // Only Claude models served by the GLOBAL endpoint (bare ids) are
            // listed, so any catalog pick works with the default global region
            // out of the box. Older @date-suffixed Claude models (Sonnet 4.5,
            // Haiku 4.5, …) are region-only (e.g. us-east5) — users who want
            // those can type the id manually and pin the region.
            { id: 'claude-opus-4-8', name: 'Vertex Claude Opus 4.8' },
            { id: 'claude-opus-4-7', name: 'Vertex Claude Opus 4.7' },
            { id: 'claude-sonnet-4-6', name: 'Vertex Claude Sonnet 4.6' },
        ];

        // Capability lookup keys on a plain model name; strip the Vertex
        // `@<version>` suffix so versioned Claude entries resolve their
        // reasoning config (bare ids pass through unchanged).
        const reasoningKeyOf = (id: string): string => id.split('@')[0];

        return {
            provider: BYOKProvider.GOOGLE_VERTEX,
            models: catalog.map(({ id, name }) => {
                const capabilities = getModelCapabilities(reasoningKeyOf(id));
                return {
                    id,
                    name,
                    ...(capabilities.supportsReasoning && {
                        supportsReasoning: true,
                        reasoningConfig: capabilities.reasoningConfig,
                    }),
                };
            }),
        };
    }
}
