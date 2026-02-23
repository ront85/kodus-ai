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

export class CircularSkillDependencyError extends Error {
    constructor(cycle: string[]) {
        super(
            `Circular skill dependency detected: ${cycle.join(' → ')}. ` +
                `Fix the blueprint before starting the application.`,
        );
        this.name = 'CircularSkillDependencyError';
    }
}
