import { runBlueprint } from './blueprint.runner';
import { BlueprintContext, BlueprintStepMetric } from './blueprint.types';

describe('runBlueprint', () => {
    it('emits metrics for successful and skipped steps with duration', async () => {
        const metrics: BlueprintStepMetric[] = [];

        const result = await runBlueprint<BlueprintContext>({
            context: {
                organizationAndTeamData: {},
                userLanguage: 'en-US',
            },
            steps: [
                {
                    type: 'deterministic',
                    name: 'fetchContext',
                    fn: async (ctx) => ({ ...ctx, fetched: true }),
                },
                {
                    type: 'gate',
                    name: 'validateContext',
                    condition: () => false,
                    onFail: (ctx) => ({ ...ctx, formattedResponse: 'missing info' }),
                },
            ],
            runLLMStep: async (_step, ctx) => ctx,
            onStepMetric: (metric) => metrics.push(metric),
        });

        expect(result.skippedAt).toBe('validateContext');
        expect(metrics).toHaveLength(2);
        expect(metrics[0]).toMatchObject({
            stepName: 'fetchContext',
            stepType: 'deterministic',
            status: 'success',
        });
        expect(metrics[1]).toMatchObject({
            stepName: 'validateContext',
            stepType: 'gate',
            status: 'skipped',
        });
        expect(metrics[0].durationMs).toBeGreaterThanOrEqual(0);
        expect(metrics[1].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('emits failed metric before propagating error', async () => {
        const metrics: BlueprintStepMetric[] = [];

        await expect(
            runBlueprint<BlueprintContext>({
                context: {
                    organizationAndTeamData: {},
                    userLanguage: 'en-US',
                },
                steps: [
                    {
                        type: 'deterministic',
                        name: 'fetchContext',
                        fn: async () => {
                            throw new Error('boom');
                        },
                    },
                ],
                runLLMStep: async (_step, ctx) => ctx,
                onStepMetric: (metric) => metrics.push(metric),
            }),
        ).rejects.toThrow('boom');

        expect(metrics).toHaveLength(1);
        expect(metrics[0]).toMatchObject({
            stepName: 'fetchContext',
            stepType: 'deterministic',
            status: 'failed',
        });
        expect(metrics[0].durationMs).toBeGreaterThanOrEqual(0);
    });
});
