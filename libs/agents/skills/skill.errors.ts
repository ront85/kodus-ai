export class SkillNotFoundError extends Error {
    constructor(skillName: string) {
        super(
            `Skill '${skillName}' not found: no SKILL.md at libs/agents/skills/${skillName}/SKILL.md`,
        );
        this.name = 'SkillNotFoundError';
    }
}

export class RequiredMcpPreflightError extends Error {
    constructor(
        skillName: string,
        requiredMcps: Array<{ category: string; label: string }>,
    ) {
        const required = requiredMcps
            .map((mcp) => `${mcp.label} (${mcp.category})`)
            .join(', ');

        super(
            `Skill '${skillName}' requires external MCP integrations before execution. Missing required categories: ${required}.`,
        );
        this.name = 'RequiredMcpPreflightError';
    }
}
