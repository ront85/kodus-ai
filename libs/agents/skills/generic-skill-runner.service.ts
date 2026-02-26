import {
    createMCPAdapter,
    createOrchestration,
    LLMAdapter,
    MCPAdapter,
    PlannerType,
    Thread,
} from '@kodus/flow';
import { SDKOrchestrator } from '@kodus/flow/dist/orchestration';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

import {
    McpConnectionUnavailableError,
    RequiredMcpPreflightError,
    SkillInputContractViolationError,
    SkillOutputContractViolationError,
} from './skill.errors';
import { resolveCapabilityTools } from './skill-capabilities';
import {
    SkillExecutionPolicy,
    SkillFetcherPolicy,
    SkillLoaderService,
    SkillMeta,
    SkillRequiredMcp,
} from './skill-loader.service';

export interface SkillFetcherResult {
    raw: string;
    parsed: Record<string, unknown>;
}

export interface SkillRunInput {
    organizationAndTeamData: OrganizationAndTeamData;
    thread?: Thread;
    fetcherPrompt: string;
    analyzerPrompt: string;
}

type ResolvedExecutionPolicy = Required<
    Pick<
        SkillExecutionPolicy,
        | 'onMissingMcp'
        | 'onMcpConnectError'
        | 'fetcherTimeoutMs'
        | 'analyzerTimeoutMs'
        | 'fetcherMaxIterations'
        | 'analyzerMaxIterations'
    >
>;

/**
 * Shared infrastructure for the fetcher+analyzer pattern used by all PR-level skills.
 *
 * Each skill agent is responsible for:
 *  - Building the fetcher and analyzer prompts
 *  - Parsing and interpreting the raw result
 *
 * GenericSkillRunnerService handles:
 *  - MCP adapter creation (from SKILL.md allowed-tools)
 *  - Fetcher orchestration (with MCP tools, maxIterations: 4)
 *  - Analyzer orchestration (instructions from SKILL.md, no tools, maxIterations: 1)
 */
@Injectable()
export class GenericSkillRunnerService {
    private readonly logger = new Logger(GenericSkillRunnerService.name);
    private readonly instructionsCache = new Map<string, string>();
    private readonly metaCache = new Map<string, SkillMeta>();

    constructor(
        private readonly skillLoaderService: SkillLoaderService,
        private readonly observabilityService: ObservabilityService,
        private readonly mcpManagerService?: MCPManagerService,
        @Optional() private readonly metricsCollector?: MetricsCollectorService,
    ) {}

