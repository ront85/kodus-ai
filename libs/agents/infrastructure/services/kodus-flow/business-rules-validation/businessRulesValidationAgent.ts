import {
    createMCPAdapter,
    createOrchestration,
    Thread,
    PlannerType,
    LLMAdapter,
    createLogger,
} from '@kodus/flow';
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
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

import { runBlueprint } from '@libs/shared/blueprint/blueprint.runner';
import { LLMStep } from '@libs/shared/blueprint/blueprint.types';
import { SkillLoaderService } from '../../../../skills/skill-loader.service';
import { businessRulesBlueprint } from './blueprint';
import {
    BusinessRulesContext,
    TaskQuality,
    ValidationResult,
} from './types';

/** Re-exported for backward compatibility with callers that imported from here */
export type { ValidationResult };

@Injectable()
export class BusinessRulesValidationAgentProvider extends BaseAgentProvider {
    private readonly logger = createLogger(
        BusinessRulesValidationAgentProvider.name,
    );

    private fetcherOrchestration: SDKOrchestrator;
    private analyzerOrchestration: SDKOrchestrator;
    private mcpAdapter: ReturnType<typeof createMCPAdapter>;
    private llmAdapter: LLMAdapter;

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
        private readonly skillLoaderService: SkillLoaderService,
        private readonly mcpManagerService?: MCPManagerService,
    ) {
        super(
            promptRunnerService,
            permissionValidationService,
            observabilityService,
        );
    }

    // ─── Public interface (unchanged — all callers must continue working) ─────

    async execute(context: {
        organizationAndTeamData: OrganizationAndTeamData;
        prepareContext?: any;
        thread?: Thread;
    }): Promise<string> {
        try {
            const userLanguage = await this.getLanguage(
                context.organizationAndTeamData,
            );

            this.logger.log({
                message: 'Starting business rules validation via blueprint',
                context: BusinessRulesValidationAgentProvider.name,
                serviceName: BusinessRulesValidationAgentProvider.name,
                metadata: {
                    userLanguage,
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    teamId: context.organizationAndTeamData?.teamId,
                    threadId: context.thread?.id,
                },
            });

            if (!context.organizationAndTeamData) {
                throw new Error(
                    'Organization and team data is required for business rules validation.',
                );
            }

            await this.fetchBYOKConfig(context.organizationAndTeamData);
            await this.initializeFetcher(context.organizationAndTeamData);

            const initialCtx: BusinessRulesContext = {
                organizationAndTeamData: context.organizationAndTeamData,
                userLanguage,
                thread: context.thread,
                prepareContext: context.prepareContext,
            };

            // Build a resolved blueprint where the deterministic steps
            // call the real fetcher orchestration
            const resolvedBlueprint = this.buildResolvedBlueprint();

            const result = await runBlueprint<BusinessRulesContext>({
                steps: resolvedBlueprint,
                context: initialCtx,
                runLLMStep: this.runAnalyzerStep.bind(this),
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

            const finalCtx = result.context;

            this.logger.log({
                message: 'Business rules validation completed',
                context: BusinessRulesValidationAgentProvider.name,
                serviceName: BusinessRulesValidationAgentProvider.name,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    teamId: context.organizationAndTeamData?.teamId,
                    completedSteps: result.completedSteps,
                    skippedAt: result.skippedAt,
                    responseLength: finalCtx.formattedResponse?.length ?? 0,
                },
            });

            return finalCtx.formattedResponse ?? '';
        } catch (error) {
            this.logger.error({
                message: 'Error during business rules validation',
                context: BusinessRulesValidationAgentProvider.name,
                serviceName: BusinessRulesValidationAgentProvider.name,
                metadata: {
                    error,
                    organizationAndTeamData: context.organizationAndTeamData,
                    thread: context.thread,
                },
            });
            throw error;
        }
    }

    // ─── Blueprint resolution ─────────────────────────────────────────────────

    /**
     * Builds a resolved blueprint where placeholder deterministic fns in blueprint.ts
     * are replaced with the real fetcher orchestration calls.
     */
    private buildResolvedBlueprint() {
        return businessRulesBlueprint.map((step) => {
            if (
                step.type === 'deterministic' &&
                (step.name === 'fetchPRContext' ||
                    step.name === 'fetchTaskContext')
            ) {
                return {
                    ...step,
                    fn: (ctx: BusinessRulesContext) =>
                        this.runFetcherStep(ctx),
                };
            }
            if (step.type === 'format' && step.name === 'formatResponse') {
                return {
                    ...step,
                    fn: (ctx: BusinessRulesContext) =>
                        this.formatStep(ctx),
                };
            }
            return step;
        });
    }

    // ─── Step implementations ─────────────────────────────────────────────────

    /**
     * Fetcher step: runs the fetcher agent (maxIterations: 4, with MCP tools)
     * to retrieve PR diff, PR body, task context, and task quality.
     *
     * Both fetchPRContext and fetchTaskContext steps call this same method.
     * The fetcher agent handles both in a single orchestrated call.
     */
    private async runFetcherStep(
        ctx: BusinessRulesContext,
    ): Promise<BusinessRulesContext> {
        // If we already ran the fetcher (second deterministic step), skip
        if (ctx.taskQuality !== undefined) return ctx;

        const fetchPrompt = this.buildFetcherPrompt(ctx);

        const fetchResult = await this.fetcherOrchestration.callAgent(
            'kodus-business-rules-fetcher',
            fetchPrompt,
            {
                thread: ctx.thread as Thread,
                userContext: {
                    organizationAndTeamData: ctx.organizationAndTeamData,
                },
            },
        );

        return this.parseFetcherResult(fetchResult.result, ctx);
    }

    /**
     * LLM step: initializes the analyzer agent (maxIterations: 1, no MCP)
     * with SKILL.md instructions and calls it with structured context.
     */
    private async runAnalyzerStep(
        _step: LLMStep,
        ctx: BusinessRulesContext,
    ): Promise<BusinessRulesContext> {
        const orgAndTeamData =
            ctx.organizationAndTeamData as OrganizationAndTeamData;

        // Load instructions: team DB override first, filesystem SKILL.md as fallback
        const skillInstructions =
            await this.skillLoaderService.loadInstructions(
                'business-rules-validation',
                orgAndTeamData,
            );

        await this.initializeAnalyzer(orgAndTeamData, skillInstructions);

        const analysisPrompt = this.buildAnalysisPrompt(ctx);

        const analysisResult = await this.analyzerOrchestration.callAgent(
            'kodus-business-rules-analyzer',
            analysisPrompt,
            {
                thread: ctx.thread as Thread,
                userContext: {
                    organizationAndTeamData: orgAndTeamData,
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

    /**
     * Format step: identity transform — result is already formatted by runAnalyzerStep.
     */
    private formatStep(ctx: BusinessRulesContext): BusinessRulesContext {
        return ctx;
    }

    // ─── Agent initialization ─────────────────────────────────────────────────

    protected async createMCPAdapter(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        const mcpManagerServers =
            await this.mcpManagerService?.getConnections(
                organizationAndTeamData,
            );

        if (!mcpManagerServers?.length) {
            this.mcpAdapter = null;
            return;
        }

        const meta = this.skillLoaderService.loadSkillMetaFromFilesystem(
            'business-rules-validation',
        );
        const requiredTools = meta.allowedTools?.length
            ? meta.allowedTools
            : ['KODUS_GET_PULL_REQUEST_DIFF', 'KODUS_GET_PULL_REQUEST'];

        const filteredServers = mcpManagerServers.filter((server) => {
            if (server.provider !== 'kodusmcp') return true;
            return requiredTools.some((tool) =>
                server.allowedTools.includes(tool),
            );
        });

        if (filteredServers.length === 0) {
            this.mcpAdapter = null;
            return;
        }

        const servers = filteredServers.map((server) => {
            if (server.provider === 'kodusmcp') {
                return {
                    ...server,
                    allowedTools: server.allowedTools.filter((tool) =>
                        requiredTools.includes(tool),
                    ),
                };
            }
            return server;
        });

        this.mcpAdapter = createMCPAdapter({
            servers,
            defaultTimeout: 15_000,
            maxRetries: 2,
            onError: (err) => {
                console.error('Business Rules MCP error:', err.message);
            },
        });
    }

    private async initializeFetcher(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        await this.createMCPAdapter(organizationAndTeamData);

        this.llmAdapter = super.createLLMAdapter(
            'BusinessRulesValidation',
            'businessRulesFetcher',
        );

        this.fetcherOrchestration = await createOrchestration({
            tenantId: 'kodus-agent-business-rules-fetcher',
            llmAdapter: this.llmAdapter,
            mcpAdapter: this.mcpAdapter,
            observability:
                this.observabilityService.getAgentObservabilityConfig(
                    'kodus-business-rules-fetcher',
                ),
            storage: this.observabilityService.getStorageConfig(),
        });

        try {
            await this.fetcherOrchestration.connectMCP();
            await this.fetcherOrchestration.registerMCPTools();
        } catch {
            console.warn('Business Rules Fetcher: MCP offline, continuing.');
        }

        await this.fetcherOrchestration.createAgent({
            name: 'kodus-business-rules-fetcher',
            identity: {
                goal: 'Fetch PR context and task/ticket context from external systems. Return structured JSON with prDiff, prBody, taskContext, and taskQuality.',
                description: `Context fetcher for business rules validation.

Fetch the following information using available tools:
1. PR diff using KODUS_GET_PULL_REQUEST_DIFF
2. PR description/body using KODUS_GET_PULL_REQUEST
3. Linked task context from available project management tools (Jira, Notion, Linear, etc.)
4. Assess taskQuality: EMPTY (no task found), MINIMAL (title only), PARTIAL (some description), COMPLETE (description + acceptance criteria)

Return ONLY a JSON object:
{
  "prDiff": "...",
  "prBody": "...",
  "taskContext": "...",
  "taskQuality": "EMPTY|MINIMAL|PARTIAL|COMPLETE"
}`,
                language: 'en-US',
            },
            maxIterations: 4,
            timeout: 120000,
            plannerOptions: { type: PlannerType.REACT },
        });
    }

    private async initializeAnalyzer(
        _organizationAndTeamData: OrganizationAndTeamData,
        skillInstructions: string,
    ): Promise<void> {
        const analyzerLLMAdapter = super.createLLMAdapter(
            'BusinessRulesValidation',
            'businessRulesAnalyzer',
        );

        this.analyzerOrchestration = await createOrchestration({
            tenantId: 'kodus-agent-business-rules-analyzer',
            llmAdapter: analyzerLLMAdapter,
            observability:
                this.observabilityService.getAgentObservabilityConfig(
                    'kodus-business-rules-analyzer',
                ),
            storage: this.observabilityService.getStorageConfig(),
        });

        await this.analyzerOrchestration.createAgent({
            name: 'kodus-business-rules-analyzer',
            identity: {
                goal: skillInstructions,
                description:
                    'Business rules gap analyzer. No tool access. Receives structured context. Returns JSON only.',
                language: 'en-US',
            },
            maxIterations: 1,
            timeout: 120000,
            plannerOptions: { type: PlannerType.REACT },
        });
    }

    // ─── Prompt builders ──────────────────────────────────────────────────────

    private buildFetcherPrompt(ctx: BusinessRulesContext): string {
        return `Fetch context for business rules validation.

USER REQUEST: ${ctx.prepareContext?.userQuestion ?? 'Analyze business rules compliance'}

Use available tools to:
1. Get the PR diff and PR description
2. Get the linked task/ticket context
3. Assess task quality

Return ONLY a JSON object with prDiff, prBody, taskContext, and taskQuality.`;
    }

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

    // ─── Result parsers ───────────────────────────────────────────────────────

    private parseFetcherResult(
        result: any,
        ctx: BusinessRulesContext,
    ): BusinessRulesContext {
        try {
            const parsed =
                typeof result === 'string' ? JSON.parse(result) : result;

            return {
                ...ctx,
                prDiff: parsed?.prDiff ?? '',
                prBody: parsed?.prBody ?? '',
                taskContext: parsed?.taskContext ?? '',
                taskQuality: (parsed?.taskQuality as TaskQuality) ?? 'EMPTY',
            };
        } catch {
            return { ...ctx, prDiff: '', prBody: '', taskContext: '', taskQuality: 'EMPTY' };
        }
    }

    private parseValidationResult(result: any): ValidationResult {
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
            return {
                needsMoreInfo: result.needsMoreInfo === true,
                missingInfo: result.missingInfo ?? '',
                summary:
                    result.summary ?? 'Business rules validation completed.',
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

        // Non-backtracking regex to prevent ReDoS
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
