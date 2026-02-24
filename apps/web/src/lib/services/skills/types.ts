export type SkillRequiredMcp = {
    /** e.g. "task-management" */
    category: string;
    /** e.g. "Task Management" */
    label: string;
    /** e.g. "Jira, Linear, Notion" */
    examples?: string;
};

export type SkillMeta = {
    allowedTools?: string[];
    requiredMcps?: SkillRequiredMcp[];
};

export type SkillInstructions = {
    instructions: string;
    source: 'db' | 'filesystem';
};

export type SkillVersion = {
    version: number;
    createdAt?: string;
    updatedAt?: string;
};
