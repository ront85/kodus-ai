import { SkillLoaderService } from '@libs/agents/skills/skill-loader.service';

describe('SkillLoaderService', () => {
    it('loads instructions from SKILL.md for business-rules-validation', () => {
        const service = new SkillLoaderService();

        const instructions = service.loadInstructions(
            'business-rules-validation',
        );

        expect(instructions).toContain('# Business Rules Gap Analysis');
        expect(instructions).not.toContain('## Reference Material');
    });

    it('loads skill metadata from SKILL.md frontmatter', () => {
        const service = new SkillLoaderService();

        const meta =
            service.loadSkillMetaFromFilesystem('business-rules-validation');

        expect(meta.name).toBe('business-rules-validation');
        expect(meta.apiVersion).toBe('skills.kodus.ai/v1');
        expect(meta.kind).toBe('Skill');
        expect(meta.version).toBe('1.0.0');
        expect(meta.capabilities).toEqual([
            'pr.metadata.read',
            'pr.diff.read',
            'task.context.read',
        ]);
        expect(meta.allowedTools).toEqual([
            'KODUS_GET_PULL_REQUEST',
            'KODUS_GET_PULL_REQUEST_DIFF',
        ]);
        expect(meta.fetcherPolicy).toEqual({
            toolMode: 'any',
            allowWithoutTools: false,
        });
        expect(meta.executionPolicy).toEqual({
            onMissingMcp: 'fail',
            onMcpConnectError: 'fail',
            fetcherTimeoutMs: 120000,
            analyzerTimeoutMs: 120000,
            fetcherMaxIterations: 4,
            analyzerMaxIterations: 1,
        });
        expect(meta.contracts).toEqual({
            input: {
                requiredContextFields: [
                    'organizationAndTeamData.organizationId',
                    'organizationAndTeamData.teamId',
                    'prepareContext.pullRequestNumber',
                    'prepareContext.repository.id',
                ],
            },
            output: {
                requiredFields: ['needsMoreInfo', 'summary'],
            },
        });
        expect(meta.requiredMcps).toEqual([
            {
                category: 'task-management',
                label: 'Task Management',
                examples: 'Jira, Linear, Notion, ClickUp',
            },
        ]);
    });

    it('parses complex YAML frontmatter using a YAML parser', () => {
        const service = new SkillLoaderService() as any;

        const parsed = service.parseFrontmatter(`---
name: business-rules-validation
description: >
  Validate PR code changes against task requirements
  with multiline YAML support
allowed-tools:
  - "KODUS_GET_PULL_REQUEST_DIFF"
fetcher-policy:
  tool-mode: all
  allow-without-tools: false
required-mcps:
  - category: task-management
    label: "Task Management"
    examples: "Jira: Cloud, Linear"
metadata:
  version: "2.0.0"
execution-policy:
  on-missing-mcp: fallback
  on-mcp-connect-error: fail
  fetcher-timeout-ms: 50000
contracts:
  input:
    required-context-fields:
      - "prepareContext.pullRequestNumber"
  output:
    required-fields:
      - "summary"
---

# Body`);

        expect(parsed.meta.description).toBe(
            'Validate PR code changes against task requirements with multiline YAML support\n',
        );
        expect(parsed.meta.allowedTools).toEqual(['KODUS_GET_PULL_REQUEST_DIFF']);
        expect(parsed.meta.fetcherPolicy).toEqual({
            toolMode: 'all',
            allowWithoutTools: false,
        });
        expect(parsed.meta.requiredMcps).toEqual([
            {
                category: 'task-management',
                label: 'Task Management',
                examples: 'Jira: Cloud, Linear',
            },
        ]);
        expect(parsed.meta.version).toBe('2.0.0');
        expect(parsed.meta.executionPolicy).toEqual({
            onMissingMcp: 'fallback',
            onMcpConnectError: 'fail',
            fetcherTimeoutMs: 50000,
            analyzerTimeoutMs: undefined,
            fetcherMaxIterations: undefined,
            analyzerMaxIterations: undefined,
        });
        expect(parsed.meta.contracts).toEqual({
            input: {
                requiredContextFields: ['prepareContext.pullRequestNumber'],
            },
            output: {
                requiredFields: ['summary'],
            },
        });
    });
});
