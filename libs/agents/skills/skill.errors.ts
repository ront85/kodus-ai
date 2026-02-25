export class SkillNotFoundError extends Error {
    constructor(skillName: string) {
        super(
            `Skill '${skillName}' not found: no SKILL.md at libs/agents/skills/${skillName}/SKILL.md`,
        );
        this.name = 'SkillNotFoundError';
    }
}
