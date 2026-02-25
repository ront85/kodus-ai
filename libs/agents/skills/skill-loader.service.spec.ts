import { SkillLoaderService } from './skill-loader.service';

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
        expect(meta.version).toBe('1.0.0');
        expect(meta.allowedTools).toEqual([
            'KODUS_GET_PULL_REQUEST',
            'KODUS_GET_PULL_REQUEST_DIFF',
        ]);
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
  - "KODUS_GET_PULL_REQUEST"
  - "KODUS_GET_PULL_REQUEST_DIFF"
required-mcps:
  - category: task-management
    label: "Task Management"
    examples: "Jira: Cloud, Linear"
metadata:
  version: "2.0.0"
---

# Body`);

        expect(parsed.meta.description).toBe(
            'Validate PR code changes against task requirements with multiline YAML support\n',
        );
        expect(parsed.meta.allowedTools).toEqual([
            'KODUS_GET_PULL_REQUEST',
            'KODUS_GET_PULL_REQUEST_DIFF',
        ]);
        expect(parsed.meta.requiredMcps).toEqual([
            {
                category: 'task-management',
                label: 'Task Management',
                examples: 'Jira: Cloud, Linear',
            },
        ]);
        expect(parsed.meta.version).toBe('2.0.0');
    });
});
