import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
    ForbiddenException,
    UnauthorizedException,
} from '@nestjs/common';

import { CliReviewController } from '@/core/infrastructure/http/controllers/cli-review.controller';
import { ExecuteCliReviewUseCase } from '@libs/cli-review/application/use-cases/execute-cli-review.use-case';
import { AuthenticatedRateLimiterService } from '@libs/cli-review/infrastructure/services/authenticated-rate-limiter.service';
import { TrialRateLimiterService } from '@libs/cli-review/infrastructure/services/trial-rate-limiter.service';
import {
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import {
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import {
    AUTH_SERVICE_TOKEN,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import {
    CLI_DEVICE_SERVICE_TOKEN,
} from '@libs/organization/domain/cli-device/contracts/cli-device.service.contract';
import { TeamEntity } from '@libs/organization/domain/team/entities/team.entity';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { CliReviewRequestDto } from '@/core/infrastructure/http/dtos/cli-review.dto';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

// ============================================================================
// FIXTURES
// ============================================================================

const ORG_ID = 'org-uuid-1111';
const TEAM_ID = 'team-uuid-2222';
const USER_EMAIL = 'dev@kodus.io';
const DEVICE_ID = 'device-uuid-4444';
const DEVICE_TOKEN = 'raw-device-token-5555';

const JWT_PAYLOAD = {
    email: USER_EMAIL,
    role: 'owner',
    status: STATUS.ACTIVE,
    organizationId: ORG_ID,
    sub: 'user-uuid-3333',
};

const VALID_JWT = 'valid.jwt.token';
const BEARER_JWT = `Bearer ${VALID_JWT}`;

function makeTeamEntity(overrides: { uuid?: string; orgUuid?: string } = {}) {
    return TeamEntity.create({
        uuid: overrides.uuid ?? TEAM_ID,
        name: 'my-team',
        status: STATUS.ACTIVE,
        organization: { uuid: overrides.orgUuid ?? ORG_ID, name: 'my-org' },
        cliConfig: null,
    });
}

const MINIMAL_BODY: CliReviewRequestDto = { diff: 'diff --git a/x b/x\n+const x = 1;' };

// ============================================================================
// MOCKS
// ============================================================================

const mockJwtService = { verify: jest.fn() };
const mockConfigService = {
    get: jest.fn().mockReturnValue({ secret: 'test-secret' }),
};
const mockAuthService = { validateUser: jest.fn() };
const mockTeamService = {
    findById: jest.fn(),
    findFirstCreatedTeam: jest.fn(),
};
const mockTeamCliKeyService = { validateKey: jest.fn() };
const mockRateLimiter = {
    checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
};
const mockTrialRateLimiter = { checkRateLimit: jest.fn() };
const mockExecuteCliReview = {
    execute: jest.fn().mockResolvedValue({ suggestions: [] }),
};
const mockCliDeviceService = {
    validateOrRegisterDevice: jest.fn().mockResolvedValue({}),
};

// ============================================================================
// SUITE
// ============================================================================

describe('CliReviewController', () => {
    let controller: CliReviewController;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CliReviewController,
                { provide: ExecuteCliReviewUseCase, useValue: mockExecuteCliReview },
                { provide: AuthenticatedRateLimiterService, useValue: mockRateLimiter },
                { provide: TrialRateLimiterService, useValue: mockTrialRateLimiter },
                { provide: TEAM_CLI_KEY_SERVICE_TOKEN, useValue: mockTeamCliKeyService },
                { provide: TEAM_SERVICE_TOKEN, useValue: mockTeamService },
                { provide: AUTH_SERVICE_TOKEN, useValue: mockAuthService },
                { provide: CLI_DEVICE_SERVICE_TOKEN, useValue: mockCliDeviceService },
                { provide: JwtService, useValue: mockJwtService },
                { provide: ConfigService, useValue: mockConfigService },
            ],
        }).compile();

        controller = module.get(CliReviewController);

        jest.clearAllMocks();

        // Default happy-path stubs
        mockJwtService.verify.mockReturnValue(JWT_PAYLOAD);
        mockAuthService.validateUser.mockResolvedValue({
            email: USER_EMAIL,
            role: JWT_PAYLOAD.role,
            status: STATUS.ACTIVE,
        });
        mockRateLimiter.checkRateLimit.mockResolvedValue({ allowed: true });
        mockExecuteCliReview.execute.mockResolvedValue({ suggestions: [] });
        mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({});
    });

    // -------------------------------------------------------------------------
    // POST /cli/review — JWT auth (Route 2)
    // -------------------------------------------------------------------------

    describe('POST /cli/review', () => {
        describe('team resolved via findById (correct teamId)', () => {
            it('executes review when teamId matches a team in the org', async () => {
                mockTeamService.findById.mockResolvedValue(makeTeamEntity());

                const result = await controller.review(
                    MINIMAL_BODY,
                    undefined,
                    BEARER_JWT,
                    TEAM_ID,
                );

                expect(mockTeamService.findById).toHaveBeenCalledWith(TEAM_ID);
                expect(mockTeamService.findFirstCreatedTeam).not.toHaveBeenCalled();
                expect(mockExecuteCliReview.execute).toHaveBeenCalledWith(
                    expect.objectContaining({
                        organizationAndTeamData: {
                            organizationId: ORG_ID,
                            teamId: TEAM_ID,
                        },
                    }),
                );
                expect(result).toEqual({ suggestions: [] });
            });
        });

        describe('fallback via findFirstCreatedTeam', () => {
            it('falls back when CLI sends organizationId as teamId (main bug scenario)', async () => {
                mockTeamService.findById.mockResolvedValue(null);
                mockTeamService.findFirstCreatedTeam.mockResolvedValue(makeTeamEntity());

                await controller.review(
                    MINIMAL_BODY,
                    undefined,
                    BEARER_JWT,
                    ORG_ID, // <-- passing org UUID as teamId
                );

                expect(mockTeamService.findById).toHaveBeenCalledWith(ORG_ID);
                expect(mockTeamService.findFirstCreatedTeam).toHaveBeenCalledWith(ORG_ID);
                expect(mockExecuteCliReview.execute).toHaveBeenCalledWith(
                    expect.objectContaining({
                        organizationAndTeamData: {
                            organizationId: ORG_ID,
                            teamId: TEAM_ID,
                        },
                    }),
                );
            });

            it('falls back when no teamId is provided at all', async () => {
                mockTeamService.findFirstCreatedTeam.mockResolvedValue(makeTeamEntity());

                await controller.review(
                    MINIMAL_BODY,
                    undefined,
                    BEARER_JWT,
                    undefined,
                );

                expect(mockTeamService.findById).not.toHaveBeenCalled();
                expect(mockTeamService.findFirstCreatedTeam).toHaveBeenCalledWith(ORG_ID);
                expect(mockExecuteCliReview.execute).toHaveBeenCalled();
            });
        });

        describe('error cases', () => {
            it('throws 401 when no active team found for the org', async () => {
                mockTeamService.findById.mockResolvedValue(null);
                mockTeamService.findFirstCreatedTeam.mockResolvedValue(null);

                await expect(
                    controller.review(MINIMAL_BODY, undefined, BEARER_JWT, TEAM_ID),
                ).rejects.toThrow(UnauthorizedException);
            });

            it('throws 401 when JWT is invalid', async () => {
                mockJwtService.verify.mockImplementation(() => {
                    throw new Error('jwt malformed');
                });

                await expect(
                    controller.review(MINIMAL_BODY, undefined, BEARER_JWT, TEAM_ID),
                ).rejects.toThrow(UnauthorizedException);
            });

            it('throws 401 when user is not found', async () => {
                mockAuthService.validateUser.mockResolvedValue(null);

                await expect(
                    controller.review(MINIMAL_BODY, undefined, BEARER_JWT, TEAM_ID),
                ).rejects.toThrow(UnauthorizedException);
            });

            it('throws 401 when user role has changed', async () => {
                mockAuthService.validateUser.mockResolvedValue({
                    email: USER_EMAIL,
                    role: 'member',
                    status: STATUS.ACTIVE,
                });

                await expect(
                    controller.review(MINIMAL_BODY, undefined, BEARER_JWT, TEAM_ID),
                ).rejects.toThrow(UnauthorizedException);
            });

            it('throws 401 when user account is removed', async () => {
                mockAuthService.validateUser.mockResolvedValue({
                    email: USER_EMAIL,
                    role: JWT_PAYLOAD.role,
                    status: STATUS.REMOVED,
                });

                await expect(
                    controller.review(MINIMAL_BODY, undefined, BEARER_JWT, TEAM_ID),
                ).rejects.toThrow(UnauthorizedException);
            });

            it('throws 403 when team belongs to a different org', async () => {
                mockTeamService.findById.mockResolvedValue(
                    makeTeamEntity({ orgUuid: 'other-org-uuid' }),
                );

                await expect(
                    controller.review(MINIMAL_BODY, undefined, BEARER_JWT, TEAM_ID),
                ).rejects.toThrow(ForbiddenException);
            });

            it('throws 401 when no auth header is provided', async () => {
                await expect(
                    controller.review(MINIMAL_BODY, undefined, undefined, TEAM_ID),
                ).rejects.toThrow(UnauthorizedException);
            });
        });
    });

    // -------------------------------------------------------------------------
    // validateKeyInternal — JWT route
    // -------------------------------------------------------------------------

    describe('validateKeyInternal – JWT route', () => {
        it('returns valid=true with correct teamId resolved via findById', async () => {
            mockTeamService.findById.mockResolvedValue(makeTeamEntity());

            const result = await (controller as any).validateKeyInternal(
                undefined,
                BEARER_JWT,
                TEAM_ID,
            );

            expect(result.valid).toBe(true);
            expect(result.teamId).toBe(TEAM_ID);
            expect(result.organizationId).toBe(ORG_ID);
        });

        it('returns valid=true and resolves team via fallback when CLI sends orgId as teamId', async () => {
            mockTeamService.findById.mockResolvedValue(null);
            mockTeamService.findFirstCreatedTeam.mockResolvedValue(makeTeamEntity());

            const result = await (controller as any).validateKeyInternal(
                undefined,
                BEARER_JWT,
                ORG_ID,
            );

            expect(result.valid).toBe(true);
            expect(result.teamId).toBe(TEAM_ID);
        });

        it('returns valid=false when no active team found', async () => {
            mockTeamService.findById.mockResolvedValue(null);
            mockTeamService.findFirstCreatedTeam.mockResolvedValue(null);

            const result = await (controller as any).validateKeyInternal(
                undefined,
                BEARER_JWT,
                TEAM_ID,
            );

            expect(result.valid).toBe(false);
        });

        it('returns valid=false when JWT is invalid', async () => {
            mockJwtService.verify.mockImplementation(() => {
                throw new Error('jwt expired');
            });

            const result = await (controller as any).validateKeyInternal(
                undefined,
                BEARER_JWT,
                TEAM_ID,
            );

            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/invalid|expired/i);
        });

        it('returns valid=false when team belongs to different org', async () => {
            mockTeamService.findById.mockResolvedValue(
                makeTeamEntity({ orgUuid: 'other-org-uuid' }),
            );

            const result = await (controller as any).validateKeyInternal(
                undefined,
                BEARER_JWT,
                TEAM_ID,
            );

            expect(result.valid).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // Device tracking
    // -------------------------------------------------------------------------

    describe('Device tracking – POST /cli/review', () => {
        beforeEach(() => {
            mockTeamService.findById.mockResolvedValue(makeTeamEntity());
        });

        it('new device receives token in response', async () => {
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({
                deviceToken: 'new-raw-token',
            });

            const result = await controller.review(
                MINIMAL_BODY,
                undefined,
                BEARER_JWT,
                TEAM_ID,
                DEVICE_ID,
                undefined, // no existing token
                'Kodus-CLI/1.0',
            );

            expect(mockCliDeviceService.validateOrRegisterDevice).toHaveBeenCalledWith({
                deviceId: DEVICE_ID,
                deviceToken: undefined,
                organizationId: ORG_ID,
                userAgent: 'Kodus-CLI/1.0',
            });
            expect(result).toEqual(
                expect.objectContaining({ deviceToken: 'new-raw-token' }),
            );
        });

        it('existing device with valid token does not receive token in response', async () => {
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({});

            const result = await controller.review(
                MINIMAL_BODY,
                undefined,
                BEARER_JWT,
                TEAM_ID,
                DEVICE_ID,
                DEVICE_TOKEN,
                'Kodus-CLI/1.0',
            );

            expect(mockCliDeviceService.validateOrRegisterDevice).toHaveBeenCalledWith({
                deviceId: DEVICE_ID,
                deviceToken: DEVICE_TOKEN,
                organizationId: ORG_ID,
                userAgent: 'Kodus-CLI/1.0',
            });
            expect(result).not.toHaveProperty('deviceToken');
        });

        it('existing device with invalid token reissues new token (self-healing)', async () => {
            mockCliDeviceService.validateOrRegisterDevice.mockResolvedValue({
                deviceToken: 'reissued-token',
            });

            const result = await controller.review(
                MINIMAL_BODY,
                undefined,
                BEARER_JWT,
                TEAM_ID,
                DEVICE_ID,
                'wrong-token',
                'Kodus-CLI/1.0',
            );

            expect(mockCliDeviceService.validateOrRegisterDevice).toHaveBeenCalledWith({
                deviceId: DEVICE_ID,
                deviceToken: 'wrong-token',
                organizationId: ORG_ID,
                userAgent: 'Kodus-CLI/1.0',
            });
            expect(result).toEqual(
                expect.objectContaining({ deviceToken: 'reissued-token' }),
            );
        });

        it('no x-kodus-device-id header skips device tracking', async () => {
            const result = await controller.review(
                MINIMAL_BODY,
                undefined,
                BEARER_JWT,
                TEAM_ID,
                undefined, // no deviceId
                undefined,
                undefined,
            );

            expect(mockCliDeviceService.validateOrRegisterDevice).not.toHaveBeenCalled();
            expect(result).toEqual({ suggestions: [] });
        });

        it('device limit reached throws 401 with DEVICE_LIMIT_REACHED code', async () => {
            mockCliDeviceService.validateOrRegisterDevice.mockRejectedValue(
                new UnauthorizedException({
                    message: 'Device limit reached (2). Remove an existing device or increase the limit.',
                    code: 'DEVICE_LIMIT_REACHED',
                    details: { limit: 2, current: 2 },
                }),
            );

            try {
                await controller.review(
                    MINIMAL_BODY,
                    undefined,
                    BEARER_JWT,
                    TEAM_ID,
                    DEVICE_ID,
                    undefined,
                    'Kodus-CLI/1.0',
                );
                fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(UnauthorizedException);
                const response = error.getResponse();
                expect(response.code).toBe('DEVICE_LIMIT_REACHED');
                expect(response.details).toEqual({ limit: 2, current: 2 });
            }
        });
    });
});
