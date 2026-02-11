export enum ParametersKey {
    CODE_REVIEW_CONFIG = 'code_review_config',
    PLATFORM_CONFIGS = 'platform_configs',
    
    /**
     * Language for Kody's responses (comments, summaries, UI text).
     * Controls the human language Kody uses to communicate, not programming languages.
     */
    LANGUAGE_CONFIG = 'language_config',
    
    ISSUE_CREATION_CONFIG = 'issue_creation_config',

    //DEPRECATED
    TEAM_ARTIFACTS_CONFIG = 'team_artifacts_config',
    ORGANIZATION_ARTIFACTS_CONFIG = 'organization_artifacts_config',
    COMMUNICATION_STYLE = 'communication_style',
    CHECKIN_CONFIG = 'checkin_config',
    BOARD_PRIORITY_TYPE = 'board_priority_type',
    DEPLOYMENT_TYPE = 'deployment_type',
}
