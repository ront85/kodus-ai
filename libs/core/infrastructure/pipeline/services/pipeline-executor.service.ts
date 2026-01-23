import { v4 as uuid } from 'uuid';
import { produce } from 'immer';
import { PipelineContext } from '../interfaces/pipeline-context.interface';
import { createLogger } from '@kodus/flow';
import { PipelineStage } from '../interfaces/pipeline.interface';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';

type SkipDecision = 'EXECUTE_STAGE' | 'SKIP_STAGE' | 'ABORT_PIPELINE';

// Memory debugging - enable with PIPELINE_MEMORY_DEBUG=true
const MEMORY_DEBUG_ENABLED = process.env.PIPELINE_MEMORY_DEBUG === 'true';

function getMemoryMB(): { heapUsed: number; heapTotal: number; rss: number; external: number } {
    const mem = process.memoryUsage();
    return {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        rss: Math.round(mem.rss / 1024 / 1024),
        external: Math.round(mem.external / 1024 / 1024),
    };
}

export class PipelineExecutor<TContext extends PipelineContext> {
    private readonly logger = createLogger(PipelineExecutor.name);

    constructor() {}

    async execute(
        context: TContext,
        stages: PipelineStage<TContext>[],
        pipelineName = 'UnnamedPipeline',
        parentPipelineId?: string,
        rootPipelineId?: string,
    ): Promise<TContext> {
        const pipelineId = uuid();

        context.pipelineMetadata = {
            ...(context.pipelineMetadata || {}),
            pipelineId,
            parentPipelineId,
            rootPipelineId: rootPipelineId || pipelineId,
            pipelineName,
        };

        const pipelineMemStart = MEMORY_DEBUG_ENABLED ? getMemoryMB() : null;

        if (MEMORY_DEBUG_ENABLED) {
            this.logger.log({
                message: `[MEM] ====== PIPELINE ${pipelineName} START: heap=${pipelineMemStart!.heapUsed}MB, rss=${pipelineMemStart!.rss}MB ======`,
                context: PipelineExecutor.name,
                serviceName: PipelineExecutor.name,
            });
        }

        this.logger.log({
            message: `Starting pipeline: ${pipelineName} (ID: ${pipelineId})`,
            context: PipelineExecutor.name,
            serviceName: PipelineExecutor.name,
            metadata: {
                ...context?.pipelineMetadata,
                correlationId: (context as any)?.correlationId ?? null,
                organizationAndTeamData:
                    (context as any)?.organizationAndTeamData ?? null,
                status: context.statusInfo,
            },
        });

        for (const stage of stages) {
            // Check if we need to handle skip/jump logic
            if (context.statusInfo.status === AutomationStatus.SKIPPED) {
                const result = this.handleSkipOrJump(
                    context,
                    stage,
                    pipelineName,
                    pipelineId,
                );

                context = result.newContext;

                if (result.decision === 'ABORT_PIPELINE') {
                    break;
                }

                if (result.decision === 'SKIP_STAGE') {
                    continue;
                }
            }

            const start = Date.now();
            const memBefore = MEMORY_DEBUG_ENABLED ? getMemoryMB() : null;

            if (MEMORY_DEBUG_ENABLED) {
                this.logger.log({
                    message: `[MEM] ${stage.stageName} START: heap=${memBefore!.heapUsed}MB, rss=${memBefore!.rss}MB, external=${memBefore!.external}MB`,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                });
            }

            try {
                context = await stage.execute(context);

                const memAfter = MEMORY_DEBUG_ENABLED ? getMemoryMB() : null;
                const memDiff = memBefore && memAfter ? memAfter.heapUsed - memBefore.heapUsed : 0;

                if (MEMORY_DEBUG_ENABLED) {
                    this.logger.log({
                        message: `[MEM] ${stage.stageName} END: heap=${memAfter!.heapUsed}MB (${memDiff >= 0 ? '+' : ''}${memDiff}MB), rss=${memAfter!.rss}MB`,
                        context: PipelineExecutor.name,
                        serviceName: PipelineExecutor.name,
                        metadata: {
                            memoryDelta: memDiff,
                            heapUsed: memAfter!.heapUsed,
                            heapTotal: memAfter!.heapTotal,
                            rss: memAfter!.rss,
                        },
                    });
                }

                this.logger.log({
                    message: `Stage '${stage.stageName}' completed in ${
                        Date.now() - start
                    }ms: ${pipelineId}`,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                    metadata: {
                        task: (context as any)?.tasks ?? null,
                        ...context?.pipelineMetadata,
                        stage: stage.stageName,
                        correlationId: (context as any)?.correlationId ?? null,
                        organizationAndTeamData:
                            (context as any)?.organizationAndTeamData ?? null,
                        status: context.statusInfo,
                    },
                });
            } catch (error) {
                this.logger.error({
                    message: `Stage '${stage.stageName}' failed: ${error.message}`,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                    error: error,
                    metadata: {
                        correlationId: (context as any)?.correlationId ?? null,
                        ...context?.pipelineMetadata,
                        stage: stage.stageName,
                        organizationAndTeamData:
                            (context as any)?.organizationAndTeamData ?? null,
                        status: context.statusInfo,
                    },
                });

                this.logger.warn({
                    message: `Pipeline '${pipelineName}:${pipelineId}' continuing despite error in stage '${stage.stageName}'`,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                    metadata: {
                        ...context?.pipelineMetadata,
                        stage: stage.stageName,
                        correlationId: (context as any)?.correlationId ?? null,
                        organizationAndTeamData:
                            (context as any)?.organizationAndTeamData ?? null,
                        status: context.statusInfo,
                    },
                });
            }
        }

        // Restore skipped status if needed (for historical accuracy)
        if (context.statusInfo.skippedReason) {
            context = produce(context, (draft) => {
                const reason = draft.statusInfo.skippedReason!;
                draft.statusInfo.status = reason.status;

                if (reason.message) {
                    draft.statusInfo.message = reason.message;
                }
            });
        }

        if (MEMORY_DEBUG_ENABLED && pipelineMemStart) {
            const pipelineMemEnd = getMemoryMB();
            const totalDiff = pipelineMemEnd.heapUsed - pipelineMemStart.heapUsed;
            this.logger.log({
                message: `[MEM] ====== PIPELINE ${pipelineName} END: heap=${pipelineMemEnd.heapUsed}MB (${totalDiff >= 0 ? '+' : ''}${totalDiff}MB total), rss=${pipelineMemEnd.rss}MB ======`,
                context: PipelineExecutor.name,
                serviceName: PipelineExecutor.name,
                metadata: {
                    pipelineName,
                    memoryDelta: totalDiff,
                    heapStart: pipelineMemStart.heapUsed,
                    heapEnd: pipelineMemEnd.heapUsed,
                    rssEnd: pipelineMemEnd.rss,
                },
            });
        }

        this.logger.log({
            message: `Finished pipeline: ${pipelineName} (ID: ${pipelineId})`,
            context: PipelineExecutor.name,
            serviceName: PipelineExecutor.name,
            metadata: {
                ...context?.pipelineMetadata,
                correlationId: (context as any)?.correlationId ?? null,
                organizationAndTeamData:
                    (context as any)?.organizationAndTeamData ?? null,
            },
        });

        return context;
    }

