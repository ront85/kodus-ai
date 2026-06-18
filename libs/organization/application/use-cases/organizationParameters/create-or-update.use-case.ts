import {
    BYOKConfig,
    BYOKCredentialType,
    BYOKProvider,
} from '@kodus/kodus-common/llm';
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
import { REQUEST } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

const AUDITABLE_KEYS = new Set([
    OrganizationParametersKey.AUTO_JOIN_CONFIG,
    OrganizationParametersKey.TIMEZONE_CONFIG,
    OrganizationParametersKey.COCKPIT_METRICS_VISIBILITY,
]);

@Injectable()
export class CreateOrUpdateOrganizationParametersUseCase implements IUseCase {
    private readonly logger = createLogger(
        CreateOrUpdateOrganizationParametersUseCase.name,
    );
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,

        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly eventEmitter: EventEmitter2,
        private readonly telemetry: TelemetryService,
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

            let previousValue: any = null;
            if (AUDITABLE_KEYS.has(organizationParametersKey)) {
                const existing =
                    await this.organizationParametersService.findByKey(
                        organizationParametersKey,
                        organizationAndTeamData,
                    );
                previousValue = existing?.configValue ?? null;
            }

            const result =
                await this.organizationParametersService.createOrUpdateConfig(
                    organizationParametersKey,
                    processedConfigValue,
                    organizationAndTeamData,
                );

            if (AUDITABLE_KEYS.has(organizationParametersKey)) {
                this.eventEmitter.emit(AuditLogEvents.ORG_SETTINGS, {
                    organizationAndTeamData,
                    userInfo: {
                        userId: this.request.user?.uuid,
                        userEmail: this.request.user?.email,
                    },
                    actionType: ActionType.EDIT,
                    settingKey: organizationParametersKey,
                    previousValue,
                    currentValue: processedConfigValue,
                });
            }

            return result;
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
                { cause: error },
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

        const processedConfigValue = this.encryptByokConfigApiKey(
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

        this.eventEmitter.emit(AuditLogEvents.ORG_SETTINGS, {
            organizationAndTeamData,
            userInfo: {
                userId: this.request.user?.uuid,
                userEmail: this.request.user?.email,
            },
            actionType: ActionType.EDIT,
            settingKey: organizationParametersKey,
            previousValue: existingConfig ?? null,
            currentValue: mergedConfigValue,
        });

        if (result && this.request.user?.uuid) {
            void this.telemetry.byokConfigured({
                userId: this.request.user.uuid,
                organizationId: organizationAndTeamData.organizationId,
                provider:
                    mergedConfigValue.main?.provider ??
                    mergedConfigValue.fallback?.provider,
                slot: mergedConfigValue.main ? 'main' : 'fallback',
            });
        }

        return !!result;
    }

    private encryptByokConfigApiKey(
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

        const encryptedMain = byokConfig.main
            ? this.encryptSlot('main', byokConfig.main, existingConfig?.main)
            : null;

        const encryptedFallback = byokConfig.fallback
            ? this.encryptSlot(
                  'fallback',
                  byokConfig.fallback,
                  existingConfig?.fallback,
              )
            : null;

        return {
            ...(encryptedMain && { main: encryptedMain }),
            ...(encryptedFallback && { fallback: encryptedFallback }),
        };
    }

    /**
     * Encrypt the sensitive credential fields for a single BYOK slot
     * (main or fallback). Bedrock uses AWS auth fields instead of a
     * single apiKey; everything else uses apiKey. In both cases, an
     * empty incoming field falls back to whatever is already persisted
     * — so partial edits (e.g. changing only the model) don't require
     * the user to re-enter their credentials.
     */
    private encryptSlot(
        slot: 'main' | 'fallback',
        next: BYOKConfig['main'],
        existing?: BYOKConfig['main'],
    ): BYOKConfig['main'] {
        // Subscription-token credential type (Claude OAuth / OpenAI Codex
        // auth.json). These carry a bearer subscriptionToken (+ optional
        // refreshToken) instead of an apiKey; tokens may be pasted as raw
        // strings or as the full credentials JSON file.
        if (next.credentialType === BYOKCredentialType.SUBSCRIPTION_TOKEN) {
            return this.encryptSubscriptionTokenConfig(next);
        }

        if (next.provider === BYOKProvider.AMAZON_BEDROCK) {
            // Bedrock has two auth paths and the user only needs to
            // satisfy one: bearer token (recommended) OR static IAM
            // credentials (awsAccessKeyId + awsSecretAccessKey, with
            // optional awsSessionToken). On edit we accept either path
            // being satisfied by previously-persisted values.
            const hasBearer =
                !!next.awsBearerToken?.trim() || !!existing?.awsBearerToken;
            const hasIam =
                (!!next.awsAccessKeyId?.trim() ||
                    !!existing?.awsAccessKeyId) &&
                (!!next.awsSecretAccessKey?.trim() ||
                    !!existing?.awsSecretAccessKey);

            if (!hasBearer && !hasIam) {
                throw new Error(
                    `Bedrock ${slot} BYOK config requires either awsBearerToken or awsAccessKeyId + awsSecretAccessKey`,
                );
            }

            return {
                ...next,
                awsBearerToken: this.encryptOrKeep(
                    next.awsBearerToken,
                    existing?.awsBearerToken,
                ),
                awsAccessKeyId: this.encryptOrKeep(
                    next.awsAccessKeyId,
                    existing?.awsAccessKeyId,
                ),
                awsSecretAccessKey: this.encryptOrKeep(
                    next.awsSecretAccessKey,
                    existing?.awsSecretAccessKey,
                ),
                awsSessionToken: this.encryptOrKeep(
                    next.awsSessionToken,
                    existing?.awsSessionToken,
                ),
            };
        }

        if (!next.apiKey && !existing?.apiKey) {
            throw new Error(`apiKey is required for ${slot} BYOK config`);
        }

        return {
            ...next,
            apiKey: next.apiKey ? encrypt(next.apiKey) : existing!.apiKey,
        };
    }

    private encryptOrKeep(
        incoming: string | undefined,
        existing: string | undefined,
    ): string | undefined {
        const trimmed = incoming?.trim();
        if (trimmed) return encrypt(trimmed);
        return existing;
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
            // Support ~/.claude/.credentials.json format: { "claudeAiOauth": { "accessToken": "...", "refreshToken": "..." } }
            const oauthBlock = parsed?.claudeAiOauth ?? parsed;
            const accessToken = oauthBlock?.accessToken;
            const refreshToken = oauthBlock?.refreshToken;
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
}
