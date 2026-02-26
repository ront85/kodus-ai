import { Test, TestingModule } from '@nestjs/testing';
import { REQUEST } from '@nestjs/core';
import { CreateIntegrationUseCase } from '@libs/platform/application/use-cases/codeManagement/create-integration.use-case';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { AUTH_INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { IgnoreBotsUseCase } from '@libs/organization/application/use-cases/organizationParameters';
import { CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN } from '@libs/ee/codeReviewSettingsLog/domain/contracts/codeReviewSettingsLog.service.contract';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

describe('CreateIntegrationUseCase', () => {
    let useCase: CreateIntegrationUseCase;
    let mockCodeManagementService: any;
    let mockAuthIntegrationService: any;
    let mockCodeReviewSettingsLogService: any;
    let MockIgnoreBotsUseCase: any;
    let mockRequest: any;

    beforeEach(async () => {
        mockCodeManagementService = {
            createAuthIntegration: jest.fn(),
        };

        mockAuthIntegrationService = {
            findOne: jest.fn(),
        };

        mockCodeReviewSettingsLogService = {
            registerIntegrationLog: jest.fn(),
        };

        MockIgnoreBotsUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };

        mockRequest = {
            user: {
                organization: { uuid: 'org-uuid-123' },
                uuid: 'user-uuid-123',
                email: 'user@test.com',
            },
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CreateIntegrationUseCase,
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
                {
                    provide: AUTH_INTEGRATION_SERVICE_TOKEN,
                    useValue: mockAuthIntegrationService,
                },
                {
                    provide: CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN,
                    useValue: mockCodeReviewSettingsLogService,
                },
                { provide: IgnoreBotsUseCase, useValue: MockIgnoreBotsUseCase },
                { provide: REQUEST, useValue: mockRequest },
            ],
        }).compile();

        useCase = module.get<CreateIntegrationUseCase>(
            CreateIntegrationUseCase,
        );
    });

    // testa a integração via token pelo github
    it('should create Github integration with token', async () => {
        const mockResult = {
            success: true,
            status: 'Integration Github Create with Success',
        };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(
            mockResult,
        );
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integrattion-uuid',
        });

        const result = await useCase.execute({
            integrationType: PlatformType.GITHUB,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });

        expect(
            mockCodeManagementService.createAuthIntegration,
        ).toHaveBeenLastCalledWith(
            expect.objectContaining({
                integrationType: PlatformType.GITHUB,
                authMode: AuthMode.TOKEN,
                token: 'ghp_test_token',
            }),
            PlatformType.GITHUB,
        );
        expect(result).toEqual(mockResult);
    });

    // testa a integração via auth pelo github
    it('should use OAuth as default authMode when not provided', async () => {
        const mockResult = { success: true, status: 'Integration Github Create with OAuth' };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(mockResult);
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth.integrattion-uuid',
        });

        const result = await useCase.execute({
            integrationType: PlatformType.GITHUB,
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });

        expect(mockCodeManagementService.createAuthIntegration).toHaveBeenLastCalledWith(
            expect.objectContaining({
                integrationType: PlatformType.GITHUB,
                authMode: AuthMode.OAUTH,
            }),
            PlatformType.GITHUB,
        );
        expect(result).toEqual(mockResult);
    });

    // testa a integração via organizationId pelo github
    it('should use organizationId from request when not providend in params', async () => {
        const mockResult = {
            success: true,
            status: 'Integration Github Create with Success'
        };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(mockResult);
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integration-uuid',
        });

        const result = await useCase.execute({
            integrationType: PlatformType.GITHUB,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
        });
        expect(mockCodeManagementService.createAuthIntegration).toHaveBeenLastCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-uuid-123',
                    teamId: undefined,
                },
            }),
            PlatformType.GITHUB,
        );
        expect(result).toEqual(mockResult)
    })

    it('should handle error when ignoreBotsUseCase fails', async () => {
        const mockResult = { success: true, status: 'Integration Github Create with Success' };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(mockResult);
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integrattion-uuid',
        });
        MockIgnoreBotsUseCase.execute.mockRejectedValue(new Error('bot ignore failed'));

        const result = await useCase.execute({
            integrationType: PlatformType.GITHUB,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });
        expect(result).toEqual(mockResult);
    });





    // testa a integração via token pelo gitlab
    it('should create Gitlab integration with token', async () => {
        const mockResult = {
            success: true,
            status: 'Integration Gitlab Create with Success',
        };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(
            mockResult,
        );
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integration-uuid',
        });

        const result = await useCase.execute({
            integrationType: PlatformType.GITLAB,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });

        expect(
            mockCodeManagementService.createAuthIntegration,
        ).toHaveBeenLastCalledWith(
            expect.objectContaining({
                integrationType: PlatformType.GITLAB,
                authMode: AuthMode.TOKEN,
                token: 'ghp_test_token',
            }),
            PlatformType.GITLAB,
        );
        expect(result).toEqual(mockResult);
    });

    // testa a integração via auth pelo gilab
    it('should use OAuth as default authMode when not provided', async () => {
        const mockResult = { success: true, status: 'Integration Gitlab Create with OAuth' };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(mockResult);
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth.integrattion-uuid',
        });

        const result = await useCase.execute({
            integrationType: PlatformType.GITLAB,
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });

        expect(mockCodeManagementService.createAuthIntegration).toHaveBeenLastCalledWith(
            expect.objectContaining({
                integrationType: PlatformType.GITLAB,
                authMode: AuthMode.OAUTH,
            }),
            PlatformType.GITLAB,
        );
        expect(result).toEqual(mockResult);
    });

    // testa a integração via organizationId pelo gitlab
    it('should use organizationId from request when not providend in params', async () => {
        const mockResult = {
            success: true,
            status: 'Integration Gitlab Create with Success'
        };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(mockResult);
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integration-uuid',
        });

        const result = await useCase.execute({
            integrationType: PlatformType.GITLAB,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
        });
        expect(mockCodeManagementService.createAuthIntegration).toHaveBeenLastCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-uuid-123',
                    teamId: undefined,
                },
            }),
            PlatformType.GITLAB,
        );
        expect(result).toEqual(mockResult)
    });

    it('should handle error when ignoreBotsUseCase fails', async () => {
        const mockResult = { success: true, status: 'Integration Gitlab Create with Success' };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(mockResult);
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integrattion-uuid',
        });
        MockIgnoreBotsUseCase.execute.mockRejectedValue(new Error('bot ignore failed'));

        const result = await useCase.execute({
            integrationType: PlatformType.GITLAB,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });
        expect(result).toEqual(mockResult);
    });






    // testa a integração via token pelo bitbucket
    it('should create Bitbucket integration with token', async () => {
        const mockResult = {
            success: true,
            status: 'Integration BitBucket Create with Success',
        };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(
            mockResult,
        );
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integration-uuid',
        });

        const result = await useCase.execute({
            integrationType: PlatformType.BITBUCKET,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });

        expect(
            mockCodeManagementService.createAuthIntegration,
        ).toHaveBeenLastCalledWith(
            expect.objectContaining({
                integrationType: PlatformType.BITBUCKET,
                authMode: AuthMode.TOKEN,
                token: 'ghp_test_token',
            }),
            PlatformType.BITBUCKET,
        );
        expect(result).toEqual(mockResult);
    });

    it('should handle error when ignoreBotsUseCase fails', async () => {
        const mockResult = { success: true, status: 'Integration Github Create with Success' };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(mockResult);
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integrattion-uuid',
        });
        MockIgnoreBotsUseCase.execute.mockRejectedValue(new Error('bot ignore failed'));

        const result = await useCase.execute({
            integrationType: PlatformType.BITBUCKET,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });
        expect(result).toEqual(mockResult);
    });





    // testa a integração via token pelo azure repos
    it('should create Azure Repos integration with token', async () => {
        const mockResult = {
            success: true,
            status: 'Integration Azure Repos Create with Success',
        };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(
            mockResult,
        );
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integration-uuid',
        });

        const result = await useCase.execute({
            integrationType: PlatformType.AZURE_REPOS,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });

        expect(
            mockCodeManagementService.createAuthIntegration,
        ).toHaveBeenLastCalledWith(
            expect.objectContaining({
                integrationType: PlatformType.AZURE_REPOS,
                authMode: AuthMode.TOKEN,
                token: 'ghp_test_token',
            }),
            PlatformType.AZURE_REPOS,
        );
        expect(result).toEqual(mockResult);
    });

    it('should handle error when ignoreBotsUseCase fails', async () => {
        const mockResult = { success: true, status: 'Integration Github Create with Success' };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(mockResult);
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integrattion-uuid',
        });
        MockIgnoreBotsUseCase.execute.mockRejectedValue(new Error('bot ignore failed'));

        const result = await useCase.execute({
            integrationType: PlatformType.AZURE_REPOS,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });
        expect(result).toEqual(mockResult);
    });






    // testa a integração via token pelo forjeto
    it('should create Forgejo integration with token', async () => {
        const mockResult = {
            success: true,
            status: 'Integration Forgejo Create with Success',
        };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(
            mockResult,
        );
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integration-uuid',
        });

        const result = await useCase.execute({
            integrationType: PlatformType.FORGEJO,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });

        expect(
            mockCodeManagementService.createAuthIntegration,
        ).toHaveBeenLastCalledWith(
            expect.objectContaining({
                integrationType: PlatformType.FORGEJO,
                authMode: AuthMode.TOKEN,
                token: 'ghp_test_token',
            }),
            PlatformType.FORGEJO,
        );
        expect(result).toEqual(mockResult);
    });

    it('should handle error when ignoreBotsUseCase fails', async () => {
        const mockResult = { success: true, status: 'Integration Github Create with Success' };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(mockResult);
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integrattion-uuid',
        });
        MockIgnoreBotsUseCase.execute.mockRejectedValue(new Error('bot ignore failed'));

        const result = await useCase.execute({
            integrationType: PlatformType.FORGEJO,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });
        expect(result).toEqual(mockResult);
    });



    it('should handle error when registerIntegrationLog fails', async () => {
        const mockResult = { success: true, status: 'Integration Github Create with Success' };
        mockCodeManagementService.createAuthIntegration.mockResolvedValue(mockResult);
        mockAuthIntegrationService.findOne.mockResolvedValue({
            uuid: 'auth-integration-uuid',
        });
        mockCodeReviewSettingsLogService.registerIntegrationLog.mockRejectedValue(new Error('Log failed'));
        
        const result = await useCase.execute({
            integrationType: PlatformType.GITHUB,
            authMode: AuthMode.TOKEN,
            token: 'ghp_test_token',
            organizationAndTeamData: { teamId: 'team-uuid-123' },
        });
        expect(result).toEqual(mockResult);
    });

});
