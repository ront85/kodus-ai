import { createLogger } from '@kodus/flow';
import { BusinessRulesValidationAgentUseCase } from '@libs/agents/application/use-cases/business-rules-validation-agent.use-case';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

@Injectable()
export class BusinessLogicValidationStage extends BasePipelineStage<CodeReviewPipelineContext> {
    private readonly logger = createLogger(BusinessLogicValidationStage.name);
    readonly stageName = 'BusinessLogicValidationStage';
    readonly label = 'Validating Business Logic';
    readonly visibility = StageVisibility.SECONDARY;

    private static readonly REQUIREMENT_KEYWORDS = [
        'requirement',
        'acceptance criteria',
        'user story',
        'given',
        'when',
        'then',
    ];

    private static readonly BUSINESS_LOGIC_TIMEOUT_MS = 300_000;

    constructor(
        private readonly businessRulesValidationAgentUseCase: BusinessRulesValidationAgentUseCase,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const startTime = Date.now();

        if (!this.shouldRun(context)) {
            this.logger.log({
                message: `Skipping BusinessLogicValidation for PR#${context.pullRequest?.number}`,
                context: this.stageName,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    prNumber: context.pullRequest?.number,
                    status: 'skipped',
                },
            });
            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [];
            });
        }

        const prBody = context.pullRequest.body ?? '';
        const signals = this.detectSignals(prBody);

        this.logger.log({
            message: `Starting BusinessLogicValidation for PR#${context.pullRequest.number}`,
            context: this.stageName,
            metadata: {
                organizationId: context.organizationAndTeamData?.organizationId,
                prNumber: context.pullRequest.number,
                signals,
                status: 'triggered',
            },
        });

        try {
            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error('BusinessLogicValidation timeout')),
                    BusinessLogicValidationStage.BUSINESS_LOGIC_TIMEOUT_MS,
                ),
            );

            const agentPromise =
                this.businessRulesValidationAgentUseCase.execute({
                    organizationAndTeamData: context.organizationAndTeamData,
                    prepareContext: {
                        pullRequestNumber: context.pullRequest.number,
                        repository: context.repository,
                        pullRequestDescription: prBody,
                        platformType: context.platformType,
                    },
                });

            const result = await Promise.race([agentPromise, timeoutPromise]);
            const runtime = Date.now() - startTime;

            const hasGap = this.resultHasGap(result);

            this.logger.log({
                message: `BusinessLogicValidation completed for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    prNumber: context.pullRequest.number,
                    runtimeMs: runtime,
                    status: hasGap ? 'gap_found' : 'no_gap',
                },
            });

            if (!hasGap) {
                return this.updateContext(context, (draft) => {
                    draft.businessLogicResults = [];
                });
            }

            const suggestion: ISuggestionByPR = {
                id: uuidv4(),
                suggestionContent: result,
                oneSentenceSummary:
                    'Business logic gap detected based on PR requirements.',
                label: LabelType.BUSINESS_LOGIC,
                severity: SeverityLevel.MEDIUM,
                deliveryStatus: DeliveryStatus.NOT_SENT,
            };

            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [suggestion];
            });
        } catch (error) {
            const runtime = Date.now() - startTime;
            const isTimeout =
                error instanceof Error &&
                error.message === 'BusinessLogicValidation timeout';

            this.logger.error({
                message: `BusinessLogicValidation ${isTimeout ? 'timed out' : 'failed'} for PR#${context.pullRequest.number}`,
                context: this.stageName,
                error,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    prNumber: context.pullRequest.number,
                    runtimeMs: runtime,
                    status: isTimeout ? 'timeout' : 'error',
                },
            });

            const pipelineError: PipelineError = {
                stage: this.stageName,
                substage: 'BusinessRulesValidationAgent',
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { prNumber: context.pullRequest.number },
            };

            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [];
                draft.errors.push(pipelineError);
            });
        }
    }

    private shouldRun(context: CodeReviewPipelineContext): boolean {
        if (!context.codeReviewConfig?.reviewOptions?.business_logic) {
            return false;
        }

        const prBody = context.pullRequest?.body ?? '';
        if (!this.hasBusinessSignals(prBody)) {
            return false;
        }

        const currentHash = this.computePrBodyHash(prBody);
        const lastHash =
            context.pipelineMetadata?.lastExecution?.dataExecution
                ?.businessLogicHash;
        if (lastHash && lastHash === currentHash) {
            return false;
        }

        return true;
    }

    private hasBusinessSignals(body: string): boolean {
        return (
            this.detectTicketKeys(body).length > 0 ||
            this.detectTaskLinks(body).length > 0 ||
            this.detectRequirementKeywords(body).length > 0
        );
    }

    private detectSignals(body: string): Record<string, string[]> {
        return {
            ticketKeys: this.detectTicketKeys(body),
            taskLinks: this.detectTaskLinks(body),
            requirementKeywords: this.detectRequirementKeywords(body),
        };
    }

    private detectTicketKeys(body: string): string[] {
        const matches = body.match(/[A-Z]{2,}-\d+/g);
        return matches ?? [];
    }

    private detectTaskLinks(body: string): string[] {
        const matches = body.match(/https?:\/\/[^\s)>\]"']+/g);
        return matches ?? [];
    }

    private detectRequirementKeywords(body: string): string[] {
        const lower = body.toLowerCase();
        return BusinessLogicValidationStage.REQUIREMENT_KEYWORDS.filter((kw) =>
            lower.includes(kw),
        );
    }

    private computePrBodyHash(body: string): string {
        return crypto.createHash('sha256').update(body).digest('hex');
    }

    private resultHasGap(result: string): boolean {
        if (!result || result.trim().length === 0) {
            return false;
        }
        const lower = result.toLowerCase();
        const noGapIndicators = [
            'no gaps',
            'no issues',
            'fully compliant',
            'no business logic gap',
            'all requirements met',
            'implementation is complete',
            'no violations',
        ];
        return !noGapIndicators.some((indicator) => lower.includes(indicator));
    }
}
