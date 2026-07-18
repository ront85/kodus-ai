import axios from 'axios';
import { BYOKProvider } from '@kodus/kodus-common/llm';
import { GetModelsByProviderUseCase } from '@libs/organization/application/use-cases/organizationParameters/get-models-by-provider.use-case';

jest.mock('axios');
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (value: string) => value,
}));
jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const originalCatalogClientVersion =
    process.env.KODUS_CODEX_CATALOG_CLIENT_VERSION;

describe('GetModelsByProviderUseCase', () => {
    const organizationParametersService = {
        findByKey: jest.fn(),
    };
    const providerService = {
        isProviderSupported: jest.fn().mockReturnValue(true),
    };
    let useCase: GetModelsByProviderUseCase;

    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.KODUS_CODEX_CATALOG_CLIENT_VERSION;
        providerService.isProviderSupported.mockReturnValue(true);
        useCase = new GetModelsByProviderUseCase(
            providerService as any,
            organizationParametersService as any,
        );
    });

    afterAll(() => {
        if (originalCatalogClientVersion === undefined) {
            delete process.env.KODUS_CODEX_CATALOG_CLIENT_VERSION;
        } else {
            process.env.KODUS_CODEX_CATALOG_CLIENT_VERSION =
                originalCatalogClientVersion;
        }
    });

    it('loads and filters the account-scoped OpenAI OAuth catalog', async () => {
        mockedAxios.get.mockResolvedValueOnce({
            data: {
                models: [
                    {
                        slug: 'gpt-future-new',
                        display_name: 'GPT Future New',
                        visibility: 'list',
                        supported_in_api: true,
                        supported_reasoning_levels: [
                            { effort: 'low' },
                            { effort: 'xhigh' },
                        ],
                    },
                    {
                        slug: 'gpt-hidden',
                        display_name: 'Hidden',
                        visibility: 'hide',
                    },
                    {
                        slug: 'gpt-not-supported',
                        visibility: 'list',
                        supported_in_api: false,
                    },
                    {
                        slug: 'gpt-contradictory',
                        visibility: 'list',
                        hidden: true,
                    },
                    null,
                    {
                        slug: '  ',
                        id: 'gpt-id-fallback',
                        display_name: 'GPT ID Fallback',
                        visibility: 'list',
                    },
                    {
                        slug: 'gpt-id-fallback',
                        display_name: 'Duplicate',
                        visibility: 'list',
                    },
                ],
            },
        } as any);

        const result = await useCase.execute(BYOKProvider.OPENAI, {
            subscriptionToken: JSON.stringify({
                tokens: {
                    access_token: 'oauth-token',
                    account_id: 'account-from-json',
                },
            }),
        });

        expect(result.models.map((model) => model.id)).toEqual([
            'gpt-future-new',
            'gpt-id-fallback',
        ]);
        expect(result.models[0].reasoningConfig).toEqual({
            type: 'level',
            options: ['low', 'high'],
        });
        expect(mockedAxios.get).toHaveBeenCalledWith(
            'https://chatgpt.com/backend-api/codex/models',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer oauth-token',
                    'ChatGPT-Account-ID': 'account-from-json',
                }),
                params: { client_version: '0.144.0' },
                timeout: 8000,
            }),
        );
    });

    it('falls back to the current OpenAI subscription catalog', async () => {
        mockedAxios.get.mockRejectedValueOnce(new Error('network failure'));

        const result = await useCase.execute(BYOKProvider.OPENAI, {
            subscriptionToken: 'oauth-token',
            chatgptAccountId: 'account-id',
        });

        expect(result.models.map((model) => model.id)).toEqual(
            expect.arrayContaining([
                'gpt-5.6-sol',
                'gpt-5.6-terra',
                'gpt-5.6-luna',
                'gpt-5.5',
                'gpt-5.4',
                'gpt-5.4-mini',
                'gpt-5.3-codex',
            ]),
        );
    });

    it('propagates the saved ChatGPT account ID', async () => {
        organizationParametersService.findByKey.mockResolvedValueOnce({
            configValue: {
                main: {
                    provider: BYOKProvider.OPENAI,
                    subscriptionToken: 'saved-oauth-token',
                    chatgptAccountId: 'saved-account-id',
                },
            },
        });
        mockedAxios.get.mockResolvedValueOnce({
            data: {
                models: [
                    {
                        slug: 'gpt-saved',
                        display_name: 'GPT Saved',
                        visibility: 'list',
                    },
                ],
            },
        } as any);

        await useCase.execute(BYOKProvider.OPENAI, {
            organizationId: 'organization-id',
        });

        expect(mockedAxios.get).toHaveBeenCalledWith(
            'https://chatgpt.com/backend-api/codex/models',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer saved-oauth-token',
                    'ChatGPT-Account-ID': 'saved-account-id',
                }),
            }),
        );
    });

    it('returns the live Anthropic OAuth catalog', async () => {
        mockedAxios.get.mockResolvedValueOnce({
            data: {
                data: [
                    {
                        id: 'claude-future-6',
                        display_name: 'Claude Future 6',
                        capabilities: {
                            thinking: { supported: true },
                        },
                    },
                ],
            },
        } as any);

        const result = await useCase.execute(BYOKProvider.ANTHROPIC, {
            subscriptionToken: 'anthropic-oauth-token',
        });

        expect(result.models).toEqual([
            {
                id: 'claude-future-6',
                name: 'Claude Future 6',
                supportsReasoning: true,
                reasoningConfig: {
                    type: 'budget',
                    options: { min: 128, default: 3000 },
                },
            },
        ]);
        expect(mockedAxios.get).toHaveBeenCalledWith(
            'https://api.anthropic.com/v1/models',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer anthropic-oauth-token',
                }),
                params: { limit: 1000 },
                timeout: 8000,
            }),
        );
    });

    it('falls back to current Claude models when OAuth discovery fails', async () => {
        mockedAxios.get.mockRejectedValueOnce(new Error('network failure'));

        const result = await useCase.execute(BYOKProvider.ANTHROPIC, {
            subscriptionToken: 'anthropic-oauth-token',
        });

        expect(result.models.map((model) => model.id)).toEqual(
            expect.arrayContaining([
                'claude-fable-5',
                'claude-opus-4-8',
                'claude-sonnet-5',
                'claude-sonnet-4-6',
                'claude-haiku-4-5-20251001',
            ]),
        );
    });

    it('preserves OpenAI API-key model discovery', async () => {
        mockedAxios.get.mockResolvedValueOnce({
            data: {
                object: 'list',
                data: [
                    {
                        id: 'gpt-api-key-model',
                        object: 'model',
                        created: 0,
                        owned_by: 'openai',
                    },
                ],
            },
        } as any);

        const result = await useCase.execute(BYOKProvider.OPENAI, {
            apiKey: 'api-key',
        });

        expect(result.models[0].id).toBe('gpt-api-key-model');
        expect(mockedAxios.get).toHaveBeenCalledWith(
            'https://api.openai.com/v1/models',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer api-key',
                }),
            }),
        );
    });
});
