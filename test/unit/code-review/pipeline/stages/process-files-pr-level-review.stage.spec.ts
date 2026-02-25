import { ProcessFilesPrLevelReviewStage } from '@/code-review/pipeline/stages/process-files-pr-level-review.stage';
import posthog, { FEATURE_FLAGS } from '@libs/common/utils/posthog';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
    createThreadId: jest.fn(),
}));

jest.mock('@libs/common/utils/posthog', () => ({
    __esModule: true,
    default: {
        isFeatureEnabled: jest.fn(),
    },
    FEATURE_FLAGS: {
        businessLogic: 'business-logic',
    },
}));

describe('ProcessFilesPrLevelReviewStage', () => {
    let stage: ProcessFilesPrLevelReviewStage;

    beforeEach(() => {
        stage = new ProcessFilesPrLevelReviewStage(
            {} as any,
            {} as any,
            {} as any,
        );
        jest.clearAllMocks();
    });

    it('should skip business logic validation when feature flag is disabled', async () => {
        (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(false);

        const context = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            codeReviewConfig: {
                reviewOptions: {
                    business_logic: true,
                },
            },
            pullRequest: {
                number: 42,
                body: 'Implements ACME-123 with acceptance criteria updates',
            },
        } as any;

        const shouldRun = await (stage as any).shouldRunBusinessLogicValidation(
            context,
        );

        expect(shouldRun).toBe(false);
        expect(posthog.isFeatureEnabled).toHaveBeenCalledWith(
            FEATURE_FLAGS.businessLogic,
            'org-1',
            context.organizationAndTeamData,
        );
    });

    it('should run business logic validation when feature flag is enabled and signals exist', async () => {
        (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);

        const context = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            codeReviewConfig: {
                reviewOptions: {
                    business_logic: true,
                },
            },
            pullRequest: {
                number: 42,
                body: 'Implements ACME-123 with acceptance criteria updates',
            },
            pipelineMetadata: {},
        } as any;

        const shouldRun = await (stage as any).shouldRunBusinessLogicValidation(
            context,
        );

        expect(shouldRun).toBe(true);
    });
});

