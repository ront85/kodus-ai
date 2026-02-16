export enum TaskStatus {
    /* Unspecified status, used for default initialization */
    TASK_STATUS_UNSPECIFIED = 0,
    /* Task is pending and waiting to be processed */
    TASK_STATUS_PENDING = 1,
    /* Task is currently in progress */
    TASK_STATUS_IN_PROGRESS = 2,
    /* Task has been completed successfully */
    TASK_STATUS_COMPLETED = 3,
    /* Task has failed, typically due to an error */
    TASK_STATUS_FAILED = 4,
    /* Task has been cancelled, either by user request or system intervention */
    TASK_STATUS_CANCELLED = 5,
}

/* TaskPriority represents the priority level of a task in the Kodus system. */
export enum TaskPriority {
    /* Unspecified priority, used for default initialization */
    TASK_PRIORITY_UNSPECIFIED = 0,
    /* Low priority task, typically for non-critical operations */
    TASK_PRIORITY_LOW = 1,
    /* Medium priority task, for tasks that are important but not urgent */
    TASK_PRIORITY_MEDIUM = 2,
    /* High priority task, for critical operations that need immediate attention */
    TASK_PRIORITY_HIGH = 3,
}

export enum ProtoAuthMode {
    OAUTH = 'OAUTH',
    TOKEN = 'TOKEN',
}

export enum ProtoPlatformType {
    GITHUB = 'GITHUB',
    GITLAB = 'GITLAB',
    BITBUCKET = 'BITBUCKET',
    AZURE_REPOS = 'AZURE_REPOS',
}

export interface RepositoryData {
    url: string;
    branch?: string;
    auth: {
        type: ProtoAuthMode;
        token?: string;
        username?: string;
        password?: string;
    };
    provider: ProtoPlatformType;
}

export interface InitializeRepositoryResponse {
    taskId: string;
    status: TaskStatus;
    message?: string;
}

export interface InitializeImpactAnalysisResponse {
    taskId: string;
    status: TaskStatus;
    message?: string;
}

export interface GetTaskInfoResponse {
    task: {
        taskId: string;
        status: TaskStatus;
        progress?: number;
        message?: string;
        error?: string;
        result?: any;
    };
}

export interface FunctionAffect {
    functionName: string;
    filePath: string;
    impact: string;
    affectedBy: string[];
}

export interface FunctionSimilarity {
    functionName: string;
    filePath: string;
    similarTo: Array<{
        functionName: string;
        filePath: string;
        similarity: number;
    }>;
}

export interface GetImpactAnalysisResponse {
    functionsAffect: FunctionAffect[];
    functionSimilarity: FunctionSimilarity[];
}

export enum FileContentFlag {
    DIFF = 'DIFF',
    FULL = 'FULL',
    SIMPLE = 'SIMPLE',
}

export interface InitializeContentFromDiffRequest {
    files: {
        id: string;
        content: string; // encrypted + gzipped
        filePath: string; // for language detection in AST
        diff: string; // encrypted + gzipped
    }[];
}

export interface GetContentFromDiffResponse {
    files: {
        id: string;
        content: string; // encrypted + gzipped
        flag: FileContentFlag;
    }[];
}
