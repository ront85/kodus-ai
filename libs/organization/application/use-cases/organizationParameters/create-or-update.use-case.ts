import { BYOKConfig, BYOKProvider } from '@kodus/kodus-common/llm';
import { encrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@kodus/flow';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersEntity } from '@libs/organization/domain/organizationParameters/entities/organizationParameters.entity';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class CreateOrUpdateOrganizationParametersUseCase implements IUseCase {
    private readonly logger = createLogger(
        CreateOrUpdateOrganizationParametersUseCase.name,
    );
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async execute(
        organizationParametersKey: OrganizationParametersKey,
        configValue: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity | boolean> {
        try {
            const processedConfigValue = configValue;
            if (
                organizationParametersKey ===
                OrganizationParametersKey.BYOK_CONFIG
            ) {
                return await this.saveByokConfig(
                    organizationParametersKey,
                    configValue,
                    organizationAndTeamData,
                );
            }

            return await this.organizationParametersService.createOrUpdateConfig(
                organizationParametersKey,
                processedConfigValue,
                organizationAndTeamData,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error creating or updating organization parameters',
                context: CreateOrUpdateOrganizationParametersUseCase.name,
                error: error,
                metadata: {
                    organizationParametersKey,
                    configValue,
                    organizationAndTeamData,
                },
            });
            throw new Error(
                'Error creating or updating organization parameters',
            );
        }
    }

    async swapByokConfig(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<boolean> {
        const existing = await this.organizationParametersService.findByKey(
            OrganizationParametersKey.BYOK_CONFIG,
            organizationAndTeamData,
        );

        if (!existing?.configValue?.main || !existing?.configValue?.fallback) {
            throw new Error('Both main and fallback must be configured to swap');
        }

        const swapped = {
            main: existing.configValue.fallback,
            fallback: existing.configValue.main,
        };

        const result = await this.organizationParametersService.createOrUpdateConfig(
            OrganizationParametersKey.BYOK_CONFIG,
            swapped,
            organizationAndTeamData,
        );

        return !!result;
    }

    private async saveByokConfig(
        organizationParametersKey: OrganizationParametersKey,
        configValue: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<boolean> {
        const getConfigValue =
            await this.organizationParametersService.findByKey(
                organizationParametersKey,
                organizationAndTeamData,
            );

        const existingConfig = getConfigValue?.configValue as
            | BYOKConfig
            | undefined;

        let processedConfigValue = configValue;
        processedConfigValue = this.encryptByokConfigCredentials(
            configValue,
            existingConfig,
        );

        const mergedConfigValue = {
            ...existingConfig,
            ...processedConfigValue,
        };

        const result =
            await this.organizationParametersService.createOrUpdateConfig(
                organizationParametersKey,
                mergedConfigValue,
                organizationAndTeamData,
            );

        return !!result;
    }

    private extractJwtExpiry(token: string): number {
        try {
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
            if (payload.exp) {
                // JWT exp is in seconds; subtract 1 minute buffer
                return (payload.exp * 1000) - 60_000;
            }
        } catch {
            // Fall through to default
        }
        // Conservative default: 55 minutes
        return Date.now() + 55 * 60 * 1000;
    }

    private extractChatgptAccountId(token: string): string {
        try {
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
            return payload['https://api.openai.com/auth.chatgpt_account_id']
                ?? payload['https://api.openai.com/auth']?.chatgpt_account_id
                ?? payload['https://api.openai.com/auth']?.user_id
                ?? '';
        } catch {
            return '';
        }
    }

    private parseAnthropicCredentialsJson(raw: string): { subscriptionToken: string; refreshToken?: string } {
        try {
            const parsed = JSON.parse(raw);
            const accessToken = parsed?.accessToken;
            const refreshToken = parsed?.refreshToken;
            if (!accessToken) {
                throw new Error('Missing accessToken in credentials JSON');
            }
            return { subscriptionToken: accessToken, refreshToken: refreshToken ?? undefined };
        } catch (e) {
            if (e.message?.includes('accessToken')) throw e;
            throw new Error('Invalid Anthropic credentials JSON');
        }
    }

    private parseOpenAIAuthJson(raw: string): { subscriptionToken: string; refreshToken?: string; accountId?: string } {
        try {
            const parsed = JSON.parse(raw);
            const subscriptionToken = parsed?.tokens?.access_token;
            const refreshToken = parsed?.tokens?.refresh_token;
            const accountId = parsed?.tokens?.account_id;
            if (!subscriptionToken) {
                throw new Error('Missing tokens.access_token in auth.json');
            }
            return { subscriptionToken, refreshToken: refreshToken ?? undefined, accountId: accountId ?? undefined };
        } catch {
            throw new Error('Invalid auth.json content');
        }
    }

    private encryptSubscriptionTokenConfig(
        cfg: NonNullable<BYOKConfig['main']> | NonNullable<BYOKConfig['fallback']>,
    ) {
        if (!cfg.subscriptionToken) {
            throw new Error('subscriptionToken is required when using subscription token credential type');
        }

        const isOpenAI = cfg.provider === BYOKProvider.OPENAI;
        const isAnthropic = cfg.provider === BYOKProvider.ANTHROPIC;

        // If user pasted JSON credentials, extract tokens from it
        let subscriptionToken = cfg.subscriptionToken;
        let refreshToken = cfg.refreshToken;
        let authJsonAccountId: string | undefined;
        if (subscriptionToken.trimStart().startsWith('{')) {
            if (isOpenAI) {
                const extracted = this.parseOpenAIAuthJson(subscriptionToken);
                subscriptionToken = extracted.subscriptionToken;
                refreshToken = extracted.refreshToken ?? refreshToken;
                authJsonAccountId = extracted.accountId;
            } else if (isAnthropic) {
                const extracted = this.parseAnthropicCredentialsJson(subscriptionToken);
                subscriptionToken = extracted.subscriptionToken;
                refreshToken = extracted.refreshToken ?? refreshToken;
            }
        }

        const tokenExpiresAt = isOpenAI
            ? this.extractJwtExpiry(subscriptionToken)
            : Date.now() + 8 * 60 * 60 * 1000;
        const chatgptAccountId = isOpenAI
            ? (authJsonAccountId || this.extractChatgptAccountId(subscriptionToken))
            : undefined;

        return {
            ...cfg,
            subscriptionToken: encrypt(subscriptionToken),
            refreshToken: refreshToken ? encrypt(refreshToken) : undefined,
            tokenExpiresAt,
            ...(chatgptAccountId ? { chatgptAccountId } : {}),
        };
    }

    private encryptByokConfigCredentials(
        configValue: any,
        existingConfig?: BYOKConfig,
    ): BYOKConfig {
        if (!configValue || typeof configValue !== 'object') {
            throw new Error('Invalid BYOK config value');
        }

        const byokConfig = configValue as BYOKConfig;

        if (!byokConfig.main && !byokConfig.fallback) {
            throw new Error('At least main or fallback config is required');
        }

        let encryptedMain = null;
        if (byokConfig.main) {
            const credentialType = byokConfig.main.credentialType ?? 'api_key';
            if (credentialType === 'subscription_token') {
                encryptedMain = this.encryptSubscriptionTokenConfig(byokConfig.main);
            } else {
                if (!byokConfig.main.apiKey && !existingConfig?.main?.apiKey) {
                    throw new Error('apiKey is required for main BYOK config');
                }
                encryptedMain = {
                    ...byokConfig.main,
                    apiKey: byokConfig.main.apiKey
                        ? encrypt(byokConfig.main.apiKey)
                        : existingConfig!.main.apiKey,
                };
            }
        }

        let encryptedFallback = null;
        if (byokConfig.fallback) {
            const credentialType = byokConfig.fallback.credentialType ?? 'api_key';
            if (credentialType === 'subscription_token') {
                encryptedFallback = this.encryptSubscriptionTokenConfig(byokConfig.fallback);
            } else {
                if (
                    !byokConfig.fallback.apiKey &&
                    !existingConfig?.fallback?.apiKey
                ) {
                    throw new Error(
                        'apiKey is required for fallback BYOK config',
                    );
                }
                encryptedFallback = {
                    ...byokConfig.fallback,
                    apiKey: byokConfig.fallback.apiKey
                        ? encrypt(byokConfig.fallback.apiKey)
                        : existingConfig!.fallback!.apiKey,
                };
            }
        }

        return {
            ...(encryptedMain && { main: encryptedMain }),
            ...(encryptedFallback && { fallback: encryptedFallback }),
        };
    }
}
