import { Thread, createLogger } from '@kodus/flow';
import { LLMModelProvider, PromptRunnerService } from '@kodus/kodus-common/llm';
import { Injectable, Inject, Optional } from '@nestjs/common';

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
import {
    BlueprintStepMetric,
    LLMStep,
} from '@libs/shared/blueprint/blueprint.types';
import { GenericSkillRunnerService } from '../../../../skills/generic-skill-runner.service';
import {
    isMcpConnectivityError,
    McpConnectionUnavailableError,
    RequiredMcpPreflightError,
    SkillInputContractViolationError,
    SkillOutputContractViolationError,
} from '../../../../skills/skill.errors';
import { createBusinessRulesBlueprint } from './blueprint';
import {
    buildMcpConnectionFailureFeedback,
    buildRequiredMcpFeedback,
} from './required-mcp-feedback';
import { BusinessRulesContext, ValidationResult } from './types';
import { SDKOrchestrator } from '@kodus/flow/dist/orchestration';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { TASK_QUALITY_ANALYZER_POLICY } from './task-quality.rules';

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
        @Optional() private readonly metricsCollector?: MetricsCollectorService,
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
        const normalizedContext = this.normalizeInputContext(context);

        if (!normalizedContext.organizationAndTeamData) {
            throw new Error(
                'Organization and team data is required for business rules validation.',
            );
        }

        const userLanguage = await this.getLanguage(
            normalizedContext.organizationAndTeamData,
        );

        this.logger.log({
            message: 'Starting business rules validation',
            context: BusinessRulesValidationAgentProvider.name,
            serviceName: BusinessRulesValidationAgentProvider.name,
            metadata: {
                userLanguage,
                organizationId:
                    normalizedContext.organizationAndTeamData?.organizationId,
                teamId: normalizedContext.organizationAndTeamData?.teamId,
            },
        });

        try {
            this.genericSkillRunner.validateInputContract(
                SKILL_NAME,
                normalizedContext,
            );
        } catch (error) {
            if (error instanceof SkillInputContractViolationError) {
                this.logger.warn({
                    message:
                        'Business rules validation skipped due to input contract violation',
                    context: BusinessRulesValidationAgentProvider.name,
                    serviceName: BusinessRulesValidationAgentProvider.name,
                    metadata: {
                        organizationId:
                            normalizedContext.organizationAndTeamData
                                ?.organizationId,
                        teamId:
                            normalizedContext.organizationAndTeamData?.teamId,
                        missingFields: error.metadata?.missingFields,
                    },
                });
                return this.buildContractViolationFeedback(
                    userLanguage,
                    'input',
                    error.metadata?.missingFields as string[] | undefined,
                );
            }
            throw error;
        }

        await this.fetchBYOKConfig(normalizedContext.organizationAndTeamData);

        let fetcher: SDKOrchestrator;
        try {
            fetcher = await this.genericSkillRunner.createFetcherOrchestration(
                SKILL_NAME,
                super.createLLMAdapter(
                    'BusinessRulesValidation',
                    'businessRulesFetcher',
                ),
                normalizedContext.organizationAndTeamData,
            );
        } catch (error) {
            if (error instanceof RequiredMcpPreflightError) {
                const feedback = buildRequiredMcpFeedback({
                    requiredMcps: error.requiredMcps,
                    userLanguage,
                    availableProviders: error.availableProviders,
                });

                this.logger.warn({
                    message:
                        'Business rules validation skipped due to missing required MCP integrations',
                    context: BusinessRulesValidationAgentProvider.name,
                    serviceName: BusinessRulesValidationAgentProvider.name,
                    metadata: {
                        organizationId:
                            normalizedContext.organizationAndTeamData
                                ?.organizationId,
                        teamId:
                            normalizedContext.organizationAndTeamData?.teamId,
                        requiredMcps: error.requiredMcps,
                    },
                });

                return feedback;
            }
            if (error instanceof McpConnectionUnavailableError) {
                const feedback = buildMcpConnectionFailureFeedback({
                    userLanguage,
                    availableProviders: error.availableProviders,
                });

                this.logger.warn({
                    message:
                        'Business rules validation skipped due to MCP connection failure during fetcher initialization',
                    context: BusinessRulesValidationAgentProvider.name,
                    serviceName: BusinessRulesValidationAgentProvider.name,
                    metadata: {
                        organizationId:
                            normalizedContext.organizationAndTeamData
                                ?.organizationId,
                        teamId:
                            normalizedContext.organizationAndTeamData?.teamId,
                        errorMessage:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                });

                return feedback;
            }
            throw error;
        }

        const initialCtx: BusinessRulesContext = {
            organizationAndTeamData: normalizedContext.organizationAndTeamData,
            userLanguage,
            thread: normalizedContext.thread,
            prepareContext: normalizedContext.prepareContext,
        };

        let result: Awaited<
            ReturnType<typeof runBlueprint<BusinessRulesContext>>
        >;
        try {
            result = await runBlueprint<BusinessRulesContext>({
                steps: createBusinessRulesBlueprint(fetcher),
                context: initialCtx,
                runLLMStep: (step, ctx) => this.runAnalyzer(step, ctx),
                onStepMetric: (metric) =>
                    this.recordStepMetric(
                        metric,
                        normalizedContext.organizationAndTeamData as OrganizationAndTeamData,
                    ),
                logger: {
                    log: (msg) =>
                        this.logger.log({
                            message: msg,
                            context: BusinessRulesValidationAgentProvider.name,
                            serviceName:
                                BusinessRulesValidationAgentProvider.name,
                        }),
                    error: (msg, err) =>
                        this.logger.error({
                            message: msg,
                            context: BusinessRulesValidationAgentProvider.name,
                            serviceName:
                                BusinessRulesValidationAgentProvider.name,
                            metadata: { error: err },
                        }),
                },
            });
        } catch (error) {
            if (
                error instanceof McpConnectionUnavailableError ||
                isMcpConnectivityError(error)
            ) {
                const feedback = buildMcpConnectionFailureFeedback({
                    userLanguage,
                    availableProviders:
                        error instanceof McpConnectionUnavailableError
                            ? error.availableProviders
                            : undefined,
                });

                this.logger.warn({
                    message:
                        'Business rules validation failed due to MCP connection error while executing blueprint',
                    context: BusinessRulesValidationAgentProvider.name,
                    serviceName: BusinessRulesValidationAgentProvider.name,
                    metadata: {
                        organizationId:
                            normalizedContext.organizationAndTeamData
                                ?.organizationId,
                        teamId:
                            normalizedContext.organizationAndTeamData?.teamId,
                        errorMessage:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                });

                return feedback;
            }
            if (error instanceof SkillOutputContractViolationError) {
                this.logger.error({
                    message:
                        'Business rules validation failed due to output contract violation',
                    context: BusinessRulesValidationAgentProvider.name,
                    serviceName: BusinessRulesValidationAgentProvider.name,
                    metadata: {
                        organizationId:
                            normalizedContext.organizationAndTeamData
                                ?.organizationId,
                        teamId:
                            normalizedContext.organizationAndTeamData?.teamId,
                        missingFields: error.metadata?.missingFields,
                    },
                });
                return this.buildContractViolationFeedback(
                    userLanguage,
                    'output',
                    error.metadata?.missingFields as string[] | undefined,
                );
            }
            throw error;
        }

        this.logger.log({
            message: 'Business rules validation completed',
            context: BusinessRulesValidationAgentProvider.name,
            serviceName: BusinessRulesValidationAgentProvider.name,
            metadata: {
                organizationId:
                    normalizedContext.organizationAndTeamData?.organizationId,
                teamId: normalizedContext.organizationAndTeamData?.teamId,
                completedSteps: result.completedSteps,
                skippedAt: result.skippedAt,
                responseLength: result.context.formattedResponse?.length ?? 0,
            },
        });

        return result.context.formattedResponse ?? '';
    }

    private recordStepMetric(
        metric: BlueprintStepMetric,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const labels = {
            skill: SKILL_NAME,
            step: metric.stepName,
            stepType: metric.stepType,
            status: metric.status,
        };

        this.metricsCollector?.recordHistogram(
            'kodus_skill_step_duration_ms',
            metric.durationMs,
            labels,
        );
        this.metricsCollector?.recordCounter(
            'kodus_skill_step_total',
            1,
            labels,
        );

        this.logger.log({
            message: 'Business rules step metric',
            context: BusinessRulesValidationAgentProvider.name,
            serviceName: BusinessRulesValidationAgentProvider.name,
            metadata: {
                ...labels,
                durationMs: metric.durationMs,
                organizationId: organizationAndTeamData?.organizationId,
                teamId: organizationAndTeamData?.teamId,
                ...(metric.errorMessage
                    ? { errorMessage: metric.errorMessage }
                    : {}),
            },
        });
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
                    validationContext: {
                        prepareContext: ctx.prepareContext,
                        taskQuality: ctx.taskQuality,
                        hasTaskContext: Boolean(ctx.taskContext),
                        hasPrDiff: Boolean(ctx.prDiff),
                    },
                },
            },
        );

        const validationResult = this.parseValidationResult(
            analysisResult.result,
        );
        this.genericSkillRunner.validateOutputContract(SKILL_NAME, validationResult);

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

