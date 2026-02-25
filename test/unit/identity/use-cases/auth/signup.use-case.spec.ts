import { Test, TestingModule } from '@nestjs/testing';

import { SignUpUseCase } from '@libs/identity/application/use-cases/auth/signup.use-case';
import { DuplicateRecordException } from '@libs/core/infrastructure/filters/duplicate-record.exception';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    USER_SERVICE_TOKEN,
    IUsersService,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import {
    ORGANIZATION_SERVICE_TOKEN,
    IOrganizationService,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';
import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import {
    TEAM_MEMBERS_SERVICE_TOKEN,
    ITeamMemberService,
} from '@libs/organization/domain/teamMembers/contracts/teamMembers.service.contracts';
import { CreateProfileUseCase } from '@libs/identity/application/use-cases/profile/create.use-case';
import { CreateTeamUseCase } from '@libs/organization/application/use-cases/team/create.use-case';
import { SignUpDTO } from '@libs/identity/dtos/create-user-organization.dto';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

jest.mock('@libs/common/utils/posthog', () => ({
    organizationIdentify: jest.fn(),
    userIdentify: jest.fn(),
    teamIdentify: jest.fn(),
}));

jest.mock('@libs/common/utils/segment', () => ({
    identify: jest.fn(),
    track: jest.fn(),
}));


const MOCK_EMAIL = 'kodus@gmail.io';
const MOCK_PASSWORD = 'Kodus@12';
const MOCK_NAME = 'Test login';
const MOCK_ORG_NAME = 'Test Organization';

const MOCK_USER_UUID = 'user-uuid-123';
const MOCK_ORG_UUID = 'org-uuid-456';
const MOCK_TEAM_UUID = 'team-uuid-789';

const MOCK_USER = {
    uuid: MOCK_USER_UUID,
    email: MOCK_EMAIL,
    password: MOCK_PASSWORD,
    role: Role.OWNER,
    status: STATUS.ACTIVE,
    organization: {
        uuid: MOCK_ORG_UUID,
        name: MOCK_ORG_NAME,
    },
    toObject: function () {
        return {
            uuid: this.uuid,
            email: this.email,
            role: this.role,
            status: this.status,
            organization: this.organization,
        };
    },
};

const MOCK_ORGANIZATION = {
    uuid: MOCK_ORG_UUID,
    name: MOCK_ORG_NAME,
    tenantName: 'test-org',
    status: STATUS.ACTIVE,
};

const MOCK_TEAM = {
    uuid: MOCK_TEAM_UUID,
    name: `${MOCK_NAME} - team`,
    organization: MOCK_ORGANIZATION,
    status: STATUS.ACTIVE,
};

const mockUsersService = {
    register: jest.fn(),
    count: jest.fn(),
};

const mockOrganizationService = {
    findOne: jest.fn(),
    createOrganizationWithTenant: jest.fn(),
};

const mockTeamService = {
    findOne: jest.fn(),
};

const mockTeamMembersService = {
    create: jest.fn(),
};

const mockCreateProfileUseCase = {
    execute: jest.fn(),
};

const mockCreateTeamUseCase = {
    execute: jest.fn(),
};



describe('SignUpUseCase', () => {
    let signUpUseCase: SignUpUseCase;
    let usersService: IUsersService;
    let organizationService: IOrganizationService;
    let teamService: ITeamService;
    let teamMembersService: ITeamMemberService;
    let createProfileUseCase: CreateProfileUseCase;
    let createTeamUseCase: CreateTeamUseCase;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SignUpUseCase,
                {
                    provide: USER_SERVICE_TOKEN,
                    useValue: mockUsersService,
                },
                {
                    provide: ORGANIZATION_SERVICE_TOKEN,
                    useValue: mockOrganizationService,
                },
                {
                    provide: TEAM_SERVICE_TOKEN,
                    useValue: mockTeamService,
                },
                {
                    provide: TEAM_MEMBERS_SERVICE_TOKEN,
                    useValue: mockTeamMembersService,
                },
                {
                    provide: CreateProfileUseCase,
                    useValue: mockCreateProfileUseCase,
                },
                {
                    provide: CreateTeamUseCase,
                    useValue: mockCreateTeamUseCase,
                },
            ],
        }).compile();

        signUpUseCase = module.get<SignUpUseCase>(SignUpUseCase);
        usersService = module.get<IUsersService>(USER_SERVICE_TOKEN);
        organizationService = module.get<IOrganizationService>(
            ORGANIZATION_SERVICE_TOKEN,
        );
        teamService = module.get<ITeamService>(TEAM_SERVICE_TOKEN);
        teamMembersService = module.get<ITeamMemberService>(
            TEAM_MEMBERS_SERVICE_TOKEN,
        );
        createProfileUseCase =
            module.get<CreateProfileUseCase>(CreateProfileUseCase);
        createTeamUseCase = module.get<CreateTeamUseCase>(CreateTeamUseCase);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('execute', () => {
        it('should successfully create a new user, organization, and team', async () => {
            // Arrange
            const signUpPayload: SignUpDTO = {
                email: MOCK_EMAIL,
                password: MOCK_PASSWORD,
                name: MOCK_NAME,
            };

            mockUsersService.count.mockResolvedValue(0);
            mockOrganizationService.findOne.mockResolvedValue(null);
            mockOrganizationService.createOrganizationWithTenant.mockResolvedValue(
                MOCK_ORGANIZATION,
            );
            mockUsersService.register.mockResolvedValue(MOCK_USER);
            mockCreateProfileUseCase.execute.mockResolvedValue({});
            mockCreateTeamUseCase.execute.mockResolvedValue(MOCK_TEAM);
            mockTeamMembersService.create.mockResolvedValue({});
            mockTeamService.findOne.mockResolvedValue(null);

            // Act
            const result = await signUpUseCase.execute(signUpPayload);

            // Assert
            expect(result).toBeDefined();
            expect(result.uuid).toBe(MOCK_USER_UUID);
            expect(mockUsersService.count).toHaveBeenCalledWith({
                email: MOCK_EMAIL,
            });
            expect(
                mockOrganizationService.createOrganizationWithTenant,
            ).toHaveBeenCalled();
            expect(mockUsersService.register).toHaveBeenCalled();
            expect(mockCreateProfileUseCase.execute).toHaveBeenCalledWith({
                user: { uuid: MOCK_USER_UUID },
                name: MOCK_NAME,
            });
            expect(mockCreateTeamUseCase.execute).toHaveBeenCalledWith({
                teamName: `${MOCK_NAME} - team`,
                organizationId: MOCK_ORG_UUID,
            });
            expect(mockTeamMembersService.create).toHaveBeenCalled();
        });

        it('should throw DuplicateRecordException when email already exists', async () => {
            // Arrange
            const signUpPayload: SignUpDTO = {
                email: MOCK_EMAIL,
                password: MOCK_PASSWORD,
                name: MOCK_NAME,
            };

            mockUsersService.count.mockResolvedValue(1);

            // Act & Assert
            await expect(signUpUseCase.execute(signUpPayload)).rejects.toThrow(
                DuplicateRecordException,
            );
            expect(mockUsersService.count).toHaveBeenCalledWith({
                email: MOCK_EMAIL,
            });
            expect(
                mockOrganizationService.createOrganizationWithTenant,
            ).not.toHaveBeenCalled();
            expect(mockUsersService.register).not.toHaveBeenCalled();
        });

        it('should add user to existing organization when organizationId is provided', async () => {
            // Arrange
            const signUpPayload: SignUpDTO = {
                email: MOCK_EMAIL,
                password: MOCK_PASSWORD,
                name: MOCK_NAME,
                organizationId: MOCK_ORG_UUID,
            };

            mockUsersService.count.mockResolvedValue(0);
            mockOrganizationService.findOne.mockResolvedValue(
                MOCK_ORGANIZATION,
            );
            mockUsersService.register.mockResolvedValue(MOCK_USER);
            mockCreateProfileUseCase.execute.mockResolvedValue({});
            mockTeamService.findOne.mockResolvedValue(MOCK_TEAM);
            mockTeamMembersService.create.mockResolvedValue({});

            // Act
            const result = await signUpUseCase.execute(signUpPayload);

            // Assert
            expect(result).toBeDefined();
            expect(mockOrganizationService.findOne).toHaveBeenCalledWith({
                uuid: MOCK_ORG_UUID,
            });
            expect(
                mockOrganizationService.createOrganizationWithTenant,
            ).not.toHaveBeenCalled();
            expect(mockUsersService.register).toHaveBeenCalled();
        });

        it('should throw error when team creation fails for owner', async () => {
            // Arrange
            const signUpPayload: SignUpDTO = {
                email: MOCK_EMAIL,
                password: MOCK_PASSWORD,
                name: MOCK_NAME,
            };

            mockUsersService.count.mockResolvedValue(0);
            mockOrganizationService.findOne.mockResolvedValue(null);
            mockOrganizationService.createOrganizationWithTenant.mockResolvedValue(
                MOCK_ORGANIZATION,
            );
            mockUsersService.register.mockResolvedValue(MOCK_USER);
            mockCreateProfileUseCase.execute.mockResolvedValue({});
            mockCreateTeamUseCase.execute.mockResolvedValue(null);

            // Act & Assert
            await expect(signUpUseCase.execute(signUpPayload)).rejects.toThrow(
                'Team creation failed',
            );
        });
    });
});