    /**
     * Creates a ready-to-use fetcher orchestration for a skill.
     * Connects MCP tools based on SKILL.md allowed-tools frontmatter.
     */
    async createFetcherOrchestration(
        skillName: string,
        llmAdapter: LLMAdapter,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<SDKOrchestrator> {
        const startedAt = Date.now();
        try {
            const meta = this.getSkillMeta(skillName);
            this.validateSkillSchema(meta, skillName);
            const fetcherPolicy = this.resolveFetcherPolicy(meta.fetcherPolicy);
            const executionPolicy = this.resolveExecutionPolicy(
                meta.executionPolicy,
                fetcherPolicy,
            );
            const requiredTools = this.resolveRequiredTools(meta, skillName);
            const mcpManagerServers =
                await this.mcpManagerService?.getConnections(
                    organizationAndTeamData,
                );
            const availableProviders =
                this.getAvailableProviders(mcpManagerServers);

            this.preflightRequiredMcps(
                skillName,
                meta.requiredMcps,
                mcpManagerServers,
            );

            const mcpAdapter = this.createMCPAdapter(
                skillName,
                requiredTools,
                fetcherPolicy,
                mcpManagerServers,
            );
            this.metricsCollector?.recordGauge(
                'kodus_skill_required_tools_total',
                requiredTools.length,
                { skill: skillName },
            );

            if (!mcpAdapter) {
                if (executionPolicy.onMissingMcp === 'fallback') {
                    this.logger.warn(
                        `[GenericSkillRunner] No MCP tools available for skill '${skillName}', but policy allows fallback without tools.`,
                    );
                    this.metricsCollector?.recordCounter(
                        'kodus_skill_mcp_fallback_total',
                        1,
                        { skill: skillName, reason: 'missing_mcp_or_tools' },
                    );
                } else {
                    this.metricsCollector?.recordCounter(
                        'kodus_skill_mcp_failfast_total',
                        1,
                        { skill: skillName, reason: 'missing_mcp_or_tools' },
                    );
                    throw new McpConnectionUnavailableError({
                        skillName,
                        availableProviders,
                        causeMessage:
                            'No MCP tools available for this skill with current connections.',
                    });
                }
            }

            const orchestration = await createOrchestration({
                tenantId: `kodus-skill-fetcher-${skillName}`,
                llmAdapter,
                mcpAdapter,
                observability:
                    this.observabilityService.getAgentObservabilityConfig(
                        `kodus-${skillName}-fetcher`,
                    ),
                storage: this.observabilityService.getStorageConfig(),
            });

            if (mcpAdapter) {
                try {
                    await orchestration.connectMCP();
                    await orchestration.registerMCPTools();
                } catch (error) {
                    if (executionPolicy.onMcpConnectError === 'fallback') {
                        this.logger.warn(
                            `[GenericSkillRunner] MCP connection failed for skill '${skillName}', but policy allows fallback without tools. Error: ${
                                error instanceof Error
                                    ? error.message
                                    : String(error)
                            }`,
                        );
                        this.metricsCollector?.recordCounter(
                            'kodus_skill_mcp_fallback_total',
                            1,
                            { skill: skillName, reason: 'connect_error' },
                        );
                    } else {
                        this.metricsCollector?.recordCounter(
                            'kodus_skill_mcp_failfast_total',
                            1,
                            { skill: skillName, reason: 'connect_error' },
                        );
                        throw new McpConnectionUnavailableError({
                            skillName,
                            availableProviders,
                            causeMessage:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        });
                    }
                }
            }

            await orchestration.createAgent({
                name: `kodus-${skillName}-fetcher`,
                identity: {
                    goal: `Fetch all relevant context for the ${skillName} skill using available tools. Return structured JSON with the gathered data.`,
                    description: `Context fetcher for ${skillName}.`,
                    language: 'en-US',
                },
                maxIterations: executionPolicy.fetcherMaxIterations,
                timeout: executionPolicy.fetcherTimeoutMs,
                plannerOptions: { type: PlannerType.REACT },
            });

            this.recordSetupMetric(skillName, 'fetcher', 'success', startedAt);
            return orchestration;
        } catch (error) {
            this.recordSetupMetric(skillName, 'fetcher', 'failed', startedAt);
            throw error;
        }
    }

    /**
     * Creates a ready-to-use analyzer orchestration for a skill.
     * Loads instructions from SKILL.md (body + references).
     */
    async createAnalyzerOrchestration(
        skillName: string,
        llmAdapter: LLMAdapter,
    ): Promise<SDKOrchestrator> {
        const startedAt = Date.now();
        try {
            const meta = this.getSkillMeta(skillName);
            this.validateSkillSchema(meta, skillName);
            const fetcherPolicy = this.resolveFetcherPolicy(meta.fetcherPolicy);
            const executionPolicy = this.resolveExecutionPolicy(
                meta.executionPolicy,
                fetcherPolicy,
            );
            const instructions = this.getSkillInstructions(skillName);

            const orchestration = await createOrchestration({
                tenantId: `kodus-skill-analyzer-${skillName}`,
                llmAdapter,
                observability:
                    this.observabilityService.getAgentObservabilityConfig(
                        `kodus-${skillName}-analyzer`,
                    ),
                storage: this.observabilityService.getStorageConfig(),
            });

            await orchestration.createAgent({
                name: `kodus-${skillName}-analyzer`,
                identity: {
                    goal: instructions,
                    description: `${skillName} analyzer. No tool access. Receives structured context. Returns analysis.`,
                    language: 'en-US',
                },
                maxIterations: executionPolicy.analyzerMaxIterations,
                timeout: executionPolicy.analyzerTimeoutMs,
                plannerOptions: { type: PlannerType.REACT },
            });

            this.recordSetupMetric(skillName, 'analyzer', 'success', startedAt);
            return orchestration;
        } catch (error) {
            this.recordSetupMetric(skillName, 'analyzer', 'failed', startedAt);
            throw error;
        }
    }

    validateInputContract(
        skillName: string,
        context: unknown,
    ): void {
        const meta = this.getSkillMeta(skillName);
        const requiredFields = meta.contracts?.input?.requiredContextFields ?? [];

        if (!requiredFields.length) {
            return;
        }

        const contextRecord = this.asRecord(context);
        const missingFields = requiredFields.filter(
            (path) => this.readPath(contextRecord, path) === undefined,
        );
        if (missingFields.length > 0) {
            throw new SkillInputContractViolationError(skillName, missingFields);
        }
    }

    validateOutputContract(
        skillName: string,
        output: unknown,
    ): void {
        const meta = this.getSkillMeta(skillName);
        const requiredFields = meta.contracts?.output?.requiredFields ?? [];

        if (!requiredFields.length) {
            return;
        }

        const outputRecord = this.asRecord(output);
        const missingFields = requiredFields.filter(
            (path) => this.readPath(outputRecord, path) === undefined,
        );
        if (missingFields.length > 0) {
            throw new SkillOutputContractViolationError(skillName, missingFields);
        }
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private getSkillMeta(skillName: string): SkillMeta {
        const cached = this.metaCache.get(skillName);
        if (cached) {
            return cached;
        }

        const meta =
            this.skillLoaderService.loadSkillMetaFromFilesystem(skillName) ?? {};
        this.metaCache.set(skillName, meta);
        return meta;
    }

    private getSkillInstructions(skillName: string): string {
        const cached = this.instructionsCache.get(skillName);
        if (cached) {
            return cached;
        }

        const instructions = this.skillLoaderService.loadInstructions(skillName);
        this.instructionsCache.set(skillName, instructions);
        return instructions;
    }

    private preflightRequiredMcps(
        skillName: string,
        requiredMcps: SkillRequiredMcp[] | undefined,
        mcpManagerServers: any[] | undefined,
    ) {
        if (!requiredMcps?.length) {
            return;
        }

        const availableProviders = this.getAvailableProviders(mcpManagerServers);

        const externalConnections = (mcpManagerServers ?? []).filter(
            (server) =>
                String(server?.provider ?? '')
                    .trim()
                    .toLowerCase() !== 'kodusmcp',
        );

        if (!externalConnections.length) {
            this.logger.warn(
                `[GenericSkillRunner] Missing required external MCP for skill '${skillName}'. Available providers: ${
                    availableProviders.length
                        ? availableProviders.join(', ')
                        : 'none'
                }`,
            );
            throw new RequiredMcpPreflightError(
                skillName,
                requiredMcps,
                availableProviders,
            );
        }
    }

    private createMCPAdapter(
        skillName: string,
        requiredTools: string[] | undefined,
        fetcherPolicy: Required<SkillFetcherPolicy>,
        mcpManagerServers: any[] | undefined,
    ): MCPAdapter | null {
        if (!mcpManagerServers?.length) {
            this.logger.warn(
                `[GenericSkillRunner] No MCP servers available for skill '${skillName}'.`,
            );
            return null;
        }

        const resolvedRequiredTools = requiredTools?.length ? requiredTools : [];
        const hasRequiredTools = this.hasRequiredKodusTools(
            mcpManagerServers,
            resolvedRequiredTools,
            fetcherPolicy,
        );

        const filteredServers = mcpManagerServers
            .filter((server) => {
                if (server.provider !== 'kodusmcp') {
                    return true;
                }
                if (!resolvedRequiredTools.length) {
                    return true;
                }
                const availableTools = Array.isArray(server.allowedTools)
                    ? server.allowedTools
                    : [];
                return resolvedRequiredTools.some((tool) =>
                    availableTools.includes(tool),
                );
            })
            .map((server) => {
                if (server.provider === 'kodusmcp') {
                    if (!resolvedRequiredTools.length) {
                        return server;
                    }
                    return {
                        ...server,
                        allowedTools: Array.isArray(server.allowedTools)
                            ? server.allowedTools.filter((tool) =>
                                  resolvedRequiredTools.includes(tool),
                              )
                            : [],
                    };
                }
                return server;
            });

        if (!filteredServers.length) {
            return null;
        }
        if (resolvedRequiredTools.length && !hasRequiredTools) {
            this.logger.warn(
                `[GenericSkillRunner] Required tools not available for skill '${skillName}'. toolMode=${fetcherPolicy.toolMode}, requiredTools=${resolvedRequiredTools.join(
                    ', ',
                )}`,
            );
            return null;
        }

        return createMCPAdapter({
            servers: filteredServers,
            defaultTimeout: 15_000,
            maxRetries: 2,
            onError: (err) =>
                this.logger.error(
                    `[GenericSkillRunner] MCP error for skill '${skillName}': ${err.message}`,
                ),
        });
    }

    private getAvailableProviders(mcpManagerServers: any[] | undefined): string[] {
        return (mcpManagerServers ?? []).map((server) =>
            typeof server?.provider === 'string'
                ? server.provider
                : 'unknown-provider',
        );
    }

    private resolveFetcherPolicy(
        policy: SkillFetcherPolicy | undefined,
    ): Required<SkillFetcherPolicy> {
        return {
            toolMode: policy?.toolMode ?? 'any',
            allowWithoutTools: policy?.allowWithoutTools ?? false,
        };
    }

    private resolveExecutionPolicy(
        policy: SkillExecutionPolicy | undefined,
        fetcherPolicy: Required<SkillFetcherPolicy>,
    ): ResolvedExecutionPolicy {
        const fallbackDefault = fetcherPolicy.allowWithoutTools
            ? 'fallback'
            : 'fail';

        return {
            onMissingMcp: policy?.onMissingMcp ?? fallbackDefault,
            onMcpConnectError: policy?.onMcpConnectError ?? fallbackDefault,
            fetcherTimeoutMs: policy?.fetcherTimeoutMs ?? 120_000,
            analyzerTimeoutMs: policy?.analyzerTimeoutMs ?? 120_000,
            fetcherMaxIterations: policy?.fetcherMaxIterations ?? 4,
            analyzerMaxIterations: policy?.analyzerMaxIterations ?? 1,
        };
    }

    private resolveRequiredTools(meta: SkillMeta, skillName: string): string[] {
        const explicitTools = meta.allowedTools ?? [];
        const { tools: capabilityTools, unknownCapabilities } =
            resolveCapabilityTools(meta.capabilities);

        if (unknownCapabilities.length > 0) {
            this.logger.warn(
                `[GenericSkillRunner] Unknown capabilities in skill '${skillName}': ${unknownCapabilities.join(
                    ', ',
                )}`,
            );
        }

        return [...new Set([...explicitTools, ...capabilityTools])];
    }

    private validateSkillSchema(meta: SkillMeta, skillName: string): void {
        const apiVersion = meta.apiVersion ?? 'skills.kodus.ai/v1';
        const kind = meta.kind ?? 'Skill';

        const supportedVersions = new Set(['skills.kodus.ai/v1']);
        if (!supportedVersions.has(apiVersion)) {
            this.logger.warn(
                `[GenericSkillRunner] Skill '${skillName}' uses unsupported apiVersion '${apiVersion}'. Falling back to compatibility mode.`,
            );
        }

        if (kind !== 'Skill') {
            this.logger.warn(
                `[GenericSkillRunner] Skill '${skillName}' has unexpected kind '${kind}'. Expected 'Skill'.`,
            );
        }
    }

    private readPath(input: Record<string, unknown>, path: string): unknown {
        if (!path.trim().length) {
            return undefined;
        }

        return path.split('.').reduce<unknown>((acc, key) => {
            if (!acc || typeof acc !== 'object') {
                return undefined;
            }

            return (acc as Record<string, unknown>)[key];
        }, input);
    }

    private hasRequiredKodusTools(
        servers: any[] | undefined,
        requiredTools: string[],
        fetcherPolicy: Required<SkillFetcherPolicy>,
    ): boolean {
        if (!requiredTools.length) {
            return true;
        }

        const kodusTools = new Set<string>();
        for (const server of servers ?? []) {
            if (server?.provider !== 'kodusmcp') {
                continue;
            }
            const tools = Array.isArray(server?.allowedTools)
                ? server.allowedTools
                : [];
            for (const tool of tools) {
                kodusTools.add(tool);
            }
        }

        if (fetcherPolicy.toolMode === 'all') {
            return requiredTools.every((tool) => kodusTools.has(tool));
        }

        return requiredTools.some((tool) => kodusTools.has(tool));
    }

    private asRecord(value: unknown): Record<string, unknown> {
        if (!value || typeof value !== 'object') {
            return {};
        }
        return value as Record<string, unknown>;
    }

    private recordSetupMetric(
        skillName: string,
        stage: 'fetcher' | 'analyzer',
        status: 'success' | 'failed',
        startedAt: number,
    ): void {
        const labels = { skill: skillName, stage, status };
        this.metricsCollector?.recordHistogram(
            'kodus_skill_setup_duration_ms',
            Date.now() - startedAt,
            labels,
        );
        this.metricsCollector?.recordCounter('kodus_skill_setup_total', 1, labels);
    }
}
