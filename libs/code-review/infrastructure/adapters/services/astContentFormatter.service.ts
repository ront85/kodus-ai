import { Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';

import { AxiosASTService } from '@libs/core/infrastructure/config/axios/microservices/ast.axios';
import { encrypt, decrypt } from '@libs/common/utils/crypto';
import { SUPPORTED_LANGUAGES } from '@libs/code-review/domain/contracts/SupportedLanguages';
import {
    FileContentFlag,
    InitializeContentFromDiffRequest,
    GetContentFromDiffResponse,
} from '@libs/ee/kodyAST/interfaces/code-ast-analysis.interface';
import {
    AnalysisContext,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;

@Injectable()
export class ASTContentFormatterService {
    private readonly logger = createLogger(ASTContentFormatterService.name);
    private readonly astAxios = new AxiosASTService();

    /**
     * Fetches AST-formatted content for a batch of files.
     * Filters by supported language, compresses + encrypts content,
     * sends to the AST service, polls for the result, then decrypts + decompresses.
     *
     * Returns a Map<filename, { content, flag }> for files that were successfully processed.
     * Files not in the map should fall back to their original fileContent.
     */
    async fetchFormattedContent(
        batch: FileChange[],
        context: AnalysisContext,
    ): Promise<Map<string, { content: string; flag: FileContentFlag }>> {
        const emptyResult = new Map<
            string,
            { content: string; flag: FileContentFlag }
        >();

        try {
            // Filter files by supported language
            const supportedExtensions = this.getSupportedExtensions();
            const eligibleFiles = batch.filter((file) => {
                const ext = path.extname(file.filename).toLowerCase();
                return supportedExtensions.has(ext);
            });

            if (eligibleFiles.length === 0) {
                return emptyResult;
            }

            // Build request: generate ID, compress + encrypt each file
            const idToFilename = new Map<string, string>();
            const requestFiles: InitializeContentFromDiffRequest['files'] = [];

            for (const file of eligibleFiles) {
                const fileContent = file.fileContent || file.content || '';
                const filePatch = file.patch || '';

                if (!fileContent && !filePatch) {
                    continue;
                }

                const id = uuidv4();
                idToFilename.set(id, file.filename);

                const [encryptedContent, encryptedDiff] = await Promise.all([
                    this.compressAndEncrypt(fileContent),
                    this.compressAndEncrypt(filePatch),
                ]);

                requestFiles.push({
                    id,
                    content: encryptedContent,
                    filePath: file.filename,
                    diff: encryptedDiff,
                });
            }

            if (requestFiles.length === 0) {
                return emptyResult;
            }

            // POST to initialize the task
            const { taskId } = await this.initializeTask(requestFiles, context);

            if (!taskId) {
                return emptyResult;
            }

            // Poll for the result
            const response = await this.pollForResult(taskId, context);

            if (!response?.files?.length) {
                return emptyResult;
            }

            // Decrypt + decompress each file in the response
            const resultMap = new Map<
                string,
                { content: string; flag: FileContentFlag }
            >();

            for (const responseFile of response.files) {
                const filename = idToFilename.get(responseFile.id);
                if (!filename) {
                    continue;
                }

                try {
                    const decryptedContent = await this.decryptAndDecompress(
                        responseFile.content,
                    );
                    resultMap.set(filename, {
                        content: decryptedContent,
                        flag: responseFile.flag,
                    });
                } catch (error) {
                    this.logger.error({
                        message: `Failed to decrypt/decompress AST result for file ${filename}`,
                        error,
                        context: ASTContentFormatterService.name,
                        metadata: {
                            filename,
                            fileId: responseFile.id,
                        },
                    });
                    // Skip this file — it will use the original fileContent
                }
            }

            this.logger.log({
                message: `AST content formatting completed: ${resultMap.size}/${eligibleFiles.length} files processed`,
                context: ASTContentFormatterService.name,
                metadata: {
                    totalBatchSize: batch.length,
                    eligibleFiles: eligibleFiles.length,
                    processedFiles: resultMap.size,
                },
            });

            return resultMap;
        } catch (error) {
            this.logger.error({
                message: 'Failed to fetch AST formatted content for batch',
                error,
                context: ASTContentFormatterService.name,
                metadata: {
                    batchSize: batch.length,
                    organizationId: context.organizationAndTeamData?.organizationId,
                },
            });
            return emptyResult;
        }
    }

    private async initializeTask(
        files: InitializeContentFromDiffRequest['files'],
        context: AnalysisContext,
    ): Promise<{ taskId: string }> {
        try {
            const response = await this.astAxios.post<{ taskId: string }>(
                '/api/ast/diff/content',
                { files } as unknown as Record<string, unknown>,
                {
                    headers: {
                        'x-task-key':
                            context.organizationAndTeamData?.organizationId,
                    },
                },
            );

            this.logger.log({
                message: `AST diff content task initialized`,
                context: ASTContentFormatterService.name,
                metadata: {
                    taskId: response?.taskId,
                    filesCount: files.length,
                },
            });

            return { taskId: response?.taskId };
        } catch (error) {
            this.logger.error({
                message: 'Failed to initialize AST diff content task',
                error,
                context: ASTContentFormatterService.name,
                metadata: {
                    filesCount: files.length,
                    organizationId: context.organizationAndTeamData?.organizationId,
                },
            });
            return { taskId: null };
        }
    }

    private async pollForResult(
        taskId: string,
        context: AnalysisContext,
    ): Promise<GetContentFromDiffResponse | null> {
        const startTime = Date.now();
        let attempt = 0;

        while (true) {
            const elapsed = Date.now() - startTime;

            if (elapsed > POLL_TIMEOUT_MS) {
                this.logger.warn({
                    message: `AST diff content task ${taskId} timed out after ${POLL_TIMEOUT_MS}ms`,
                    context: ASTContentFormatterService.name,
                    metadata: {
                        taskId,
                        attempts: attempt,
                        timeout: POLL_TIMEOUT_MS,
                    },
                });
                return null;
            }

            try {
                const response =
                    await this.astAxios.get<GetContentFromDiffResponse>(
                        `/api/ast/diff/content/retrieve/${taskId}`,
                        {
                            headers: {
                                'x-task-key':
                                    context.organizationAndTeamData
                                        ?.organizationId,
                            },
                        },
                    );

                if (response?.files?.length > 0) {
                    this.logger.log({
                        message: `AST diff content task ${taskId} completed`,
                        context: ASTContentFormatterService.name,
                        metadata: {
                            taskId,
                            filesCount: response.files.length,
                            attempts: attempt + 1,
                            elapsedMs: elapsed,
                        },
                    });
                    return response;
                }
            } catch (error) {
                // 404 or pending — keep polling
                if (error?.response?.status !== 404) {
                    this.logger.warn({
                        message: `Transient error polling AST diff content task ${taskId}`,
                        error,
                        context: ASTContentFormatterService.name,
                        metadata: {
                            taskId,
                            attempt: attempt + 1,
                        },
                    });
                }
            }

            await new Promise((resolve) =>
                setTimeout(resolve, POLL_INTERVAL_MS),
            );
            attempt++;
        }
    }

    /**
     * Compress with gzip then encrypt.
     * Format: encrypt(base64(gzip(plaintext)))
     */
    private async compressAndEncrypt(text: string): Promise<string> {
        if (!text) return encrypt('');
        const compressed = await gzipAsync(Buffer.from(text, 'utf-8'));
        const base64 = compressed.toString('base64');
        return encrypt(base64);
    }

    /**
     * Decrypt then decompress.
     * Format: gunzip(fromBase64(decrypt(ciphertext)))
     */
    private async decryptAndDecompress(ciphertext: string): Promise<string> {
        if (!ciphertext) return '';
        const base64 = decrypt(ciphertext);
        const buffer = Buffer.from(base64, 'base64');
        const decompressed = await gunzipAsync(buffer);
        return decompressed.toString('utf-8');
    }

    private getSupportedExtensions(): Set<string> {
        const extensions = new Set<string>();
        for (const config of Object.values(SUPPORTED_LANGUAGES)) {
            for (const ext of config.extensions) {
                extensions.add(ext);
            }
        }
        return extensions;
    }
}
