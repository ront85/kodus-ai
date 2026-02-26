import { decrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@kodus/flow';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersEntity } from '@libs/organization/domain/organizationParameters/entities/organizationParameters.entity';
import { IOrganizationParameters } from '@libs/organization/domain/organizationParameters/interfaces/organizationParameters.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class FindByKeyOrganizationParametersUseCase implements IUseCase {
    private readonly logger = createLogger(
        FindByKeyOrganizationParametersUseCase.name,
    );
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async execute(
        organizationParametersKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IOrganizationParameters | null> {
        try {
            const parameter =
                await this.organizationParametersService.findByKey(
                    organizationParametersKey,
                    organizationAndTeamData,
                );

            if (!parameter) {
                return null;
            }

            // Process BYOK configuration by masking credentials
            if (
                organizationParametersKey ===
                OrganizationParametersKey.BYOK_CONFIG
            ) {
                const configValue = parameter.configValue;

                const hasMainCredential =
                    configValue?.main?.apiKey ||
                    configValue?.main?.subscriptionToken;
                const hasFallbackCredential =
                    configValue?.fallback?.apiKey ||
                    configValue?.fallback?.subscriptionToken;

                if (
                    configValue &&
                    typeof configValue === 'object' &&
                    (hasMainCredential || hasFallbackCredential)
                ) {
                    try {
                        const processedConfig = { ...configValue };

                        if (configValue.main) {
                            processedConfig.main = {
                                ...configValue.main,
                                ...(configValue.main.apiKey
                                    ? {
                                          apiKey: this.maskApiKey(
                                              decrypt(configValue.main.apiKey),
                                          ),
                                      }
                                    : {}),
                                ...(configValue.main.subscriptionToken
                                    ? { subscriptionToken: undefined }
                                    : {}),
                            };
                        }

                        if (configValue.fallback) {
                            processedConfig.fallback = {
                                ...configValue.fallback,
                                ...(configValue.fallback.apiKey
                                    ? {
                                          apiKey: this.maskApiKey(
                                              decrypt(
                                                  configValue.fallback.apiKey,
                                              ),
                                          ),
                                      }
                                    : {}),
                                ...(configValue.fallback.subscriptionToken
                                    ? { subscriptionToken: undefined }
                                    : {}),
                            };
                        }

                        return {
                            uuid: parameter.uuid,
                            configKey: parameter.configKey,
                            configValue: processedConfig,
                            organization: parameter.organization,
                        };
                    } catch (error) {
                        this.logger.error({
                            message: 'Error decrypting credential',
                            context:
                                FindByKeyOrganizationParametersUseCase.name,
                            error: error,
                        });
                        // Return original value in case of decryption error
                        return this.getUpdatedParameters(parameter);
                    }
                }
            }

            const updatedParameters = this.getUpdatedParameters(parameter);

            return updatedParameters;
        } catch (error) {
            this.logger.error({
                message: 'Error finding organization parameters by key',
                context: FindByKeyOrganizationParametersUseCase.name,
                error: error,
                metadata: {
                    organizationParametersKey,
                    organizationAndTeamData,
                },
            });

            throw error;
        }
    }

    private getUpdatedParameters(parameter: OrganizationParametersEntity) {
        return {
            uuid: parameter.uuid,
            configKey: parameter.configKey,
            configValue: parameter.configValue,
            organization: parameter.organization,
        };
    }

    private maskApiKey(apiKey: string): string {
        if (apiKey.length <= 6) {
            return apiKey;
        }
        const firstTwo = apiKey.substring(0, 2);
        const lastThree = apiKey.substring(apiKey.length - 3);
        return `${firstTwo}...${lastThree}`;
    }
}