    private handleSkipOrJump(
        context: TContext,
        stage: PipelineStage<TContext>,
        pipelineName: string,
        pipelineId: string,
    ): { decision: SkipDecision; newContext: TContext } {
        const targetStage = context.statusInfo.jumpToStage;

        if (!targetStage) {
            this.logger.log({
                message: `Pipeline '${pipelineName}' skipped due to SKIP status ${pipelineId}`,
                context: PipelineExecutor.name,
                serviceName: PipelineExecutor.name,
                metadata: {
                    ...context?.pipelineMetadata,
                    stage: stage.stageName,
                    correlationId: (context as any)?.correlationId ?? null,
                    organizationAndTeamData:
                        (context as any)?.organizationAndTeamData ?? null,
                    status: context.statusInfo,
                },
            });

            return { decision: 'ABORT_PIPELINE', newContext: context };
        }

        if (stage.stageName !== targetStage) {
            this.logger.log({
                message: `Skipping stage '${stage.stageName}' while looking for '${targetStage}'`,
                context: PipelineExecutor.name,
                serviceName: PipelineExecutor.name,
                metadata: {
                    ...context?.pipelineMetadata,
                    stage: stage.stageName,
                    correlationId: (context as any)?.correlationId ?? null,
                    status: context.statusInfo,
                },
            });
            return { decision: 'SKIP_STAGE', newContext: context };
        }

        this.logger.log({
            message: `Resuming pipeline execution at stage: ${stage.stageName}`,
            context: PipelineExecutor.name,
            serviceName: PipelineExecutor.name,
            metadata: {
                ...context?.pipelineMetadata,
                stage: stage.stageName,
                correlationId: (context as any)?.correlationId ?? null,
                status: context.statusInfo,
            },
        });

        const newContext = produce(context, (draft) => {
            draft.statusInfo.skippedReason = {
                status: context.statusInfo.status,
                message: context.statusInfo.message,
                stageName: stage.stageName,
                jumpToStage: context.statusInfo.jumpToStage,
            };

            draft.statusInfo.jumpToStage = undefined;
            draft.statusInfo.status = AutomationStatus.IN_PROGRESS;
        });

        return { decision: 'EXECUTE_STAGE', newContext };
    }
}
