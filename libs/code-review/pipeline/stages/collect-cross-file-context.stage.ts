import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import {
    COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
    CollectCrossFileContextsService,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

@Injectable()
export class CollectCrossFileContextStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'CollectCrossFileContextStage';
    readonly label = 'Gathering Cross-File Context';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly logger = createLogger(
        CollectCrossFileContextStage.name,
    );

    constructor(
        @Inject(COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN)
        private readonly collectCrossFileContextsService: CollectCrossFileContextsService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        // Guard: skip if cross_file is disabled
        if (!context?.codeReviewConfig?.reviewOptions?.cross_file) {
            this.logger.log({
                message: `Skipping cross-file context collection: cross_file disabled for PR#${context?.pullRequest?.number}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }

        // Guard: skip if no changed files
        if (!context?.changedFiles?.length) {
            this.logger.log({
                message: `Skipping cross-file context collection: no changed files for PR#${context?.pullRequest?.number}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }

        // Guard: skip if no remoteCommands available
        if (!context?.remoteCommands) {
            this.logger.log({
                message: `Skipping cross-file context collection: remoteCommands not available for PR#${context?.pullRequest?.number}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }

        try {
            const result =
                await this.collectCrossFileContextsService.collectContexts({
                    remoteCommands: context.remoteCommands,
                    changedFiles: context.changedFiles,
                    byokConfig: context.codeReviewConfig?.byokConfig,
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    language:
                        context.codeReviewConfig?.languageResultPrompt ||
                        'en-US',
                    repoRoot: context.repository?.fullName || '.',
                });

            this.logger.log({
                message: `Cross-file context collected for PR#${context.pullRequest.number}: ${result.contexts.length} snippets from ${result.totalSearches} searches`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    contextsCount: result.contexts.length,
                    totalSearches: result.totalSearches,
                    totalSnippetsBeforeDedup: result.totalSnippetsBeforeDedup,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.crossFileContexts = result;
            });
        } catch (error) {
            // Non-fatal: log error and return context unchanged
            this.logger.error({
                message: `Failed to collect cross-file context for PR#${context?.pullRequest?.number}, continuing without it`,
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }
    }
}
