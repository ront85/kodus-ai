import { createMCPAdapter, createOrchestration } from '@kodus/flow';

import { ObservabilityService } from '@libs/core/log/observability.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

import { GenericSkillRunnerService } from './generic-skill-runner.service';
import { RequiredMcpPreflightError } from './skill.errors';
import { SkillLoaderService } from './skill-loader.service';

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
            getConnections: jest.fn().mockResolvedValue([]),
        } as any;

        createOrchestrationMock.mockResolvedValue(makeOrchestrator());
        createMCPAdapterMock.mockReturnValue(null);

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
});