TASK_QUALITY_POLICY:
${TASK_QUALITY_ANALYZER_POLICY}

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

    private extractFieldsFromString(text: string): Partial<ValidationResult> {
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

        const summaryMatch = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
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

    private normalizeInputContext(context: {
        organizationAndTeamData: OrganizationAndTeamData;
        prepareContext?: any;
        thread?: Thread;
    }): {
        organizationAndTeamData: OrganizationAndTeamData;
        prepareContext?: any;
        thread?: Thread;
    } {
        if (!context?.prepareContext || typeof context.prepareContext !== 'object') {
            return context;
        }

        const nestedPullRequestNumber =
            context.prepareContext?.pullRequest?.pullRequestNumber;

        if (
            context.prepareContext.pullRequestNumber === undefined &&
            nestedPullRequestNumber !== undefined
        ) {
            return {
                ...context,
                prepareContext: {
                    ...context.prepareContext,
                    pullRequestNumber: nestedPullRequestNumber,
                },
            };
        }

        return context;
    }

    private buildContractViolationFeedback(
        userLanguage: string,
        phase: 'input' | 'output',
        missingFields: string[] | undefined,
    ): string {
        void userLanguage;

        const fields =
            missingFields && missingFields.length > 0
                ? missingFields.join(', ')
                : 'unknown';

        if (phase === 'input') {
            return `## ⚠️ Missing Validation Context

I couldn't start the skill because required context fields are missing: \`${fields}\`.

### How to fix
- Ensure the event includes organization, team, repository, and pull request number.
- Run again: \`@kody -v business-logic\``;
        }

        return `## ⚠️ Invalid Skill Response

The analysis step returned an incomplete response and failed output contract validation.

Missing fields: \`${fields}\`.

Please try again in a moment.`;
    }
}
