export class SkillNotFoundError extends Error {
    constructor(skillName: string) {
        super(
            `Skill '${skillName}' not found: no DB override and no filesystem SKILL.md at libs/agents/skills/${skillName}/SKILL.md`,
        );
        this.name = 'SkillNotFoundError';
    }
}

export class SkillOverrideNotFoundError extends Error {
    constructor(skillName: string, version: number) {
        super(
            `Skill override v${version} not found for skill '${skillName}'`,
        );
        this.name = 'SkillOverrideNotFoundError';
    }
}

