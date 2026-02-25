import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';

import { LoginUseCase } from '@libs/identity/application/use-cases/auth/login.use-case';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import { AuthProvider } from '@libs/core/domain/enums/auth-provider.enum';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

const MOCK_EMAIL = 'kodus@gmail.io';
const MOCK_PASSWORD = 'Kodus@12';
const MOCK_ACCESS_TOKEN = 'mock-access-token';
const MOCK_REFRESH_TOKEN = 'mock-refresh-token';

const MOCK_USER: Partial<IUser> = {
    uuid: 'user-uuid-123',
    email: MOCK_EMAIL,
    password: 'hashed-password',
};

const mockAuthService = {
    validateUser: jest.fn(),
    match: jest.fn(),
    login: jest.fn(),
};

describe('LoginUseCase', () => {
    let loginUseCase: LoginUseCase;
    let authService: IAuthService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                LoginUseCase,
                {
                    provide: AUTH_SERVICE_TOKEN,
                    useValue: mockAuthService,
                },
            ],
        }).compile();

        loginUseCase = module.get<LoginUseCase>(LoginUseCase);
        authService = module.get<IAuthService>(AUTH_SERVICE_TOKEN);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('execute', () => {
        it('should successfully login with valid credentials', async () => {
            // Arrange
            mockAuthService.validateUser.mockResolvedValue(MOCK_USER);
            mockAuthService.match.mockResolvedValue(true);
            mockAuthService.login.mockResolvedValue({
                accessToken: MOCK_ACCESS_TOKEN,
                refreshToken: MOCK_REFRESH_TOKEN,
            });

            // Act
            const result = await loginUseCase.execute(
                MOCK_EMAIL,
                MOCK_PASSWORD,
            );

            // Assert
            expect(result).toEqual({
                accessToken: MOCK_ACCESS_TOKEN,
                refreshToken: MOCK_REFRESH_TOKEN,
            });
            expect(mockAuthService.validateUser).toHaveBeenCalledWith({
                email: MOCK_EMAIL,
            });
            expect(mockAuthService.match).toHaveBeenCalledWith(
                MOCK_PASSWORD,
                MOCK_USER.password,
            );
            expect(mockAuthService.login).toHaveBeenCalledWith(
                MOCK_USER,
                AuthProvider.CREDENTIALS,
            );
        });

        it('should throw UnauthorizedException when user is not found', async () => {
            // Arrange
            mockAuthService.validateUser.mockResolvedValue(null);

            // Act & Assert
            await expect(
                loginUseCase.execute(MOCK_EMAIL, MOCK_PASSWORD),
            ).rejects.toThrow(UnauthorizedException);
            expect(mockAuthService.validateUser).toHaveBeenCalledWith({
                email: MOCK_EMAIL,
            });
            expect(mockAuthService.match).not.toHaveBeenCalled();
            expect(mockAuthService.login).not.toHaveBeenCalled();
        });

        it('should throw UnauthorizedException when password does not match', async () => {
            // Arrange
            mockAuthService.validateUser.mockResolvedValue(MOCK_USER);
            mockAuthService.match.mockResolvedValue(false);

            // Act & Assert
            await expect(
                loginUseCase.execute(MOCK_EMAIL, MOCK_PASSWORD),
            ).rejects.toThrow(UnauthorizedException);
            expect(mockAuthService.validateUser).toHaveBeenCalledWith({
                email: MOCK_EMAIL,
            });
            expect(mockAuthService.match).toHaveBeenCalledWith(
                MOCK_PASSWORD,
                MOCK_USER.password,
            );
            expect(mockAuthService.login).not.toHaveBeenCalled();
        });

        it('should throw UnauthorizedException when validateUser throws an error', async () => {
            // Arrange
            mockAuthService.validateUser.mockRejectedValue(
                new Error('Database error'),
            );

            // Act & Assert
            await expect(
                loginUseCase.execute(MOCK_EMAIL, MOCK_PASSWORD),
            ).rejects.toThrow(UnauthorizedException);
        });
    });
});
