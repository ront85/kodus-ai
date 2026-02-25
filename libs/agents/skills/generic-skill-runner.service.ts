import {
    createMCPAdapter,
    createOrchestration,
    LLMAdapter,
    PlannerType,
    Thread,
} from '@kodus/flow';
import { SDKOrchestrator } from '@kodus/flow/dist/orchestration';
import { Injectable, Logger } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

import { RequiredMcpPreflightError } from './skill.errors';
import {
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
        const meta = this.getSkillMeta(skillName);
        const mcpManagerServers = await this.mcpManagerService?.getConnections(
            organizationAndTeamData,
        );

        this.preflightRequiredMcps(
            skillName,
            meta.requiredMcps,
            mcpManagerServers,
        );

        const mcpAdapter = this.createMCPAdapter(
            skillName,
            meta.allowedTools,
            mcpManagerServers,
        );

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

        try {
            await orchestration.connectMCP();
            await orchestration.registerMCPTools();
        } catch {
            this.logger.warn(
                `[GenericSkillRunner] MCP offline for skill '${skillName}', continuing without tools.`,
            );
        }

        await orchestration.createAgent({
            name: `kodus-${skillName}-fetcher`,
            identity: {
                goal: `Fetch all relevant context for the ${skillName} skill using available tools. Return structured JSON with the gathered data.`,
                description: `Context fetcher for ${skillName}.`,
                language: 'en-US',
            },
            maxIterations: 4,
            timeout: 120_000,
            plannerOptions: { type: PlannerType.REACT },
        });

        return orchestration;
    }

    /**
     * Creates a ready-to-use analyzer orchestration for a skill.
     * Loads instructions from SKILL.md (body + references).
     */
    async createAnalyzerOrchestration(
        skillName: string,
        llmAdapter: LLMAdapter,
    ): Promise<SDKOrchestrator> {
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
            maxIterations: 1,
            timeout: 120_000,
            plannerOptions: { type: PlannerType.REACT },
        });

        return orchestration;
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private getSkillMeta(skillName: string): SkillMeta {
        const cached = this.metaCache.get(skillName);
        if (cached) {
            return cached;
        }

        const meta = this.skillLoaderService.loadSkillMetaFromFilesystem(skillName);
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

        const externalConnections = (mcpManagerServers ?? []).filter(
            (server) => server.provider !== 'kodusmcp',
        );

        if (!externalConnections.length) {
            throw new RequiredMcpPreflightError(skillName, requiredMcps);
        }
    }

    private createMCPAdapter(
        skillName: string,
        allowedTools: string[] | undefined,
        mcpManagerServers: any[] | undefined,
    ) {
        if (!mcpManagerServers?.length) {
            return null;
        }

        const requiredTools = allowedTools?.length
            ? allowedTools
            : ['KODUS_GET_PULL_REQUEST_DIFF', 'KODUS_GET_PULL_REQUEST'];

        const filteredServers = mcpManagerServers
            .filter((server) => {
                if (server.provider !== 'kodusmcp') {
                    return true;
                }
                return requiredTools.some((tool) =>
                    server.allowedTools.includes(tool),
                );
            })
            .map((server) => {
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

        if (!filteredServers.length) {
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
}
