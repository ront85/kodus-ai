import { Thread } from '@kodus/flow';
import { SDKOrchestrator } from '@kodus/flow/dist/orchestration';

import { BlueprintStep } from '@libs/shared/blueprint/blueprint.types';

import { BusinessRulesContext, TaskQuality } from './types';

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
                ctx.taskQuality === 'PARTIAL' ||
                ctx.taskQuality === 'COMPLETE',
            onFail: (ctx): BusinessRulesContext => {
                const quality = ctx.taskQuality ?? 'EMPTY';
                const missingInfo =
                    quality === 'EMPTY'
                        ? buildEmptyContextMessage()
                        : buildMinimalContextMessage();
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
3. Assess taskQuality: EMPTY (no task found), MINIMAL (title only), PARTIAL (some description), COMPLETE (description + acceptance criteria)

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
            taskQuality:
                ((parsed as any)?.taskQuality as TaskQuality) ?? 'EMPTY',
        };
    } catch {
        return {
            ...ctx,
            prDiff: '',
            prBody: '',
            taskContext: '',
            taskQuality: 'EMPTY',
        };
    }
}

// ─── Gate failure messages ────────────────────────────────────────────────────

function buildEmptyContextMessage(): string {
    return `## 🤔 Need Task Information

I couldn't find any task information associated with this pull request. To perform a proper business rules validation, I need context about what this PR is supposed to implement.

### 🔍 What I need to validate:
- Task title and description
- Acceptance criteria or business requirements
- Expected behavior and business rules

### 💡 Examples of how to provide it:
- Link a Jira/Linear/GitHub issue in the PR description
- Add a task URL in the PR body
- Include acceptance criteria directly in the PR description

### ⚠️ Important:
Business rules validation requires understanding **what** should be implemented, not just **what** was changed.`;
}

function buildMinimalContextMessage(): string {
    return `## 🤔 Insufficient Task Context

I found a task linked to this PR, but it only contains minimal information (title only, no description or acceptance criteria). To perform a meaningful business rules validation, I need more details.

### 🔍 What I need to validate:
- Business requirements and acceptance criteria
- Expected behavior and business rules
- Edge cases and constraints to consider

### 💡 How to improve the task context:
- Add a description to the linked ticket
- Include acceptance criteria or business rules
- Describe the expected behavior after the change

### ⚠️ Important:
A task title alone is not sufficient to determine whether the implementation is correct or complete.`;
}
