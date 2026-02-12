/**
 * @license
 * © Kodus Tech. All rights reserved.
 */

import { Injectable } from '@nestjs/common';

import { BaseFileReviewContextPreparation } from './base-file-review.abstract';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { ReviewModeOptions } from '@libs/core/domain/interfaces/file-review-context-preparation.interface';
import {
    FileChange,
    ReviewModeResponse,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { TaskStatus } from '@libs/ee/kodyAST/interfaces/code-ast-analysis.interface';

@Injectable()
export class FileReviewContextPreparation extends BaseFileReviewContextPreparation {
    protected async determineReviewMode(
        options?: ReviewModeOptions,
        byokConfig?: BYOKConfig,
    ): Promise<ReviewModeResponse> {
        return ReviewModeResponse.HEAVY_MODE;
    }

    protected getRelevantFileContent(file: FileChange): Promise<{
        relevantContent: string | null;
        taskStatus?: TaskStatus;
        hasRelevantContent?: boolean;
    }> {
        // In the standard version, we return the file content directly
        // without any additional processing
        return Promise.resolve({
            relevantContent: file.content || null,
            hasRelevantContent: false,
            taskStatus: TaskStatus.TASK_STATUS_FAILED,
        });
    }
}
