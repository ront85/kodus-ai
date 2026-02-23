import {
    BlueprintContext,
    BlueprintResult,
    BlueprintRunnerOptions,
} from './blueprint.types';

/**
 * runBlueprint — Execute a skill blueprint against an initial context.
 *
 * Pure async function — no NestJS or @kodus/flow dependencies.
 * Each step type is handled as follows:
 *
 * - `deterministic`: await step.fn(ctx), replace ctx with result
 * - `gate`: if condition(ctx) is false → call onFail(ctx), return early with skippedAt set
 * - `llm`: delegate to options.runLLMStep(step, ctx); caller owns the @kodus/flow call
 * - `format`: step.fn(ctx), replace ctx with result (sync)
 * - `parallel`: not handled here — caller must handle via ISkillRunner.runParallel()
 *
 * Any step error propagates to the caller (no silent swallowing).
 */
export async function runBlueprint<T extends BlueprintContext>(
    options: BlueprintRunnerOptions<T>,
): Promise<BlueprintResult<T>> {
    let ctx = options.context;
    const completedSteps: string[] = [];
    const log = options.logger;

    for (const step of options.steps) {
        log?.log(`[blueprint] running step: ${step.name} (${step.type})`);

        if (step.type === 'deterministic') {
            ctx = await step.fn(ctx);
            completedSteps.push(step.name);
        } else if (step.type === 'gate') {
            const passed = step.condition(ctx);
            if (!passed) {
                log?.log(
                    `[blueprint] gate '${step.name}' failed — short-circuiting`,
                );
                ctx = step.onFail(ctx);
                return { context: ctx, completedSteps, skippedAt: step.name };
            }
            completedSteps.push(step.name);
        } else if (step.type === 'llm') {
            ctx = await options.runLLMStep(step, ctx);
            completedSteps.push(step.name);
        } else if (step.type === 'format') {
            ctx = step.fn(ctx);
            completedSteps.push(step.name);
        } else if (step.type === 'parallel') {
            // Parallel steps are not handled by the runner — they require ISkillRunner.
            // If encountered here it means the blueprint was wired incorrectly.
            throw new Error(
                `[blueprint] Parallel step '${(step as any).name}' cannot be executed by runBlueprint directly. ` +
                    `Use ISkillRunner.runParallel() instead.`,
            );
        }
    }

    return { context: ctx, completedSteps };
}
