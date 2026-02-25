import { SDKOrchestrator } from '@kodus/flow/dist/orchestration';

import { BlueprintStep } from '@libs/shared/blueprint/blueprint.types';

import { BusinessRulesContext, TaskQuality } from './types';
import {
    canProceedWithBusinessRulesAnalysis,
    getTaskContextMissingInfoMessage,
} from './task-quality.rules';

const SKILL_NAME = 'business-rules-validation';
const PR_METADATA_TOOL = 'KODUS_GET_PULL_REQUEST';
const PR_DIFF_TOOL = 'KODUS_GET_PULL_REQUEST_DIFF';

/**
 * Business Rules Validation Blueprint — factory function.
 *
 * Receives the fetcher orchestration as a dependency so every step
 * has real implementations — no placeholder functions replaced at runtime.
 *
 * Steps:
 * 1. fetchPullRequestMetadata (deterministic) — fetch PR body/title from MCP when available
 * 2. fetchPullRequestDiff     (deterministic) — fetch PR diff from MCP (no LLM)
 * 3. resolveTaskContext       (deterministic) — resolve task context from pre-fetched input
 * 4. classifyTaskContext      (deterministic) — classify task quality
 * 5. validateContext          (gate)          — short-circuits if task quality is EMPTY or MINIMAL
 * 6. analyzeBusinessRules     (llm)           — analyzer agent with SKILL.md instructions (handled by runLLMStep)
 */
export function createBusinessRulesBlueprint(
    fetcher: SDKOrchestrator,
): BlueprintStep<BusinessRulesContext>[] {
    return [
        {
            type: 'deterministic',
            name: 'fetchPullRequestMetadata',
            fn: async (ctx): Promise<BusinessRulesContext> => {
                const prBody =
                    (await resolvePullRequestBody(fetcher, ctx)) ??
                    resolvePullRequestDescription(ctx);

                return {
                    ...ctx,
                    prBody,
                };
            },
        },
        {
            type: 'deterministic',
            name: 'fetchPullRequestDiff',
            fn: async (ctx): Promise<BusinessRulesContext> => {
                const prDiff = await resolvePullRequestDiff(fetcher, ctx);

                return {
                    ...ctx,
                    prDiff,
                };
            },
        },
        {
            type: 'deterministic',
            name: 'resolveTaskContext',
            fn: async (ctx): Promise<BusinessRulesContext> => {
                const taskContext = resolveTaskContext(ctx);

                return {
                    ...ctx,
                    taskContext,
                };
            },
        },
        {
            type: 'deterministic',
            name: 'classifyTaskContext',
            fn: async (ctx): Promise<BusinessRulesContext> => ({
                ...ctx,
                taskQuality: classifyTaskQuality(ctx.taskContext ?? ''),
            }),
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

function resolvePullRequestNumber(
    ctx: BusinessRulesContext,
): number | undefined {
    const direct = ctx.prepareContext?.pullRequestNumber;
    if (typeof direct === 'number') {
        return direct;
    }
    const nested = ctx.prepareContext?.pullRequest?.pullRequestNumber;
    if (typeof nested === 'number') {
        return nested;
    }
    return undefined;
}

function resolveRepositoryId(ctx: BusinessRulesContext): string | undefined {
    const repositoryId = ctx.prepareContext?.repository?.id;
    return typeof repositoryId === 'string' ? repositoryId : undefined;
}

function resolveRepositoryName(ctx: BusinessRulesContext): string | undefined {
    const repositoryName = ctx.prepareContext?.repository?.name;
    return typeof repositoryName === 'string' ? repositoryName : undefined;
}

function resolvePullRequestDescription(ctx: BusinessRulesContext): string {
    const description = ctx.prepareContext?.pullRequestDescription;
    return typeof description === 'string' ? description : '';
}

function resolveTaskContext(ctx: BusinessRulesContext): string {
    const taskContext = ctx.prepareContext?.taskContext;
    return typeof taskContext === 'string' ? taskContext : '';
}

function classifyTaskQuality(taskContext: string): TaskQuality {
    const normalized = taskContext.trim();
    if (!normalized.length) {
        return 'EMPTY';
    }
    if (normalized.length < 80) {
        return 'MINIMAL';
    }
    if (normalized.length < 260) {
        return 'PARTIAL';
    }
    return 'COMPLETE';
}

async function resolvePullRequestDiff(
    fetcher: SDKOrchestrator,
    ctx: BusinessRulesContext,
): Promise<string> {
    const organizationId = ctx.organizationAndTeamData?.organizationId;
    const teamId = ctx.organizationAndTeamData?.teamId;
    const repositoryId = resolveRepositoryId(ctx);
    const prNumber = resolvePullRequestNumber(ctx);

    if (
        typeof organizationId !== 'string' ||
        typeof teamId !== 'string' ||
        typeof repositoryId !== 'string' ||
        typeof prNumber !== 'number'
    ) {
        return '';
    }

    const registeredTools = getRegisteredToolNames(fetcher);
    if (!registeredTools.includes(PR_DIFF_TOOL)) {
        return '';
    }

    const toolResult = await fetcher.callTool(PR_DIFF_TOOL, {
        organizationId,
        teamId,
        repositoryId,
        repositoryName: resolveRepositoryName(ctx),
        prNumber,
    });

    return extractDiffFromToolResult(toolResult.result);
}

async function resolvePullRequestBody(
    fetcher: SDKOrchestrator,
    ctx: BusinessRulesContext,
): Promise<string | undefined> {
    const organizationId = ctx.organizationAndTeamData?.organizationId;
    const teamId = ctx.organizationAndTeamData?.teamId;
    const repositoryId = resolveRepositoryId(ctx);
    const repositoryName = resolveRepositoryName(ctx) ?? repositoryId;
    const prNumber = resolvePullRequestNumber(ctx);

    if (
        typeof organizationId !== 'string' ||
        typeof teamId !== 'string' ||
        typeof repositoryId !== 'string' ||
        typeof repositoryName !== 'string' ||
        typeof prNumber !== 'number'
    ) {
        return undefined;
    }

    const registeredTools = getRegisteredToolNames(fetcher);
    if (!registeredTools.includes(PR_METADATA_TOOL)) {
        return undefined;
    }

    const toolResult = await fetcher.callTool(PR_METADATA_TOOL, {
        organizationId,
        teamId,
        repository: {
            id: repositoryId,
            name: repositoryName,
        },
        prNumber,
    });

    return extractPrBodyFromToolResult(toolResult.result);
}

function extractDiffFromToolResult(payload: unknown): string {
    const root = asRecord(payload);
    const nestedResult = asRecord(root.result);

    const directData = root.data;
    if (typeof directData === 'string') {
        return directData;
    }

    const nestedData = nestedResult.data;
    if (typeof nestedData === 'string') {
        return nestedData;
    }

    return '';
}

function extractPrBodyFromToolResult(payload: unknown): string | undefined {
    const root = asRecord(payload);
    const nestedResult = asRecord(root.result);

    const directData = asRecord(root.data);
    const nestedData = asRecord(nestedResult.data);

    if (typeof directData.body === 'string') {
        return directData.body;
    }
    if (typeof nestedData.body === 'string') {
        return nestedData.body;
    }
    if (typeof directData.message === 'string') {
        return directData.message;
    }
    if (typeof nestedData.message === 'string') {
        return nestedData.message;
    }

    return undefined;
}

function getRegisteredToolNames(fetcher: SDKOrchestrator): string[] {
    return fetcher.getRegisteredTools().map((tool) => tool.name ?? '');
}

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') {
        return {};
    }
    return value as Record<string, unknown>;
}
