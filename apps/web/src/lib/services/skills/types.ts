export type SkillInstructions = {
    instructions: string;
    source: 'db' | 'filesystem';
};

export type SkillVersion = {
    version: number;
    createdAt?: string;
    updatedAt?: string;
};
