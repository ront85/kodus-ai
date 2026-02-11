import { LanguageValue } from '@libs/core/domain/enums/language-parameter.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';

type DayOfWeek = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

type BooleanMap<T extends string> = {
    [key in T]: boolean;
};

type CheckinFrequency = BooleanMap<DayOfWeek>;

type SessionFrequency = 'daily' | 'weekly';

export type SectionType =
    | 'releaseNotes'
    | 'pullRequestsOpened'
    | 'lateWorkItems'
    | 'teamArtifacts'
    | 'teamDoraMetrics'
    | 'teamFlowMetrics';

type Section = {
    id: SectionType;
    active: boolean;
    order: number;
    additionalConfig?: {
        frequency?: SessionFrequency;
    };
};

type SectionConfig = {
    [key in SectionType]?: Section;
};

export type CheckinConfigValue = {
    checkinId: string;
    checkinName: string;
    frequency: CheckinFrequency;
    sections: SectionConfig;
    checkinTime: string;
};

export type PlatformConfigValue = {
    finishOnboard: boolean;
    finishProjectManagementConnection: boolean;
    kodyLearningStatus: KodyLearningStatus;
};

export enum KodyLearningStatus {
    ENABLED = 'enabled',
    DISABLED = 'disabled',
    GENERATING_RULES = 'generating_rules',
    GENERATING_CONFIG = 'generating_config',
}

/**
 * Maps parameter keys to their value types.
 * 
 * @property CODE_REVIEW_CONFIG - Configuration for code review settings
 * @property LANGUAGE_CONFIG - Language for Kody's responses (e.g., "en-US", "pt-BR"). 
 *           Controls the human language used in comments, summaries, and UI text.
 * @property PLATFORM_CONFIGS - Platform-specific configurations
 */
export type ConfigValueMap = {
    [ParametersKey.CODE_REVIEW_CONFIG]: CodeReviewParameter;
    [ParametersKey.LANGUAGE_CONFIG]: LanguageValue;
    [ParametersKey.PLATFORM_CONFIGS]: PlatformConfigValue;
} & {
    [K in Exclude<
        ParametersKey,
        | ParametersKey.CODE_REVIEW_CONFIG
        | ParametersKey.LANGUAGE_CONFIG
        | ParametersKey.PLATFORM_CONFIGS
    >]?: any;
};
