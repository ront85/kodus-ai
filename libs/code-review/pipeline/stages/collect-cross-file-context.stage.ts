import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import {
    COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
    CollectCrossFileContextsService,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { E2BSandboxService } from '@libs/code-review/infrastructure/adapters/services/e2bSandbox.service';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
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
        private readonly e2bSandboxService: E2BSandboxService,
        private readonly codeManagementService: CodeManagementService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
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

        // Guard: skip if E2B is not available
        if (!this.e2bSandboxService.isAvailable()) {
            this.logger.log({
                message: `Skipping cross-file context collection: E2B_API_KEY not configured for PR#${context?.pullRequest?.number}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }

        let cleanup: (() => Promise<void>) | undefined;

        try {
            // 1. Get clone params from the platform
            const cloneParams =
                await this.codeManagementService.getCloneParams(
                    {
                        repository: context.repository,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                    },
                    context.platformType,
                );

            // 2. Create E2B sandbox and clone repo
            const sandbox =
                await this.e2bSandboxService.createSandboxWithRepo({
                    cloneUrl: cloneParams.url,
                    authToken: cloneParams.auth?.token || '',
                    branch: context.branch,
                    prNumber: context.pullRequest.number,
                    platform: context.platformType,
                });

            cleanup = sandbox.cleanup;

            // 3. Collect cross-file contexts using sandbox remoteCommands
            const result =
                await this.collectCrossFileContextsService.collectContexts({
                    remoteCommands: sandbox.remoteCommands,
                    changedFiles: context.changedFiles,
                    byokConfig: context.codeReviewConfig?.byokConfig,
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    language:
                        context.codeReviewConfig?.languageResultPrompt ||
                        'en-US',
                    repoRoot: '.',
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
        } finally {
            if (cleanup) {
                await cleanup();
            }
        }
    }
}
