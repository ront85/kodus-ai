import {
    BYOKConfig,
    BYOKCredentialType,
    LLMModelProvider,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { decrypt } from '@libs/common/utils/crypto';
import { Injectable } from '@nestjs/common';

@Injectable()
export class BYOKPromptRunnerService {
    private readonly basePromptRunnerService: PromptRunnerService;
    private readonly defaultProvider: LLMModelProvider;
    private readonly fallbackProvider?: LLMModelProvider;
    private readonly byokConfig?: BYOKConfig;
    public readonly executeMode: string;

    constructor(
        basePromptRunnerService: PromptRunnerService,
        provider: LLMModelProvider,
        fallbackProvider?: LLMModelProvider,
        byokConfig?: BYOKConfig,
    ) {
        this.basePromptRunnerService = basePromptRunnerService;
        this.defaultProvider = provider;
        this.fallbackProvider = fallbackProvider;
        this.byokConfig = byokConfig;
        this.executeMode = byokConfig ? 'byok' : 'system';
    }

    /**
     * Creates and returns a PromptBuilder already configured with the providers
     * and BYOK settings defined in the constructor.
     *
     * @returns Configured PromptBuilder ready to use
     */
    builder() {
        let analysisBuilder = this.basePromptRunnerService
            .builder()
            .setProviders({
                main: this.defaultProvider,
                fallback: this.byokConfig?.fallback
                    ? this.fallbackProvider
                    : undefined,
            });

        if (this.byokConfig?.main) {
            const mainCreds = this.resolveCredentials(this.byokConfig.main);
            const fallbackCfg = this.byokConfig?.fallback;
            const fallbackCreds = fallbackCfg
                ? this.resolveCredentials(fallbackCfg)
                : null;

            const hasFallback = fallbackCreds !== null && fallbackCfg && (
                fallbackCreds.credentialType === BYOKCredentialType.SUBSCRIPTION_TOKEN
                    ? !!fallbackCreds.subscriptionToken
                    : !!fallbackCreds.apiKey
            );

            analysisBuilder = analysisBuilder
                .setBYOKConfig({
                    provider: this.byokConfig.main.provider,
                    apiKey: mainCreds.apiKey,
                    subscriptionToken: mainCreds.subscriptionToken,
                    chatgptAccountId: mainCreds.chatgptAccountId,
                    model: this.byokConfig.main.model,
                    baseURL: this.byokConfig.main.baseURL,
                    temperature: this.byokConfig.main.temperature,
                    maxOutputTokens: this.byokConfig.main.maxOutputTokens,
                })
                .setBYOKFallbackConfig(
                    hasFallback && fallbackCfg
                        ? {
                              provider: fallbackCfg.provider,
                              apiKey: fallbackCreds.apiKey,
                              subscriptionToken: fallbackCreds.subscriptionToken,
                              chatgptAccountId: fallbackCreds.chatgptAccountId,
                              model: fallbackCfg.model,
                              baseURL: fallbackCfg.baseURL,
                              temperature: fallbackCfg.temperature,
                              maxOutputTokens: fallbackCfg.maxOutputTokens,
                          }
                        : null,
                );
        }

        return analysisBuilder;
    }

    private resolveCredentials(
        cfg: NonNullable<BYOKConfig['main']> | NonNullable<BYOKConfig['fallback']>,
    ): {
        credentialType: BYOKCredentialType;
        apiKey?: string;
        subscriptionToken?: string;
        chatgptAccountId?: string;
    } {
        if (cfg.credentialType === BYOKCredentialType.SUBSCRIPTION_TOKEN) {
            if (cfg.tokenExpiresAt && Date.now() >= cfg.tokenExpiresAt - 60_000) {
                const isOpenAI = cfg.provider === 'openai';
                throw new Error(
                    isOpenAI
                        ? 'BYOK_TOKEN_EXPIRED: Your OpenAI subscription token has expired. Run openai auth login again and update it in Organization Settings > LLM Provider.'
                        : 'BYOK_TOKEN_EXPIRED: Your Claude subscription token has expired and could not be auto-refreshed. Re-run `claude setup-token` again and update it in Organization Settings > LLM Provider.',
                );
            }
            return {
                credentialType: BYOKCredentialType.SUBSCRIPTION_TOKEN,
                subscriptionToken: decrypt(cfg.subscriptionToken),
                chatgptAccountId: cfg.chatgptAccountId,
            };
        }
        return {
            credentialType: BYOKCredentialType.API_KEY,
            apiKey: decrypt(cfg.apiKey),
        };
    }

    /**
     * Convenience method to create a new instance of BYOKPromptRunnerService
     * with different configurations.
     *
     * @param provider Main provider
     * @param fallbackProvider Fallback provider (optional)
     * @param byokConfig BYOK configuration (optional)
     * @returns New instance of BYOKPromptRunnerService
     */
    withConfig(
        provider: LLMModelProvider,
        fallbackProvider?: LLMModelProvider,
        byokConfig?: BYOKConfig,
    ): BYOKPromptRunnerService {
        return new BYOKPromptRunnerService(
            this.basePromptRunnerService,
            provider,
            fallbackProvider,
            byokConfig,
        );
    }

    /**
     * Getter to access the configured default provider
     */
    get provider(): LLMModelProvider {
        return this.defaultProvider;
    }

    /**
     * Getter to access the configured fallback provider
     */
    get fallback(): LLMModelProvider | undefined {
        return this.fallbackProvider;
    }

    /**
     * Getter to access the BYOK configuration
     */
    get config(): BYOKConfig | undefined {
        return this.byokConfig;
    }
}
