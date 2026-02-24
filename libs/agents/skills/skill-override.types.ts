export const SKILL_EDITABLE_SCHEMA_VERSION = 1 as const;

export type SkillEditableContent = {
    schemaVersion: typeof SKILL_EDITABLE_SCHEMA_VERSION;
    editable: {
        businessContext: string;
        orgRules: string[];
        qualityThresholds: {
            empty: string;
            minimal: string;
            partial: string;
            complete: string;
        };
        reportStyle: {
            tone: string;
            language: string;
        };
        examples: string[];
    };
};

export type SkillInstructionsBundle = {
    instructions: string;
    source: 'db' | 'filesystem';
    editable: SkillEditableContent;
    defaultEditable: SkillEditableContent;
    editableSource: 'db' | 'default';
};
