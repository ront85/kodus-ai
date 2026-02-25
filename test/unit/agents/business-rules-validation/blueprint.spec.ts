import { createBusinessRulesBlueprint } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/blueprint';
import { BusinessRulesContext } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/types';

describe('business-rules blueprint', () => {
    it('executes deterministic context preparation steps before analyzer', async () => {
        const fetcher = {
            callTool: jest.fn().mockImplementation((toolName: string) => {
                if (toolName === 'KODUS_GET_PULL_REQUEST') {
                    return Promise.resolve({
                        result: {
                            result: {
                                success: true,
                                data: { body: 'PR body from tool' },
                            },
                        },
                    });
                }

                return Promise.resolve({
                    result: { result: { success: true, data: 'diff content' } },
                });
            }),
            callAgent: jest.fn(),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([
                    { name: 'KODUS_GET_PULL_REQUEST' },
                    { name: 'KODUS_GET_PULL_REQUEST_DIFF' },
                ]),
        } as any;

        const steps = createBusinessRulesBlueprint(fetcher);
        const deterministicSteps = steps.filter(
            (step) => step.type === 'deterministic',
        );

        const ctx = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                userQuestion: 'validate',
                pullRequestNumber: 10,
                pullRequestDescription: 'PR body',
                repository: { id: 'repo-1', name: 'my-repo' },
                taskContext:
                    'As a user, I need to complete checkout with validation rules.',
            },
        } as BusinessRulesContext;

        if (!deterministicSteps.length) {
            throw new Error('deterministic steps not found');
        }

        let next = ctx;
        for (const step of deterministicSteps) {
            next = await step.fn(next);
        }

        expect(fetcher.callTool).toHaveBeenNthCalledWith(
            1,
            'KODUS_GET_PULL_REQUEST',
            expect.objectContaining({
                organizationId: 'org-1',
                teamId: 'team-1',
                repository: {
                    id: 'repo-1',
                    name: 'my-repo',
                },
                prNumber: 10,
            }),
        );
        expect(fetcher.callTool).toHaveBeenNthCalledWith(
            2,
            'KODUS_GET_PULL_REQUEST_DIFF',
            expect.objectContaining({
                organizationId: 'org-1',
                teamId: 'team-1',
                repositoryId: 'repo-1',
                repositoryName: 'my-repo',
                prNumber: 10,
            }),
        );
        expect(fetcher.callAgent).not.toHaveBeenCalled();
        expect(next.prDiff).toBe('diff content');
        expect(next.prBody).toBe('PR body from tool');
        expect(next.taskQuality).toBe('MINIMAL');
    });

    it('falls back to prepareContext PR description when metadata tool is unavailable', async () => {
        const fetcher = {
            callTool: jest.fn().mockResolvedValue({
                result: { result: { success: true, data: 'diff content' } },
            }),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([{ name: 'KODUS_GET_PULL_REQUEST_DIFF' }]),
        } as any;

        const steps = createBusinessRulesBlueprint(fetcher);
        const deterministicSteps = steps.filter(
            (step) => step.type === 'deterministic',
        );

        let next = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                pullRequestNumber: 12,
                pullRequestDescription: 'PR body from prepare context',
                repository: { id: 'repo-1', name: 'my-repo' },
                taskContext: '',
            },
        } as BusinessRulesContext;

        for (const step of deterministicSteps) {
            next = await step.fn(next);
        }

        expect(fetcher.callTool).toHaveBeenCalledTimes(1);
        expect(fetcher.callTool).toHaveBeenCalledWith(
            'KODUS_GET_PULL_REQUEST_DIFF',
            expect.any(Object),
        );
        expect(next.prBody).toBe('PR body from prepare context');
    });
});
