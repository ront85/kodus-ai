import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import pLimit from 'p-limit';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';

import {
    ISuggestionService,
    SUGGESTION_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/SuggestionService.contract';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import {
    FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
    IFileReviewContextPreparation,
} from '@libs/core/domain/interfaces/file-review-context-preparation.interface';
import {
    IKodyFineTuningContextPreparationService,
    KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN,
} from '@libs/core/domain/interfaces/kody-fine-tuning-context-preparation.interface';
import {
    IKodyASTAnalyzeContextPreparationService,
    KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN,
} from '@libs/core/domain/interfaces/kody-ast-analyze-context-preparation.interface';
import { createLogger } from '@kodus/flow';
import {
    AIAnalysisResult,
    AnalysisContext,
    CodeReviewConfig,
    CodeReviewVersion,
    CodeSuggestion,
    FileChange,
    IFinalAnalysisResult,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { createOptimizedBatches } from '@libs/common/utils/batch.helper';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { TaskStatus } from '@libs/ee/kodyAST/interfaces/code-ast-analysis.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CrossFileContextSnippet } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { CodeAnalysisOrchestrator } from '@libs/ee/codeBase/codeAnalysisOrchestrator.service';
import {
    CodeReviewPipelineContext,
    FileContextAgentResult,
} from '../context/code-review-pipeline.context';

interface FileProcessingResult {
    filename: string;
    validSuggestionsToAnalyze: Partial<CodeSuggestion>[];
    discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[];
    error?: PipelineError;
    reviewMode?: any;
    codeReviewModelUsed?: any;
}

@Injectable()
export class ProcessFilesReview extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'FileAnalysisStage';
    readonly label = 'Reviewing File Level';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly MIN_BATCH_SIZE = 20;
    private readonly MAX_BATCH_SIZE = 30;
    private readonly concurrencyLimit = 30;
    private readonly logger = createLogger(ProcessFilesReview.name);

    constructor(
        @Inject(SUGGESTION_SERVICE_TOKEN)
        private readonly suggestionService: ISuggestionService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,

        @Inject(FILE_REVIEW_CONTEXT_PREPARATION_TOKEN)
        private readonly fileReviewContextPreparation: IFileReviewContextPreparation,

        @Inject(KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN)
        private readonly kodyFineTuningContextPreparation: IKodyFineTuningContextPreparationService,

        @Inject(KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN)
        private readonly kodyAstAnalyzeContextPreparation: IKodyASTAnalyzeContextPreparationService,

        private readonly codeAnalysisOrchestrator: CodeAnalysisOrchestrator,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (!context.changedFiles || context.changedFiles.length === 0) {
            this.logger.warn({
                message: `No files to analyze for PR#${context.pullRequest.number}`,
                context: this.stageName,
            });
            return context;
        }

        try {
            const {
                validSuggestions,
                discardedSuggestions,
                fileMetadata,
                tasks,
                errors,
            } = await this.analyzeChangedFilesInBatches(context);

            return this.updateContext(context, (draft) => {
                draft.validSuggestions = validSuggestions;
                draft.discardedSuggestions = discardedSuggestions;
                draft.fileMetadata = fileMetadata;
                draft.tasks = tasks;
                if (errors?.length > 0) {
                    draft.errors.push(...errors);
                }

                // Release heavy data no longer needed by subsequent stages
                for (const file of draft.changedFiles) {
                    delete file.patchWithLinesStr;
                }
            });
        } catch (error) {
            this.logger.error({
                message: 'Error analyzing files in batches',
                error,
                context: this.stageName,
                metadata: {
                    pullRequestNumber: context.pullRequest.number,
                    repositoryName: context.repository.name,
                    changedFilesCount: context.changedFiles?.length || 0,
                },
            });

            // Mesmo em caso de erro, retornamos o contexto para que o pipeline continue
            return this.updateContext(context, (draft) => {
                draft.validSuggestions = [];
                draft.discardedSuggestions = [];
                draft.fileMetadata = new Map();
            });
        }
    }

    async analyzeChangedFilesInBatches(
        context: CodeReviewPipelineContext,
    ): Promise<{
        validSuggestions: Partial<CodeSuggestion>[];
        discardedSuggestions: Partial<CodeSuggestion>[];
        fileMetadata: Map<string, any>;
        validCrossFileSuggestions: CodeSuggestion[];
        tasks: AnalysisContext['tasks'];
        errors: PipelineError[];
    }> {
        const { organizationAndTeamData, pullRequest, changedFiles } = context;
        const analysisContext =
            this.createAnalysisContextFromPipelineContext(context);

        try {
            this.logger.log({
                message: `Starting batch analysis of ${changedFiles.length} files`,
                context: ProcessFilesReview.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    pullRequestNumber: pullRequest.number,
                },
            });

            const batches = this.createBatches(changedFiles);

            // Create collections upfront — results are collected inline per batch
            const validSuggestions: Partial<CodeSuggestion>[] = [];
            const discardedSuggestions: Partial<CodeSuggestion>[] = [];
            const fileMetadata = new Map<string, any>();
            const errors: PipelineError[] = [];

            const tasks: AnalysisContext['tasks'] = {
                astAnalysis: {
                    ...analysisContext.tasks.astAnalysis,
                },
            };

            await this.processBatchesSequentially(
                batches,
                analysisContext,
                tasks,
                validSuggestions,
                discardedSuggestions,
                fileMetadata,
                errors,
            );

            this.logger.log({
                message: `Finished all batches - Analysis complete for PR#${pullRequest.number}`,
                context: ProcessFilesReview.name,
                metadata: {
                    validSuggestionsCount: validSuggestions.length,
                    discardedCount: discardedSuggestions.length,
                    tasks: tasks,
                    organizationAndTeamData: organizationAndTeamData,
                },
            });

            return {
                validSuggestions,
                discardedSuggestions,
                fileMetadata,
                validCrossFileSuggestions:
                    analysisContext.validCrossFileSuggestions || [],
                tasks,
                errors,
            };
        } catch (error) {
            this.logProcessingError(
                error,
                organizationAndTeamData,
                pullRequest,
            );
            return {
                validSuggestions: [],
                discardedSuggestions: [],
                fileMetadata: new Map(),
                validCrossFileSuggestions: [],
                tasks: { ...context.tasks },
                errors: [],
            };
        }
    }

    /**
     * Logs processing errors
     * @param error The error that occurred
     * @param organizationAndTeamData Organization and team data
     * @param pullRequest Pull request data
     */
    private logProcessingError(
        error: any,
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: { number: number },
    ): void {
        this.logger.error({
            message: `Error in batch file processing`,
            error,
            context: ProcessFilesReview.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                pullRequestNumber: pullRequest.number,
            },
        });
    }

    private createBatches(files: FileChange[]): FileChange[][] {
        return createOptimizedBatches(files, {
            minBatchSize: this.MIN_BATCH_SIZE,
            maxBatchSize: this.MAX_BATCH_SIZE,
        });
    }

    private async processBatchesSequentially(
        batches: FileChange[][],
        context: AnalysisContext,
        tasks: AnalysisContext['tasks'],
        validSuggestions: Partial<CodeSuggestion>[],
        discardedSuggestions: Partial<CodeSuggestion>[],
        fileMetadata: Map<string, any>,
        errors: PipelineError[],
    ): Promise<void> {
        for (const [index, batch] of batches.entries()) {
            this.logger.log({
                message: `Processing batch ${index + 1}/${batches.length} with ${batch.length} files`,
                context: ProcessFilesReview.name,
            });

            try {
                const batchResults = await this.processSingleBatch(
                    batch,
                    context,
                    index,
                    tasks,
                );

                // Collect immediately — no accumulation of intermediate array
                for (const result of batchResults) {
                    if (result.error) {
                        errors.push(result.error);
                    }
                    this.collectFileProcessingResult(
                        result,
                        validSuggestions,
                        discardedSuggestions,
                        fileMetadata,
                    );
                }
                // batchResults goes out of scope here → GC can reclaim
            } catch (error) {
                this.logger.error({
                    message: `Error processing batch ${index + 1}`,
                    error,
                    context: ProcessFilesReview.name,
                    metadata: {
                        batchIndex: index,
                        batchSize: batch.length,
                        pullRequestNumber: context.pullRequest.number,
                    },
                });
            }
        }
    }

    private async processSingleBatch(
        batch: FileChange[],
        context: AnalysisContext,
        batchIndex: number,
        tasks: AnalysisContext['tasks'],
    ): Promise<FileProcessingResult[]> {
        const { organizationAndTeamData, pullRequest } = context;

        const preparedFiles = await this.filterAndPrepareFiles(batch, context);

        const astFailed = preparedFiles.find((file) => {
            const task = file.fileContext.tasks?.astAnalysis;
            return task && task.status !== TaskStatus.TASK_STATUS_COMPLETED;
        });

        if (astFailed) {
            tasks.astAnalysis.status =
                astFailed?.fileContext?.tasks?.astAnalysis?.status ||
                TaskStatus.TASK_STATUS_FAILED;
        }

        const results = await Promise.allSettled(
            preparedFiles.map(({ fileContext }) =>
                this.executeFileAnalysis(fileContext),
            ),
        );

        const batchResults: FileProcessingResult[] = [];

        results.forEach((result) => {
            if (result.status === 'fulfilled') {
                batchResults.push(result.value);
            } else {
                this.logger.error({
                    message: `Error processing file in batch ${batchIndex + 1}`,
                    error: result.reason,
                    context: ProcessFilesReview.name,
                    metadata: {
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                        pullRequestNumber: pullRequest.number,
                        batchIndex,
                    },
                });
            }
        });

        return batchResults;
    }

    /**
     * Collects and organizes the results of file processing
     * @param fileProcessingResult Result of the file processing
     * @param validSuggestionsToAnalyze Array to store the valid suggestions found
     * @param discardedSuggestionsBySafeGuard Array to store the discarded suggestions
     * @param fileMetadata Map to store file metadata
     */
    private collectFileProcessingResult(
        fileProcessingResult: FileProcessingResult,
        validSuggestionsToAnalyze: Partial<CodeSuggestion>[],
        discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[],
        fileMetadata: Map<string, any>,
    ): void {
        if (fileProcessingResult?.validSuggestionsToAnalyze?.length > 0) {
            validSuggestionsToAnalyze.push(
                ...fileProcessingResult.validSuggestionsToAnalyze,
            );
        }

        if (fileProcessingResult?.discardedSuggestionsBySafeGuard?.length > 0) {
            discardedSuggestionsBySafeGuard.push(
                ...fileProcessingResult.discardedSuggestionsBySafeGuard,
            );
        }

        if (fileProcessingResult?.filename) {
            fileMetadata.set(fileProcessingResult.filename, {
                reviewMode: fileProcessingResult.reviewMode,
                codeReviewModelUsed: fileProcessingResult.codeReviewModelUsed,
            });
        }
    }

    private filterSnippetsForFile(
        allSnippets: CrossFileContextSnippet[] | undefined,
        file: FileChange,
    ): CrossFileContextSnippet[] {
        if (!allSnippets?.length) {
            return [];
        }

        const diff = file.patchWithLinesStr || file.patch || '';
        if (!diff) {
            return [];
        }

        // Extract identifiers defined/exported in this file's diff (+lines).
        // Used for reverse matching: does the snippet consume something this file changes?
        const diffIdentifiers = this.extractDiffIdentifiers(diff);

        return allSnippets.filter((snippet) => {
            // Hop-1 snippets always pass — the planner already validated
            // their relevance and filtering them out loses critical
            // cross-file evidence (e.g. a consumer using a string literal
            // that was renamed in the diff — the very mismatch that makes
            // it a bug also prevents text-based matching).
            if (snippet.hop === 1) {
                return true;
            }

            // Snippets without relatedSymbol pass through — the planner
            // already deemed them relevant; let the LLM judge per-file.
            if (!snippet.relatedSymbol) {
                return true;
            }

            // Forward match: snippet's relatedSymbol appears in this file's diff
            if (diff.includes(snippet.relatedSymbol)) {
                return true;
            }

            // Split compound symbols (e.g. "PlanType.PREMIUM") and match parts.
            // Skip short tokens (<3 chars) to avoid false positives.
            const parts = snippet.relatedSymbol
                .split('.')
                .filter((p) => p.length >= 3);

            if (parts.some((part) => diff.includes(part))) {
                return true;
            }

            // Reverse match: this file defines/changes symbols that appear in the snippet's content.
            // Catches cases like: notificationEvents.ts changes NOTIFICATION_EVENTS,
            // and PaymentService snippet references NOTIFICATION_EVENTS.
            if (
                diffIdentifiers.length > 0 &&
                diffIdentifiers.some((id) => snippet.content.includes(id))
            ) {
                return true;
            }

            return false;
        });
    }

    /**
     * Extract identifiers defined or exported in the diff's added lines.
     * Returns unique names of consts, functions, classes, types, enums, interfaces,
     * and string-keyed object properties.
     */
    private extractDiffIdentifiers(diff: string): string[] {
        const identifiers = new Set<string>();
        const lines = diff.split('\n');

        for (const line of lines) {
            // Only look at added lines
            if (!line.startsWith('+')) continue;

            // Match: export const FOO, function bar, class Baz, type X, enum Y, interface Z
            const declarationPattern =
                /(?:export\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g;
            let match: RegExpExecArray | null;
            while ((match = declarationPattern.exec(line)) !== null) {
                if (match[1] && match[1].length >= 3) {
                    identifiers.add(match[1]);
                }
            }

            // Match string-keyed object properties: "payment.captured": ...
            const stringKeyPattern = /["']([^"']+)["']\s*:/g;
            while ((match = stringKeyPattern.exec(line)) !== null) {
                if (match[1] && match[1].length >= 3) {
                    identifiers.add(match[1]);
                }
            }
        }

        return Array.from(identifiers);
    }

    private async filterAndPrepareFiles(
        batch: FileChange[],
        context: AnalysisContext,
    ): Promise<Array<{ fileContext: AnalysisContext }>> {
        const limit = pLimit(this.concurrencyLimit);

        const settledResults = await Promise.allSettled(
            batch.map((file) =>
                limit(() => {
                    const filteredSnippets = this.filterSnippetsForFile(
                        context.crossFileSnippets,
                        file,
                    );

                    if (context.crossFileSnippets?.length) {
                        this.logger.log({
                            message: `Cross-file snippets for ${file.filename}: ${filteredSnippets.length}/${context.crossFileSnippets.length} passed filter`,
                            context: ProcessFilesReview.name,
                            metadata: {
                                filename: file.filename,
                                totalSnippets: context.crossFileSnippets.length,
                                filteredSnippets: filteredSnippets.length,
                                matchedSymbols: filteredSnippets
                                    .filter((s) => s.relatedSymbol)
                                    .map((s) => s.relatedSymbol),
                            },
                        });
                    }

                    const perFileContext: AnalysisContext = {
                        ...context,
                        fileAugmentations:
                            context.augmentationsByFile?.[file.filename] ?? {},
                        crossFileSnippets: filteredSnippets,
                    };

                    return this.fileReviewContextPreparation.prepareFileContext(
                        file,
                        perFileContext,
                    );
                }),
            ),
        );

        settledResults?.forEach((res, index) => {
            if (res.status === 'rejected') {
                this.logger.error({
                    message: `Error preparing the file "${batch[index]?.filename}" for analysis`,
                    error: res.reason,
                    context: ProcessFilesReview.name,
                    metadata: {
                        ...context.organizationAndTeamData,
                        pullRequestNumber: context.pullRequest.number,
                    },
                });
            }
        });

        return settledResults
            ?.filter(
                (
                    res,
                ): res is PromiseFulfilledResult<{
                    fileContext: AnalysisContext;
                }> => res.status === 'fulfilled' && res.value !== null,
            )
            ?.map((res) => res.value);
    }

    private async executeFileAnalysis(
        baseContext: AnalysisContext,
    ): Promise<FileProcessingResult> {
        const { reviewModeResponse } = baseContext;
        const { file, relevantContent, patchWithLinesStr, hasRelevantContent } =
            baseContext.fileChangeContext;

        try {
            const context: AnalysisContext = {
                ...baseContext,
                reviewModeResponse: reviewModeResponse,
                fileChangeContext: {
                    file,
                    relevantContent,
                    patchWithLinesStr,
                    hasRelevantContent,
                },
            };

            const standardAnalysisResult =
                await this.codeAnalysisOrchestrator.executeStandardAnalysis(
                    context.organizationAndTeamData,
                    context.pullRequest.number,
                    {
                        file,
                        relevantContent,
                        patchWithLinesStr,
                        hasRelevantContent,
                    },
                    reviewModeResponse,
                    context,
                );

            const finalResult = await this.processAnalysisResult(
                standardAnalysisResult,
                context,
            );

            return { ...finalResult, filename: file.filename };
        } catch (error) {
            this.logger.error({
                message: `Error analyzing file ${file.filename}`,
                error,
                context: ProcessFilesReview.name,
                metadata: {
                    filename: file.filename,
                    organizationId:
                        baseContext.organizationAndTeamData.organizationId,
                    teamId: baseContext.organizationAndTeamData.teamId,
                    pullRequestNumber: baseContext.pullRequest.number,
                },
            });

            return {
                validSuggestionsToAnalyze: [],
                discardedSuggestionsBySafeGuard: [],
                filename: file.filename,
                error: {
                    stage: this.stageName,
                    substage: file.filename,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    metadata: {
                        filename: file.filename,
                    },
                },
            };
        }
    }

    private async processAnalysisResult(
        result: AIAnalysisResult,
        context: AnalysisContext,
    ): Promise<IFinalAnalysisResult> {
        const { reviewModeResponse } = context;
        const { file, relevantContent, patchWithLinesStr } =
            context.fileChangeContext;

        const validSuggestionsToAnalyze: Partial<CodeSuggestion>[] = [];
        const discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[] = [];
        let safeguardLLMProvider = '';

        const crossFileAnalysisSuggestions =
            context?.validCrossFileSuggestions || [];

        const validCrossFileSuggestions = crossFileAnalysisSuggestions?.filter(
            (suggestion) => suggestion.relevantFile === file.filename,
        );

        const initialFilterResult = await this.initialFilterSuggestions(
            result,
            context,
            validCrossFileSuggestions,
            patchWithLinesStr,
        );

        const kodyFineTuningResult = await this.applyKodyFineTuningFilter(
            initialFilterResult.filteredSuggestions,
            context,
        );

        const discardedSuggestionsByCodeDiff =
            initialFilterResult.discardedSuggestionsByCodeDiff;
        const discardedSuggestionsByKodyFineTuning =
            kodyFineTuningResult.discardedSuggestionsByKodyFineTuning;
        const keepedSuggestions = kodyFineTuningResult.keepedSuggestions;

        // Separar sugestões cross-file das demais
        const crossFileIds = new Set(
            validCrossFileSuggestions?.map((suggestion) => suggestion.id),
        );

        // Standard review suggestions that the LLM flagged as based on
        // cross-file evidence should also bypass safeguard — the safeguard
        // LLM doesn't receive cross-file snippets and would discard them
        // as "speculative".
        for (const suggestion of keepedSuggestions) {
            if (
                !crossFileIds.has(suggestion.id) &&
                suggestion.crossFileEvidence === true
            ) {
                crossFileIds.add(suggestion.id);
            }
        }

        const filteredCrossFileSuggestions = keepedSuggestions.filter(
            (suggestion) => crossFileIds?.has(suggestion.id),
        );

        const filteredKeepedSuggestions = keepedSuggestions.filter(
            (suggestion) => !crossFileIds?.has(suggestion.id),
        );

        // Aplicar safeguard apenas nas sugestões não cross-file
        const safeGuardResult = await this.applySafeguardFilter(
            filteredKeepedSuggestions,
            context,
            file,
            relevantContent,
            patchWithLinesStr,
            reviewModeResponse,
        );

        safeguardLLMProvider = safeGuardResult.safeguardLLMProvider;

        discardedSuggestionsBySafeGuard.push(
            ...safeGuardResult.allDiscardedSuggestions,
            ...discardedSuggestionsByCodeDiff,
            ...discardedSuggestionsByKodyFineTuning,
        );

        const suggestionsWithSeverity =
            await this.suggestionService.analyzeSuggestionsSeverity(
                context?.organizationAndTeamData,
                context?.pullRequest?.number,
                safeGuardResult.safeguardSuggestions,
                context?.codeReviewConfig?.reviewOptions,
                context?.codeReviewConfig?.codeReviewVersion,
                context?.codeReviewConfig?.byokConfig,
            );

        const crossFileSuggestionsWithSeverity =
            await this.suggestionService.analyzeSuggestionsSeverity(
                context?.organizationAndTeamData,
                context?.pullRequest?.number,
                filteredCrossFileSuggestions,
                context?.codeReviewConfig?.reviewOptions,
                context?.codeReviewConfig?.codeReviewVersion,
                context?.codeReviewConfig?.byokConfig,
            );

        // Apply severity level filter to cross-file suggestions
        // This is needed because cross-file suggestions skip applySafeguardFilter,
        // which contains the severity pre-filter for v2 (and is the only severity
        // level gate when limitationType is SEVERITY, since it overrides
        // severityLevelFilter to LOW in the downstream prioritizeSuggestionsLegacy)
        let filteredCrossFileFinal = crossFileSuggestionsWithSeverity;

        const severityLevelFilter =
            context?.codeReviewConfig?.suggestionControl?.severityLevelFilter;

        if (
            severityLevelFilter &&
            crossFileSuggestionsWithSeverity?.length > 0
        ) {
            const prioritizedCrossFile =
                await this.suggestionService.filterSuggestionsBySeverityLevel(
                    crossFileSuggestionsWithSeverity,
                    severityLevelFilter,
                    context?.organizationAndTeamData,
                    context?.pullRequest?.number,
                );

            const discardedCrossFileBySeverity = prioritizedCrossFile.filter(
                (suggestion) =>
                    suggestion.priorityStatus ===
                    PriorityStatus.DISCARDED_BY_SEVERITY,
            );

            if (discardedCrossFileBySeverity.length > 0) {
                discardedSuggestionsBySafeGuard.push(
                    ...discardedCrossFileBySeverity,
                );
            }

            filteredCrossFileFinal = prioritizedCrossFile.filter(
                (suggestion) =>
                    suggestion.priorityStatus === PriorityStatus.PRIORITIZED,
            );
        }

        let mergedSuggestions = [];

        const kodyRulesSuggestions =
            await this.codeAnalysisOrchestrator.executeKodyRulesAnalysis(
                context?.organizationAndTeamData,
                context?.pullRequest?.number,
                { file, patchWithLinesStr },
                context,
                {
                    codeSuggestions: suggestionsWithSeverity,
                },
            );

        if (kodyRulesSuggestions?.codeSuggestions?.length > 0) {
            mergedSuggestions.push(...kodyRulesSuggestions.codeSuggestions);
        }

        // Se tem sugestões com severidade, adiciona também
        if (
            !kodyRulesSuggestions?.codeSuggestions?.length &&
            suggestionsWithSeverity?.length > 0
        ) {
            mergedSuggestions.push(...suggestionsWithSeverity);
        }

        const kodyASTSuggestions =
            await this.kodyAstAnalyzeContextPreparation.prepareKodyASTAnalyzeContext(
                context,
            );

        // Garantir que as sugestões do AST tenham IDs
        const kodyASTSuggestionsWithId = await this.addSuggestionsId(
            kodyASTSuggestions?.codeSuggestions || [],
        );

        mergedSuggestions = [
            ...mergedSuggestions,
            ...kodyASTSuggestionsWithId,
            ...filteredCrossFileFinal,
        ];

        const VALID_ACTIONS = [
            'synchronize',
            'update',
            'updated',
            'git.pullrequest.updated',
        ];

        // If it's a commit, validate repeated suggestions
        // We keep it here to ensure immediate feedback within the review session context, but avoid race conditions
        // by checking if the async job will likely cover it (though redundancy is generally safe as operations are idempotent).
        if (context?.action && VALID_ACTIONS.includes(context.action)) {
            const savedSuggestions =
                await this.pullRequestService.findSuggestionsByPRAndFilename(
                    context?.pullRequest?.number,
                    context?.pullRequest?.base?.repo?.fullName,
                    file.filename,
                    context.organizationAndTeamData,
                );

            if (savedSuggestions?.length > 0 && mergedSuggestions?.length > 0) {
                mergedSuggestions =
                    await this.suggestionService.removeSuggestionsRelatedToSavedFiles(
                        context?.organizationAndTeamData,
                        context?.pullRequest?.number.toString(),
                        savedSuggestions,
                        mergedSuggestions,
                    );
            }
        }

        if (mergedSuggestions?.length > 0) {
            await Promise.all(
                mergedSuggestions.map(async (suggestion) => {
                    suggestion.rankScore =
                        await this.suggestionService.calculateSuggestionRankScore(
                            suggestion,
                        );
                }),
            );
        }

        validSuggestionsToAnalyze.push(...mergedSuggestions);

        return {
            validSuggestionsToAnalyze,
            discardedSuggestionsBySafeGuard:
                discardedSuggestionsBySafeGuard || [],
            reviewMode: reviewModeResponse,
            codeReviewModelUsed: {
                generateSuggestions:
                    result?.codeReviewModelUsed?.generateSuggestions,
                safeguard: safeguardLLMProvider,
            },
        };
    }

    private async addSuggestionsId(suggestions: any[]): Promise<any[]> {
        return suggestions?.map((suggestion) => ({
            ...suggestion,
            id: suggestion?.id || uuidv4(),
        }));
    }

    private async initialFilterSuggestions(
        result: AIAnalysisResult,
        context: AnalysisContext,
        crossFileAnalysis: CodeSuggestion[],
        patchWithLinesStr: string,
    ): Promise<{
        filteredSuggestions: Partial<CodeSuggestion>[];
        discardedSuggestionsByCodeDiff: Partial<CodeSuggestion>[];
    }> {
        // Combinar sugestões regulares com cross-file suggestions
        const allSuggestions = [
            ...(result.codeSuggestions || []),
            ...crossFileAnalysis,
        ];

        // Adicionar IDs apenas uma vez, aqui
        const suggestionsWithId = await this.addSuggestionsId(allSuggestions);

        const combinedResult = {
            ...result,
            codeSuggestions: suggestionsWithId,
        };

        const filteredSuggestionsByOptions =
            this.suggestionService.filterCodeSuggestionsByReviewOptions(
                context?.codeReviewConfig?.reviewOptions,
                combinedResult,
            );

        const filterSuggestionsCodeDiff =
            await this.suggestionService.filterSuggestionsCodeDiff(
                patchWithLinesStr,
                filteredSuggestionsByOptions.codeSuggestions,
            );

        const discardedSuggestionsByCodeDiff =
            this.suggestionService.getDiscardedSuggestions(
                filteredSuggestionsByOptions.codeSuggestions,
                filterSuggestionsCodeDiff,
                PriorityStatus.DISCARDED_BY_CODE_DIFF,
            );

        return {
            filteredSuggestions: filterSuggestionsCodeDiff,
            discardedSuggestionsByCodeDiff,
        };
    }

    private async applyKodyFineTuningFilter(
        filteredSuggestions: any[],
        context: AnalysisContext,
    ): Promise<{
        keepedSuggestions: Partial<CodeSuggestion>[];
        discardedSuggestionsByKodyFineTuning: Partial<CodeSuggestion>[];
    }> {
        const getDataPipelineKodyFineTunning =
            await this.kodyFineTuningContextPreparation.prepareKodyFineTuningContext(
                context?.organizationAndTeamData.organizationId,
                context?.pullRequest?.number,
                {
                    id: context?.pullRequest?.repository?.id || '',
                    full_name: context?.pullRequest?.repository?.fullName || '',
                },
                filteredSuggestions,
                context?.codeReviewConfig?.kodyFineTuningConfig?.enabled,
                context?.clusterizedSuggestions,
            );

        const keepedSuggestions: Partial<CodeSuggestion>[] =
            getDataPipelineKodyFineTunning?.keepedSuggestions;

        const discardedSuggestions: Partial<CodeSuggestion>[] =
            getDataPipelineKodyFineTunning?.discardedSuggestions;

        const discardedSuggestionsByKodyFineTuning = discardedSuggestions.map(
            (suggestion) => {
                suggestion.priorityStatus =
                    PriorityStatus.DISCARDED_BY_KODY_FINE_TUNING;
                return suggestion;
            },
        );

        return {
            keepedSuggestions,
            discardedSuggestionsByKodyFineTuning,
        };
    }

    private async applySafeguardFilter(
        suggestions: Partial<CodeSuggestion>[],
        context: AnalysisContext,
        file: any,
        relevantContent,
        patchWithLinesStr: string,
        reviewModeResponse: any,
    ): Promise<{
        safeguardSuggestions: Partial<CodeSuggestion>[];
        allDiscardedSuggestions: Partial<CodeSuggestion>[];
        safeguardLLMProvider: string;
    }> {
        let filteredSuggestions = suggestions;
        let discardedSuggestionsBySeverity = [];

        if (
            context?.codeReviewConfig?.codeReviewVersion ===
            CodeReviewVersion.v2
        ) {
            const prioritizedSuggestions =
                await this.prioritizeSuggestionsBySeverityBeforeSafeGuard(
                    suggestions,
                    context,
                );

            filteredSuggestions = prioritizedSuggestions.filter(
                (suggestion) =>
                    suggestion.priorityStatus === PriorityStatus.PRIORITIZED,
            );

            discardedSuggestionsBySeverity = prioritizedSuggestions.filter(
                (suggestion) =>
                    suggestion.priorityStatus ===
                    PriorityStatus.DISCARDED_BY_SEVERITY,
            );
        }

        const safeGuardResponse =
            await this.suggestionService.filterSuggestionsSafeGuard(
                context?.organizationAndTeamData,
                context?.pullRequest?.number,
                file,
                relevantContent,
                patchWithLinesStr,
                filteredSuggestions,
                context?.codeReviewConfig?.languageResultPrompt,
                reviewModeResponse,
                context?.codeReviewConfig?.byokConfig,
            );

        const safeguardLLMProvider =
            safeGuardResponse?.codeReviewModelUsed?.safeguard || '';

        const discardedSuggestionsBySafeGuard =
            this.suggestionService.getDiscardedSuggestions(
                filteredSuggestions,
                safeGuardResponse?.suggestions || [],
                PriorityStatus.DISCARDED_BY_SAFEGUARD,
            );

        const allDiscardedSuggestions = [
            ...discardedSuggestionsBySeverity,
            ...discardedSuggestionsBySafeGuard,
        ];

        return {
            safeguardSuggestions: safeGuardResponse?.suggestions || [],
            allDiscardedSuggestions,
            safeguardLLMProvider,
        };
    }

    private async prioritizeSuggestionsBySeverityBeforeSafeGuard(
        suggestions: Partial<CodeSuggestion>[],
        context: AnalysisContext,
    ): Promise<Partial<CodeSuggestion>[]> {
        const prioritizedSuggestions =
            await this.suggestionService.filterSuggestionsBySeverityLevel(
                suggestions,
                context?.codeReviewConfig?.suggestionControl
                    ?.severityLevelFilter,
                context?.organizationAndTeamData,
                context?.pullRequest?.number,
            );

        return prioritizedSuggestions;
    }

    private createAnalysisContextFromPipelineContext(
        context: CodeReviewPipelineContext,
    ): AnalysisContext {
        return {
            organizationAndTeamData: context.organizationAndTeamData,
            repository: context.repository,
            pullRequest: context.pullRequest,
            action: context.action,
            platformType: context.platformType,
            codeReviewConfig: context.codeReviewConfig,
            clusterizedSuggestions: context.clusterizedSuggestions,
            validCrossFileSuggestions:
                context.prAnalysisResults?.validCrossFileSuggestions || [],
            tasks: context.tasks,
            externalPromptContext: context.externalPromptContext,
            externalPromptLayers: context.externalPromptLayers,
            correlationId: context.correlationId,
            sharedContextPack: context.sharedContextPack,
            augmentationsByFile: context.augmentationsByFile,
            filePromptOverrides: this.buildFilePromptOverrides(
                context.fileContextMap,
            ),
            crossFileSnippets: context.crossFileContexts?.contexts,
        };
    }

    private buildFilePromptOverrides(
        fileContextMap?: Record<string, FileContextAgentResult>,
    ): Record<string, CodeReviewConfig['v2PromptOverrides']> | undefined {
        if (!fileContextMap) {
            return undefined;
        }

        const map: Record<string, CodeReviewConfig['v2PromptOverrides']> = {};
        for (const [fileName, entry] of Object.entries(fileContextMap)) {
            if (entry?.resolvedPromptOverrides) {
                map[fileName] = entry.resolvedPromptOverrides;
            }
        }

        return Object.keys(map).length ? map : undefined;
    }
}
