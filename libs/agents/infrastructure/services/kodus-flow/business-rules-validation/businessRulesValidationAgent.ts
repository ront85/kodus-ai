import { Thread, createLogger } from '@kodus/flow';
import { SDKOrchestrator } from '@kodus/flow/dist/orchestration';
import { LLMModelProvider, PromptRunnerService } from '@kodus/kodus-common/llm';
import { Injectable, Inject } from '@nestjs/common';

import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import {
    PARAMETERS_SERVICE_TOKEN,
    IParametersService,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

import { BaseAgentProvider } from '../base-agent.provider';
import { ObservabilityService } from '@libs/core/log/observability.service';

import { runBlueprint } from '@libs/shared/blueprint/blueprint.runner';
import { LLMStep } from '@libs/shared/blueprint/blueprint.types';
import { GenericSkillRunnerService } from '../../../../skills/generic-skill-runner.service';
import { createBusinessRulesBlueprint } from './blueprint';
import { BusinessRulesContext, ValidationResult } from './types';

const SKILL_NAME = 'business-rules-validation';

/** Re-exported for backward compatibility with callers that imported from here */
export type { ValidationResult };

@Injectable()
export class BusinessRulesValidationAgentProvider extends BaseAgentProvider {
    private readonly logger = createLogger(
        BusinessRulesValidationAgentProvider.name,
    );

    protected readonly defaultLLMConfig = {
        llmProvider: LLMModelProvider.GEMINI_2_5_PRO,
        temperature: 0,
        maxTokens: 20000,
        maxReasoningTokens: 1000,
        stop: undefined as string[] | undefined,
    };

    constructor(
        promptRunnerService: PromptRunnerService,
        permissionValidationService: PermissionValidationService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        observabilityService: ObservabilityService,
        private readonly genericSkillRunner: GenericSkillRunnerService,
    ) {
        super(
            promptRunnerService,
            permissionValidationService,
            observabilityService,
        );
    }

    // ─── Public interface ─────────────────────────────────────────────────────

    async execute(context: {
        organizationAndTeamData: OrganizationAndTeamData;
        prepareContext?: any;
        thread?: Thread;
    }): Promise<string> {
        if (!context.organizationAndTeamData) {
            throw new Error(
                'Organization and team data is required for business rules validation.',
            );
        }

        const userLanguage = await this.getLanguage(
            context.organizationAndTeamData,
        );

        this.logger.log({
            message: 'Starting business rules validation',
            context: BusinessRulesValidationAgentProvider.name,
            serviceName: BusinessRulesValidationAgentProvider.name,
            metadata: {
                userLanguage,
                organizationId: context.organizationAndTeamData?.organizationId,
                teamId: context.organizationAndTeamData?.teamId,
            },
        });

        await this.fetchBYOKConfig(context.organizationAndTeamData);

        const fetcher = await this.genericSkillRunner.createFetcherOrchestration(
            SKILL_NAME,
            super.createLLMAdapter('BusinessRulesValidation', 'businessRulesFetcher'),
            context.organizationAndTeamData,
        );

        const initialCtx: BusinessRulesContext = {
            organizationAndTeamData: context.organizationAndTeamData,
            userLanguage,
            thread: context.thread,
            prepareContext: context.prepareContext,
        };

        const result = await runBlueprint<BusinessRulesContext>({
            steps: createBusinessRulesBlueprint(fetcher),
            context: initialCtx,
            runLLMStep: (step, ctx) => this.runAnalyzer(step, ctx),
            logger: {
                log: (msg) =>
                    this.logger.log({
                        message: msg,
                        context: BusinessRulesValidationAgentProvider.name,
                        serviceName: BusinessRulesValidationAgentProvider.name,
                    }),
                error: (msg, err) =>
                    this.logger.error({
                        message: msg,
                        context: BusinessRulesValidationAgentProvider.name,
                        serviceName: BusinessRulesValidationAgentProvider.name,
                        metadata: { error: err },
                    }),
            },
        });

        this.logger.log({
            message: 'Business rules validation completed',
            context: BusinessRulesValidationAgentProvider.name,
            serviceName: BusinessRulesValidationAgentProvider.name,
            metadata: {
                organizationId: context.organizationAndTeamData?.organizationId,
                teamId: context.organizationAndTeamData?.teamId,
                completedSteps: result.completedSteps,
                skippedAt: result.skippedAt,
                responseLength: result.context.formattedResponse?.length ?? 0,
            },
        });

        return result.context.formattedResponse ?? '';
    }

    // ─── LLM step handler ─────────────────────────────────────────────────────

    private async runAnalyzer(
        _step: LLMStep,
        ctx: BusinessRulesContext,
    ): Promise<BusinessRulesContext> {
        const analyzer: SDKOrchestrator =
            await this.genericSkillRunner.createAnalyzerOrchestration(
                SKILL_NAME,
                super.createLLMAdapter(
                    'BusinessRulesValidation',
                    'businessRulesAnalyzer',
                ),
            );

        const analysisResult = await analyzer.callAgent(
            `kodus-${SKILL_NAME}-analyzer`,
            this.buildAnalysisPrompt(ctx),
            {
                thread: ctx.thread as Thread,
                userContext: {
                    organizationAndTeamData:
                        ctx.organizationAndTeamData as OrganizationAndTeamData,
                },
            },
        );

        const validationResult = this.parseValidationResult(
            analysisResult.result,
        );

        const formattedResponse = validationResult.needsMoreInfo
            ? (validationResult.missingInfo ??
              '## 🤔 Need Task Information\n\nPlease provide task context.')
            : (validationResult.summary ?? '');

        return { ...ctx, validationResult, formattedResponse };
    }

    // Required by BaseAgentProvider — MCP logic lives in GenericSkillRunnerService
    protected async createMCPAdapter(
        _organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {}

    // ─── Prompt builder ───────────────────────────────────────────────────────

    private buildAnalysisPrompt(ctx: BusinessRulesContext): string {
        return `Perform business rules gap analysis.

TASK_QUALITY: ${ctx.taskQuality}

TASK_CONTEXT:
${ctx.taskContext ?? '(none)'}

PR_DIFF:
${ctx.prDiff ?? '(not available)'}

PR_DESCRIPTION:
${ctx.prBody ?? '(not available)'}

USER LANGUAGE: ${ctx.userLanguage}

Follow the instructions in your system prompt exactly. Return ONLY a JSON object.`;
    }

    // ─── Result parser ────────────────────────────────────────────────────────

    private parseValidationResult(result: unknown): ValidationResult {
        if (typeof result === 'string') {
            const extracted = this.extractFieldsFromString(result);
            if (extracted.summary) {
                return {
                    needsMoreInfo: extracted.needsMoreInfo ?? false,
                    missingInfo: extracted.missingInfo ?? '',
                    summary: extracted.summary,
                };
            }
        } else if (typeof result === 'object' && result !== null) {
            const r = result as Record<string, unknown>;
            return {
                needsMoreInfo: r.needsMoreInfo === true,
                missingInfo: (r.missingInfo as string) ?? '',
                summary:
                    (r.summary as string) ??
                    'Business rules validation completed.',
            };
        }

        return {
            needsMoreInfo: true,
            missingInfo: 'Error parsing validation result. Please try again.',
            summary:
                '❌ **Error processing validation**\n\nAn error occurred while processing the system response. Please try again.',
        };
    }

    private extractFieldsFromString(
        text: string,
    ): Partial<ValidationResult> {
        const fields: Partial<ValidationResult> = {};

        const needsMoreInfoMatch = text.match(
            /"needsMoreInfo"\s*:\s*(true|false)/,
        );
        if (needsMoreInfoMatch) {
            fields.needsMoreInfo = needsMoreInfoMatch[1] === 'true';
        }

        const missingInfoMatch = text.match(/"missingInfo"\s*:\s*"([^"]*)"/);
        if (missingInfoMatch) {
            fields.missingInfo = missingInfoMatch[1];
        }

        const summaryMatch = text.match(
            /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/,
        );
        if (summaryMatch) {
            fields.summary = summaryMatch[1]
                .replace(/\\n/g, '\n')
                .replace(/\\"/g, '"');
        }

        return fields;
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private async getLanguage(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        if (!organizationAndTeamData?.teamId) return 'en-US';

        try {
            const language = await this.parametersService.findByKey(
                ParametersKey.LANGUAGE_CONFIG,
                organizationAndTeamData,
            );
            return language?.configValue ?? 'en-US';
        } catch {
            return 'en-US';
        }
    }
}
