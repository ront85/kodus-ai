/**
 * Capability catalog for skill orchestration.
 *
 * Skills declare abstract capabilities while runtime resolves
 * them to concrete MCP tool names.
 */
export const SKILL_CAPABILITY_TOOL_MAP: Record<string, string[]> = {
    'pr.diff.read': ['KODUS_GET_PULL_REQUEST_DIFF'],
    'pr.metadata.read': ['KODUS_GET_PULL_REQUEST'],
    // External ticket providers vary by MCP integration.
    // Keeping it capability-only for deterministic resolvers.
    'task.context.read': [],
};

export function resolveCapabilityTools(capabilities?: string[]): {
    tools: string[];
    unknownCapabilities: string[];
} {
    if (!capabilities?.length) {
        return { tools: [], unknownCapabilities: [] };
    }

    const resolvedTools = new Set<string>();
    const unknownCapabilities: string[] = [];

    for (const capability of capabilities) {
        const tools = SKILL_CAPABILITY_TOOL_MAP[capability];
        if (!tools) {
            unknownCapabilities.push(capability);
            continue;
        }
        for (const tool of tools) {
            resolvedTools.add(tool);
        }
    }

    return {
        tools: [...resolvedTools],
        unknownCapabilities,
    };
}
