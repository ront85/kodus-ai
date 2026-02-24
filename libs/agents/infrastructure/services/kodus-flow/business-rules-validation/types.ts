import { BlueprintContext } from '@libs/shared/blueprint/blueprint.types';

export type TaskQuality = 'EMPTY' | 'MINIMAL' | 'PARTIAL' | 'COMPLETE';

export interface ValidationResult {
    needsMoreInfo: boolean;
    missingInfo?: string;
    summary: string;
}

/**
 * Typed context for the Business Rules Validation skill.
 * Extends BlueprintContext with step-specific fields.
 * Each field is optional — it gets populated by the corresponding step.
 */
export interface BusinessRulesContext extends BlueprintContext {
    /** Raw PR diff text fetched by fetchPRContext step */
    prDiff?: string;
    /** PR body/description fetched by fetchPRContext step */
    prBody?: string;
    /** External task context (Jira, Notion, etc.) fetched by fetchTaskContext step */
    taskContext?: string;
    /** Quality classification set by fetchTaskContext step */
    taskQuality?: TaskQuality;
    /** Structured result parsed from the LLM analyzer output */
    validationResult?: ValidationResult;
    /** Final markdown string returned by execute() */
    formattedResponse?: string;
}
