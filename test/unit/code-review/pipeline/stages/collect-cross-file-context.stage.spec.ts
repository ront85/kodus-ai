// Mock e2b before any imports that transitively depend on it
jest.mock('e2b', () => ({
    Sandbox: { create: jest.fn() },
}), { virtual: true });

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { CollectCrossFileContextStage } from '@libs/code-review/pipeline/stages/collect-cross-file-context.stage';
import {
    COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
    CollectCrossFileContextsResult,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { E2BSandboxService } from '@libs/code-review/infrastructure/adapters/services/e2bSandbox.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import {
    createCrossFileBaseContext,
    createSampleSnippet,
} from '../../../../fixtures/cross-file-context.fixtures';

describe('CollectCrossFileContextStage', () => {
    let stage: CollectCrossFileContextStage;

    const mockCollectContexts = jest.fn();
    const mockCollectCrossFileContextsService = {
        collectContexts: mockCollectContexts,
    };

    const mockE2bSandboxService = {
        isAvailable: jest.fn(),
        createSandboxWithRepo: jest.fn(),
    };

    const mockCodeManagementService = {
        getCloneParams: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CollectCrossFileContextStage,
                {
                    provide: COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
                    useValue: mockCollectCrossFileContextsService,
                },
                {
                    provide: E2BSandboxService,
                    useValue: mockE2bSandboxService,
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
            ],
        }).compile();

        stage = module.get<CollectCrossFileContextStage>(
            CollectCrossFileContextStage,
        );
        jest.clearAllMocks();
    });

    // ─── Guards ────────────────────────────────────────────────────────────

    describe('guards', () => {
        it('should return context unchanged when cross_file is disabled', async () => {
            const context = createCrossFileBaseContext({
                codeReviewConfig: {
                    reviewOptions: { cross_file: false },
                } as any,
            });

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockCollectContexts).not.toHaveBeenCalled();
        });

        it('should return context unchanged when changedFiles is empty', async () => {
            const context = createCrossFileBaseContext({
                changedFiles: [],
            });

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockCollectContexts).not.toHaveBeenCalled();
        });

        it('should return context unchanged when E2B is not available', async () => {
            const context = createCrossFileBaseContext();
            mockE2bSandboxService.isAvailable.mockReturnValue(false);

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockCollectContexts).not.toHaveBeenCalled();
        });
    });

    // ─── Happy Path ────────────────────────────────────────────────────────

    describe('happy path', () => {
        const setupHappyPath = () => {
            const mockCleanup = jest.fn().mockResolvedValue(undefined);
            const mockRemoteCommands = {
                grep: jest.fn(),
                read: jest.fn(),
                listDir: jest.fn(),
            };

            mockE2bSandboxService.isAvailable.mockReturnValue(true);
            mockCodeManagementService.getCloneParams.mockResolvedValue({
                url: 'https://github.com/org/repo.git',
                auth: { token: 'test-token' },
            });
            mockE2bSandboxService.createSandboxWithRepo.mockResolvedValue({
                remoteCommands: mockRemoteCommands,
                cleanup: mockCleanup,
            });

            const collectResult: CollectCrossFileContextsResult = {
                contexts: [createSampleSnippet()],
                plannerQueries: [
                    {
                        symbolName: 'greet',
                        pattern: 'greet\\(',
                        rationale: 'test',
                        riskLevel: 'high',
                        fileGlob: '**/*.ts',
                    },
                ],
                totalSearches: 1,
                totalSnippetsBeforeDedup: 2,
            };
            mockCollectContexts.mockResolvedValue(collectResult);

            return { mockCleanup, collectResult };
        };

        it('should execute full flow: getCloneParams → createSandbox → collectContexts → context updated', async () => {
            const { collectResult } = setupHappyPath();
            const context = createCrossFileBaseContext();

            const result = await stage.execute(context);

            expect(
                mockCodeManagementService.getCloneParams,
            ).toHaveBeenCalled();
            expect(
                mockE2bSandboxService.createSandboxWithRepo,
            ).toHaveBeenCalled();
            expect(mockCollectContexts).toHaveBeenCalled();
            expect(result.crossFileContexts).toEqual(collectResult);
        });

        it('should call cleanup() after success', async () => {
            const { mockCleanup } = setupHappyPath();
            const context = createCrossFileBaseContext();

            await stage.execute(context);

            expect(mockCleanup).toHaveBeenCalledTimes(1);
        });
    });

    // ─── Error Handling ────────────────────────────────────────────────────

    describe('error handling', () => {
        const setupWithError = () => {
            const mockCleanup = jest.fn().mockResolvedValue(undefined);

            mockE2bSandboxService.isAvailable.mockReturnValue(true);
            mockCodeManagementService.getCloneParams.mockResolvedValue({
                url: 'https://github.com/org/repo.git',
                auth: { token: 'test-token' },
            });
            mockE2bSandboxService.createSandboxWithRepo.mockResolvedValue({
                remoteCommands: {
                    grep: jest.fn(),
                    read: jest.fn(),
                    listDir: jest.fn(),
                },
                cleanup: mockCleanup,
            });

            return { mockCleanup };
        };

        it('should return context unchanged on collectContexts error (non-fatal)', async () => {
            const { mockCleanup } = setupWithError();
            mockCollectContexts.mockRejectedValue(
                new Error('collectContexts failed'),
            );

            const context = createCrossFileBaseContext();
            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockCleanup).toHaveBeenCalled();
        });

        it('should propagate cleanup failure (cleanup is expected to be safe via E2B wrapper)', async () => {
            mockE2bSandboxService.isAvailable.mockReturnValue(true);
            mockCodeManagementService.getCloneParams.mockResolvedValue({
                url: 'https://github.com/org/repo.git',
                auth: { token: 'test-token' },
            });

            const failingCleanup = jest
                .fn()
                .mockRejectedValue(new Error('cleanup exploded'));
            mockE2bSandboxService.createSandboxWithRepo.mockResolvedValue({
                remoteCommands: {
                    grep: jest.fn(),
                    read: jest.fn(),
                    listDir: jest.fn(),
                },
                cleanup: failingCleanup,
            });
            mockCollectContexts.mockRejectedValue(
                new Error('some error'),
            );

            const context = createCrossFileBaseContext();

            // cleanup failure propagates because the finally block doesn't wrap it in try/catch
            // In production, E2BSandboxService.cleanup() already catches errors internally
            await expect(stage.execute(context)).rejects.toThrow(
                'cleanup exploded',
            );
        });
    });
});
