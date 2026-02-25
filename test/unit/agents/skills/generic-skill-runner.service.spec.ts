import { createMCPAdapter, createOrchestration } from '@kodus/flow';

import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { GenericSkillRunnerService } from '@libs/agents/skills/generic-skill-runner.service';
import {
    McpConnectionUnavailableError,
    RequiredMcpPreflightError,
    SkillInputContractViolationError,
    SkillOutputContractViolationError,
} from '@libs/agents/skills/skill.errors';
import { SkillLoaderService } from '@libs/agents/skills/skill-loader.service';

jest.mock('@kodus/flow', () => ({
    createMCPAdapter: jest.fn(),
    createOrchestration: jest.fn(),
    PlannerType: { REACT: 'REACT' },
}));

describe('GenericSkillRunnerService', () => {
    const createOrchestrationMock = createOrchestration as jest.Mock;
    const createMCPAdapterMock = createMCPAdapter as jest.Mock;

    const makeOrchestrator = () => ({
        connectMCP: jest.fn().mockResolvedValue(undefined),
        registerMCPTools: jest.fn().mockResolvedValue(undefined),
        createAgent: jest.fn().mockResolvedValue(undefined),
    });

    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    } as any;

    let skillLoaderService: jest.Mocked<SkillLoaderService>;
    let observabilityService: jest.Mocked<ObservabilityService>;
    let mcpManagerService: jest.Mocked<MCPManagerService>;
    let service: GenericSkillRunnerService;

    beforeEach(() => {
        skillLoaderService = {
            loadSkillMetaFromFilesystem: jest.fn(),
            loadInstructions: jest.fn(),
        } as any;

        observabilityService = {
            getAgentObservabilityConfig: jest.fn().mockReturnValue({}),
            getStorageConfig: jest.fn().mockReturnValue({}),
        } as any;

        mcpManagerService = {
            getConnections: jest.fn().mockResolvedValue([
                {
                    provider: 'kodusmcp',
                    allowedTools: ['KODUS_GET_PULL_REQUEST'],
                },
            ]),
        } as any;

        createOrchestrationMock.mockResolvedValue(makeOrchestrator());
        createMCPAdapterMock.mockReturnValue({} as any);

        service = new GenericSkillRunnerService(
            skillLoaderService,
            observabilityService,
            mcpManagerService,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('caches skill metadata by skill name for fetcher orchestration', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue({
            allowedTools: ['KODUS_GET_PULL_REQUEST'],
        });

        await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );
        await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(skillLoaderService.loadSkillMetaFromFilesystem).toHaveBeenCalledTimes(
            1,
        );
    });

    it('caches analyzer instructions by skill name', async () => {
        skillLoaderService.loadInstructions.mockReturnValue('analyzer instructions');

        await service.createAnalyzerOrchestration(
            'business-rules-validation',
            {} as any,
        );
        await service.createAnalyzerOrchestration(
            'business-rules-validation',
            {} as any,
        );

        expect(skillLoaderService.loadInstructions).toHaveBeenCalledTimes(1);
    });

    it('fails fast when required MCP categories are declared and no external MCP is connected', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue({
            requiredMcps: [
                {
                    category: 'task-management',
                    label: 'Task Management',
                    examples: 'Jira, Linear',
                },
            ],
        });
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                allowedTools: ['KODUS_GET_PULL_REQUEST'],
            },
        ] as any);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).rejects.toBeInstanceOf(RequiredMcpPreflightError);
    });

    it('throws typed MCP connection error when required MCP exists but all connections fail', async () => {
        const orchestrator = makeOrchestrator();
        orchestrator.connectMCP.mockRejectedValue(
            new Error('Failed to connect to any MCP server'),
        );
        createOrchestrationMock.mockResolvedValue(orchestrator);

        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue({
            requiredMcps: [
                {
                    category: 'task-management',
                    label: 'Task Management',
                    examples: 'Jira, Linear',
                },
            ],
        });

        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'jira',
                allowedTools: ['JIRA_GET_ISSUE'],
            },
        ] as any);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).rejects.toBeInstanceOf(McpConnectionUnavailableError);
    });

    it('throws typed MCP connection error for optional MCP skills when MCP connection fails', async () => {
        const orchestrator = makeOrchestrator();
        orchestrator.connectMCP.mockRejectedValue(
            new Error('Failed to connect to any MCP server'),
        );
        createOrchestrationMock.mockResolvedValue(orchestrator);

        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue({
            requiredMcps: undefined,
        });

        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                allowedTools: ['KODUS_GET_PULL_REQUEST'],
            },
        ] as any);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).rejects.toBeInstanceOf(McpConnectionUnavailableError);
        expect(orchestrator.registerMCPTools).not.toHaveBeenCalled();
    });

    it('throws typed MCP connection error when no MCP tools are available', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue({
            requiredMcps: undefined,
        });
        mcpManagerService.getConnections.mockResolvedValue([] as any);
        createMCPAdapterMock.mockReturnValue(null);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).rejects.toBeInstanceOf(McpConnectionUnavailableError);
    });

    it('allows fallback without tools when fetcher-policy enables it', async () => {
        const orchestrator = makeOrchestrator();
        createOrchestrationMock.mockResolvedValue(orchestrator);
        createMCPAdapterMock.mockReturnValue(null);

        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue({
            allowedTools: ['KODUS_GET_PULL_REQUEST_DIFF'],
            fetcherPolicy: {
                allowWithoutTools: true,
                toolMode: 'all',
            },
        });
        mcpManagerService.getConnections.mockResolvedValue([] as any);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).resolves.toBeDefined();

        expect(orchestrator.connectMCP).not.toHaveBeenCalled();
        expect(orchestrator.registerMCPTools).not.toHaveBeenCalled();
        expect(orchestrator.createAgent).toHaveBeenCalled();
    });

    it('resolves required tools from declared capabilities', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue({
            capabilities: ['pr.diff.read'],
            fetcherPolicy: {
                toolMode: 'all',
                allowWithoutTools: false,
            },
        });
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                allowedTools: ['KODUS_GET_PULL_REQUEST_DIFF'],
            },
        ] as any);

        await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(createMCPAdapterMock).toHaveBeenCalledWith(
            expect.objectContaining({
                servers: expect.arrayContaining([
                    expect.objectContaining({
                        provider: 'kodusmcp',
                        allowedTools: ['KODUS_GET_PULL_REQUEST_DIFF'],
                    }),
                ]),
            }),
        );
    });

    it('throws typed input contract violation when required context fields are missing', () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue({
            contracts: {
                input: {
                    requiredContextFields: [
                        'prepareContext.pullRequestNumber',
                        'prepareContext.repository.id',
                    ],
                },
            },
        });

        expect(() =>
            service.validateInputContract('business-rules-validation', {
                prepareContext: {},
            }),
        ).toThrow(SkillInputContractViolationError);
    });

    it('throws typed output contract violation when required fields are missing', () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue({
            contracts: {
                output: {
                    requiredFields: ['summary', 'needsMoreInfo'],
                },
            },
        });

        expect(() =>
            service.validateOutputContract('business-rules-validation', {
                summary: 'ok',
            }),
        ).toThrow(SkillOutputContractViolationError);
    });

    it('records setup metrics with stage/status labels on fetcher success', async () => {
        const metricsCollector = {
            recordHistogram: jest.fn(),
            recordCounter: jest.fn(),
            recordGauge: jest.fn(),
        } as unknown as jest.Mocked<MetricsCollectorService>;

        const serviceWithMetrics = new GenericSkillRunnerService(
            skillLoaderService,
            observabilityService,
            mcpManagerService,
            metricsCollector,
        );

        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue({
            fetcherPolicy: { allowWithoutTools: true, toolMode: 'all' },
        });
        mcpManagerService.getConnections.mockResolvedValue([] as any);
        createMCPAdapterMock.mockReturnValue(null);

        await serviceWithMetrics.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(metricsCollector.recordHistogram).toHaveBeenCalledWith(
            'kodus_skill_setup_duration_ms',
            expect.any(Number),
            expect.objectContaining({
                skill: 'business-rules-validation',
                stage: 'fetcher',
                status: 'success',
            }),
        );
        expect(metricsCollector.recordCounter).toHaveBeenCalledWith(
            'kodus_skill_setup_total',
            1,
            expect.objectContaining({
                skill: 'business-rules-validation',
                stage: 'fetcher',
                status: 'success',
            }),
        );
    });

    it('records setup failure metrics when fetcher initialization fails', async () => {
        const metricsCollector = {
            recordHistogram: jest.fn(),
            recordCounter: jest.fn(),
            recordGauge: jest.fn(),
        } as unknown as jest.Mocked<MetricsCollectorService>;

        const serviceWithMetrics = new GenericSkillRunnerService(
            skillLoaderService,
            observabilityService,
            mcpManagerService,
            metricsCollector,
        );

        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue({
            fetcherPolicy: { allowWithoutTools: false, toolMode: 'all' },
        });
        mcpManagerService.getConnections.mockResolvedValue([] as any);
        createMCPAdapterMock.mockReturnValue(null);

        await expect(
            serviceWithMetrics.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).rejects.toBeInstanceOf(McpConnectionUnavailableError);

        expect(metricsCollector.recordHistogram).toHaveBeenCalledWith(
            'kodus_skill_setup_duration_ms',
            expect.any(Number),
            expect.objectContaining({
                skill: 'business-rules-validation',
                stage: 'fetcher',
                status: 'failed',
            }),
        );
        expect(metricsCollector.recordCounter).toHaveBeenCalledWith(
            'kodus_skill_setup_total',
            1,
            expect.objectContaining({
                skill: 'business-rules-validation',
                stage: 'fetcher',
                status: 'failed',
            }),
        );
    });
});
