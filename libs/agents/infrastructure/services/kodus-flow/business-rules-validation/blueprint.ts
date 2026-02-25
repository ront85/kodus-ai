import { Thread } from '@kodus/flow';
import { SDKOrchestrator } from '@kodus/flow/dist/orchestration';

import { BlueprintStep } from '@libs/shared/blueprint/blueprint.types';

import { BusinessRulesContext } from './types';
import {
    canProceedWithBusinessRulesAnalysis,
    getTaskContextMissingInfoMessage,
    normalizeTaskQuality,
    TASK_QUALITY_CLASSIFICATION_GUIDE,
} from './task-quality.rules';

const SKILL_NAME = 'business-rules-validation';

/**
 * Business Rules Validation Blueprint — factory function.
 *
 * Receives the fetcher orchestration as a dependency so every step
 * has real implementations — no placeholder functions replaced at runtime.
 *
 * Steps:
 * 1. fetchContext      (deterministic) — fetcher agent gets PR diff, body, task context + quality
 * 2. validateContext   (gate)          — short-circuits if task quality is EMPTY or MINIMAL
 * 3. analyzeBusinessRules (llm)        — analyzer agent with SKILL.md instructions (handled by runLLMStep)
 */
export function createBusinessRulesBlueprint(
    fetcher: SDKOrchestrator,
): BlueprintStep<BusinessRulesContext>[] {
    return [
        {
            type: 'deterministic',
            name: 'fetchContext',
            fn: async (ctx) => {
                const result = await fetcher.callAgent(
                    `kodus-${SKILL_NAME}-fetcher`,
                    buildFetcherPrompt(ctx),
                    {
                        thread: ctx.thread as Thread,
                        userContext: {
                            organizationAndTeamData:
                                ctx.organizationAndTeamData,
                        },
                    },
                );
                return parseFetcherResult(result.result, ctx);
            },
        },
        {
            type: 'gate',
            name: 'validateContext',
            condition: (ctx) =>
                canProceedWithBusinessRulesAnalysis(ctx.taskQuality),
            onFail: (ctx): BusinessRulesContext => {
                const missingInfo = getTaskContextMissingInfoMessage(
                    ctx.taskQuality,
                );
                return {
                    ...ctx,
                    validationResult: {
                        needsMoreInfo: true,
                        missingInfo,
                        summary: '',
                    },
                    formattedResponse: missingInfo,
                };
            },
        },
        {
            type: 'llm',
            name: 'analyzeBusinessRules',
            skill: SKILL_NAME,
            agentName: `kodus-${SKILL_NAME}-analyzer`,
        },
    ];
}

// ─── Fetcher helpers ──────────────────────────────────────────────────────────

function buildFetcherPrompt(ctx: BusinessRulesContext): string {
    return `Fetch context for business rules validation.

USER REQUEST: ${ctx.prepareContext?.userQuestion ?? 'Analyze business rules compliance'}

Use available tools to:
1. Get the PR diff and PR description
2. Get the linked task/ticket context
3. Assess taskQuality: ${TASK_QUALITY_CLASSIFICATION_GUIDE}

Return ONLY a JSON object with prDiff, prBody, taskContext, and taskQuality.`;
}

function parseFetcherResult(
    result: unknown,
    ctx: BusinessRulesContext,
): BusinessRulesContext {
    try {
        const parsed =
            typeof result === 'string' ? JSON.parse(result) : result;

        return {
            ...ctx,
            prDiff: (parsed as any)?.prDiff ?? '',
            prBody: (parsed as any)?.prBody ?? '',
            taskContext: (parsed as any)?.taskContext ?? '',
            taskQuality: normalizeTaskQuality((parsed as any)?.taskQuality),
        };
    } catch {
        return {
            ...ctx,
            prDiff: '',
            prBody: '',
            taskContext: '',
            taskQuality: normalizeTaskQuality(undefined),
        };
    }
}
