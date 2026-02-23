import { BlueprintStep } from '@libs/shared/blueprint/blueprint.types';
import { BusinessRulesContext, TaskQuality } from './types';

/**
 * Business Rules Validation Blueprint — Kodus-owned execution steps.
 *
 * This blueprint is NOT user-editable. Teams can only customize the SKILL.md
 * instructions body (loaded by SkillLoaderService and passed to the LLM step).
 *
 * Steps:
 * 1. fetchPRContext      (deterministic) — fetcher agent gets PR diff + body
 * 2. fetchTaskContext    (deterministic) — fetcher agent gets task/ticket context + quality
 * 3. validateContext     (gate)          — short-circuits if task quality is EMPTY or MINIMAL
 * 4. analyzeBusinessRules (llm)          — analyzer agent with SKILL.md instructions
 * 5. formatResponse     (format)         — parse ValidationResult, set formattedResponse
 */
export const businessRulesBlueprint: BlueprintStep<BusinessRulesContext>[] = [
    {
        type: 'deterministic',
        name: 'fetchPRContext',
        fn: async (ctx) => ctx, // implemented inside BusinessRulesValidationAgentProvider.runFetcherStep()
    },
    {
        type: 'deterministic',
        name: 'fetchTaskContext',
        fn: async (ctx) => ctx, // implemented inside BusinessRulesValidationAgentProvider.runFetcherStep()
    },
    {
        type: 'gate',
        name: 'validateContext',
        condition: (ctx) => {
            const quality = ctx.taskQuality;
            return quality === 'PARTIAL' || quality === 'COMPLETE';
        },
        onFail: (ctx): BusinessRulesContext => {
            const quality = ctx.taskQuality ?? 'EMPTY';
            const isEmpty = quality === 'EMPTY';

            const missingInfo = isEmptyQuality(quality)
                ? buildEmptyContextMessage(ctx)
                : buildMinimalContextMessage(ctx);

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
        skill: 'business-rules-validation',
        agentName: 'kodus-business-rules-analyzer',
    },
    {
        type: 'format',
        name: 'formatResponse',
        fn: (ctx) => ctx, // implemented inside BusinessRulesValidationAgentProvider.formatStep()
    },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isEmptyQuality(quality: TaskQuality): boolean {
    return quality === 'EMPTY';
}

function buildEmptyContextMessage(_ctx: BusinessRulesContext): string {
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

function buildMinimalContextMessage(_ctx: BusinessRulesContext): string {
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
