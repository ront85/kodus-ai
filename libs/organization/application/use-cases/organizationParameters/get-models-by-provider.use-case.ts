import {
    BYOKProvider,
    BYOKCredentialType,
    getModelCapabilities,
    ReasoningConfig,
} from '@kodus/kodus-common/llm';
import { ProviderService } from '@libs/core/infrastructure/services/providers/provider.service';
import { decrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { createLogger } from '@kodus/flow';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import axios from 'axios';

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

interface VertexModel {
    name: string;
    displayName?: string;
    description?: string;
    versionId?: string;
    versionCreateTime?: string;
    versionUpdateTime?: string;
    versionDescription?: string;
    supportedDeploymentResourcesTypes?: string[];
    supportedInputStorageFormats?: string[];
    supportedOutputStorageFormats?: string[];
}

interface VertexResponse {
    models: VertexModel[];
    nextPageToken?: string;
}

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

                // Parse auth.json if user pasted the full file
                if (token.startsWith('{')) {
                    try {
                        const parsed = JSON.parse(token);
                        token = parsed?.tokens?.access_token;
                        if (!token) {
                            return { success: false, message: 'Could not find tokens.access_token in auth.json' };
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
        userCredentials?: { apiKey?: string; subscriptionToken?: string; organizationId?: string },
    ): Promise<ModelResponse> {
        if (!this.providerService.isProviderSupported(provider)) {
            throw new BadRequestException(`Unsupported provider: ${provider}`);
        }

        // If no inline credentials but organizationId provided, load & decrypt saved BYOK config
        let credentials = userCredentials;
        if (userCredentials?.organizationId && !userCredentials.apiKey && !userCredentials.subscriptionToken) {
            try {
                const saved = await this.organizationParametersService.findByKey(
                    OrganizationParametersKey.BYOK_CONFIG,
                    { organizationId: userCredentials.organizationId },
                );
                const main = saved?.configValue?.main;
                if (main?.provider === provider) {
                    credentials = {
                        apiKey: main.apiKey ? decrypt(main.apiKey) : undefined,
                        subscriptionToken: main.subscriptionToken ? decrypt(main.subscriptionToken) : undefined,
                    };
                }
            } catch {
                // ignore — fall through to env keys / static list
            }
        }

        const byokProvider = provider as BYOKProvider;

        switch (byokProvider) {
            case BYOKProvider.OPENAI: {
                // Subscription token = Codex via ChatGPT Plus — return static Codex model list
                if (credentials?.subscriptionToken) {
                    return this.getOpenAICodexStaticModels();
                }
                const openaiKey = credentials?.apiKey || process.env.API_OPEN_AI_API_KEY;
                // No API key available — return static list instead of a guaranteed 401
                if (!openaiKey) {
                    return this.getOpenAICodexStaticModels();
                }
                return this.getOpenAIModels(openaiKey);
            }

            case BYOKProvider.ANTHROPIC:
                return this.getAnthropicModels(
                    credentials?.apiKey || process.env.API_ANTHROPIC_API_KEY,
                    credentials?.subscriptionToken,
                );

            case BYOKProvider.GOOGLE_GEMINI:
                return this.getGeminiModels(
                    credentials?.apiKey || process.env.API_GOOGLE_AI_API_KEY,
                );

            case BYOKProvider.GOOGLE_VERTEX:
                return this.getVertexModels(
                    credentials?.apiKey || process.env.API_GOOGLE_AI_API_KEY,
                );

            case BYOKProvider.OPEN_ROUTER:
                return this.getOpenRouterModels(
                    credentials?.apiKey || process.env.API_OPEN_ROUTER_API_KEY,
                );

            case BYOKProvider.NOVITA:
                return this.getNovitaModels(
                    credentials?.apiKey || process.env.API_NOVITA_AI_API_KEY,
                );

            case BYOKProvider.OPENAI_COMPATIBLE:
                return this.getOpenAICompatibleModels(
                    credentials?.apiKey || process.env.API_OPEN_AI_API_KEY,
                    process.env.API_OPENAI_FORCE_BASE_URL ||
                        'https://api.openai.com',
                );

            default:
                throw new BadRequestException(
                    `Unsupported provider: ${provider}`,
                );
        }
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
                error,
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

        try {
            const modelsUrl = baseUrl.endsWith('/')
                ? `${baseUrl}v1/models`
                : `${baseUrl}/v1/models`;

            const response = await axios.get<OpenAIResponse>(modelsUrl, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
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

    private async getVertexModels(apiKey?: string): Promise<ModelResponse> {
        try {
            if (!apiKey) {
                throw new BadRequestException(
                    'API key is required for Google Vertex',
                );
            }

            this.logger.debug({
                message: 'Fetching Vertex models',
                context: GetModelsByProviderUseCase.name,
                metadata: {
                    apiKeyPrefix: apiKey.substring(0, 10) + '...',
                },
            });

            // Use Gemini API to list models and map to Vertex
            const response = await axios.get<GeminiResponse>(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
            );

            this.logger.debug({
                message: 'Gemini response received',
                context: GetModelsByProviderUseCase.name,
                metadata: {
                    modelCount: response.data.models?.length || 0,
                },
            });

            return {
                provider: BYOKProvider.GOOGLE_VERTEX,
                models: response.data.models
                    .filter(
                        (model: GeminiModel) =>
                            model.name.includes('gemini') &&
                            model.supportedGenerationMethods.includes(
                                'generateContent',
                            ),
                    )
                    .map((model: GeminiModel) => ({
                        id: model.name.split('/')[1],
                        name: `Vertex ${model.displayName || model.name}`,
                    })),
            };
        } catch (error) {
            this.logger.error({
                message: 'Error fetching Vertex models',
                context: GetModelsByProviderUseCase.name,
                error: error,
            });
            throw new BadRequestException(
                `Error fetching Google Vertex models: ${(error as Error).message}`,
            );
        }
    }
}
