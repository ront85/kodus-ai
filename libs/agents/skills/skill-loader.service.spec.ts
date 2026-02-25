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
});
