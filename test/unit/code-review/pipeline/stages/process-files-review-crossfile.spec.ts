import { Test, TestingModule } from '@nestjs/testing';
import { ProcessFilesReview } from '@libs/code-review/pipeline/stages/process-files-review.stage';
import { SUGGESTION_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/SuggestionService.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { FILE_REVIEW_CONTEXT_PREPARATION_TOKEN } from '@libs/core/domain/interfaces/file-review-context-preparation.interface';
import { KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN } from '@libs/core/domain/interfaces/kody-fine-tuning-context-preparation.interface';
import { KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN } from '@libs/core/domain/interfaces/kody-ast-analyze-context-preparation.interface';
import { CodeAnalysisOrchestrator } from '@libs/ee/codeBase/codeAnalysisOrchestrator.service';
import { CrossFileContextSnippet } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import {
    createSampleFileChange,
    createSampleSnippet,
    createCrossFileBaseContext,
} from '../../../../fixtures/cross-file-context.fixtures';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('ProcessFilesReview — Cross-File Filtering', () => {
    let stage: ProcessFilesReview;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ProcessFilesReview,
                {
                    provide: SUGGESTION_SERVICE_TOKEN,
                    useValue: {
                        filterCodeSuggestionsByReviewOptions: jest.fn(),
                        filterSuggestionsCodeDiff: jest.fn(),
                        getDiscardedSuggestions: jest.fn(),
                        filterSuggestionsSafeGuard: jest.fn(),
                        analyzeSuggestionsSeverity: jest.fn(),
                        filterSuggestionsBySeverityLevel: jest.fn(),
                        calculateSuggestionRankScore: jest.fn(),
                        removeSuggestionsRelatedToSavedFiles: jest.fn(),
                    },
                },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: {
                        findSuggestionsByPRAndFilename: jest.fn(),
                    },
                },
                {
                    provide: FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
                    useValue: {
                        prepareFileContext: jest.fn(),
                    },
                },
                {
                    provide: KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN,
                    useValue: {
                        prepareKodyFineTuningContext: jest.fn(),
                    },
                },
                {
                    provide: KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN,
                    useValue: {
                        prepareKodyASTAnalyzeContext: jest.fn(),
                    },
                },
                {
                    provide: CodeAnalysisOrchestrator,
                    useValue: {
                        executeStandardAnalysis: jest.fn(),
                        executeKodyRulesAnalysis: jest.fn(),
                    },
                },
            ],
        }).compile();

        stage = module.get<ProcessFilesReview>(ProcessFilesReview);
        jest.clearAllMocks();
    });

    // ─── filterSnippetsForFile ─────────────────────────────────────────────

    describe('filterSnippetsForFile()', () => {
        const filterSnippets = (
            allSnippets: CrossFileContextSnippet[] | undefined,
            file: any,
        ) => (stage as any).filterSnippetsForFile(allSnippets, file);

        it('should return empty array when allSnippets is empty', () => {
            const result = filterSnippets(
                [],
                createSampleFileChange(),
            );
            expect(result).toEqual([]);
        });

        it('should return empty array when allSnippets is undefined', () => {
            const result = filterSnippets(
                undefined,
                createSampleFileChange(),
            );
            expect(result).toEqual([]);
        });

        it('should return empty array when file has no diff', () => {
            const file = createSampleFileChange({
                patch: undefined,
                patchWithLinesStr: undefined,
            });
            const snippets = [createSampleSnippet({ relatedSymbol: 'greet' })];

            const result = filterSnippets(snippets, file);
            expect(result).toEqual([]);
        });

        it('should filter by relatedSymbol present in diff', () => {
            const file = createSampleFileChange({
                patchWithLinesStr:
                    '+import { greet } from "./utils";\n+greet("world");',
            });
            const snippets = [
                createSampleSnippet({ relatedSymbol: 'greet' }),
                createSampleSnippet({
                    relatedSymbol: 'farewell',
                    filePath: 'other.ts',
                }),
            ];

            const result = filterSnippets(snippets, file);
            expect(result).toHaveLength(1);
            expect(result[0].relatedSymbol).toBe('greet');
        });

        it('should include snippets with undefined relatedSymbol (pass-through)', () => {
            const file = createSampleFileChange({
                patchWithLinesStr: '+some code change',
            });
            const snippets = [
                createSampleSnippet({ relatedSymbol: undefined }),
            ];

            const result = filterSnippets(snippets, file);
            expect(result).toHaveLength(1);
        });

        it('should match compound symbol parts (e.g. PlanType.PREMIUM matches PlanType)', () => {
            const file = createSampleFileChange({
                patchWithLinesStr:
                    '+import { PlanType } from "./types";\n+if (plan === PlanType.PRO) {',
            });
            const snippets = [
                createSampleSnippet({ relatedSymbol: 'PlanType.PREMIUM' }),
            ];

            const result = filterSnippets(snippets, file);
            expect(result).toHaveLength(1);
        });

        it('should skip symbol parts shorter than 3 chars to avoid false positives', () => {
            const file = createSampleFileChange({
                patchWithLinesStr: '+const id = getUserId();',
            });
            const snippets = [
                createSampleSnippet({ relatedSymbol: 'x.id' }),
            ];

            // "x" is too short (<3), but "id" is only 2 chars — also skipped.
            // Neither part qualifies, so the snippet is excluded.
            const result = filterSnippets(snippets, file);
            expect(result).toEqual([]);
        });

        it('should fallback to file.patch when patchWithLinesStr is missing', () => {
            const file = createSampleFileChange({
                patchWithLinesStr: undefined,
                patch: '+import { greet } from "./utils";\n+greet("world");',
            });
            const snippets = [
                createSampleSnippet({ relatedSymbol: 'greet' }),
            ];

            const result = filterSnippets(snippets, file);
            expect(result).toHaveLength(1);
        });

        it('should use targetFiles as primary filter when populated', () => {
            const file = createSampleFileChange({
                filename: 'src/handler.ts',
                patchWithLinesStr: '+some code',
            });
            const snippets = [
                createSampleSnippet({
                    relatedSymbol: 'greet',
                    targetFiles: ['src/handler.ts'],
                }),
                createSampleSnippet({
                    relatedSymbol: 'greet',
                    targetFiles: ['src/other.ts'],
                    filePath: 'other-consumer.ts',
                }),
            ];

            const result = filterSnippets(snippets, file);
            expect(result).toHaveLength(1);
            expect(result[0].targetFiles).toEqual(['src/handler.ts']);
        });

        it('should fall back to text heuristics when targetFiles is not populated', () => {
            const file = createSampleFileChange({
                filename: 'src/handler.ts',
                patchWithLinesStr: '+import { greet } from "./utils";',
            });
            const snippets = [
                createSampleSnippet({
                    relatedSymbol: 'greet',
                    // no targetFiles — backward compat
                }),
            ];

            const result = filterSnippets(snippets, file);
            // Should still pass via text-based matching (hop=1 pass-through)
            expect(result).toHaveLength(1);
        });

        it('should exclude snippet when targetFiles is populated but does not include file', () => {
            const file = createSampleFileChange({
                filename: 'src/handler.ts',
                patchWithLinesStr: '+import { greet } from "./utils";\n+greet("world");',
            });
            const snippets = [
                createSampleSnippet({
                    relatedSymbol: 'greet',
                    targetFiles: ['src/completely-different.ts'],
                }),
            ];

            const result = filterSnippets(snippets, file);
            expect(result).toHaveLength(0);
        });

        it('should route different snippets to different files based on their diff', () => {
            const fileA = createSampleFileChange({
                filename: 'handler.ts',
                patchWithLinesStr: '+EventBus.emit("order.completed");',
            });
            const fileB = createSampleFileChange({
                filename: 'cache.ts',
                patchWithLinesStr: '+redis.get(cacheKey);',
            });

            const snippetForA = createSampleSnippet({
                relatedSymbol: 'EventBus',
                filePath: 'event-bus.ts',
            });
            const snippetForB = createSampleSnippet({
                relatedSymbol: 'cacheKey',
                filePath: 'cache-keys.ts',
            });
            const snippetForAll = createSampleSnippet({
                relatedSymbol: undefined,
                filePath: 'config.ts',
            });

            const allSnippets = [snippetForA, snippetForB, snippetForAll];

            const resultA = filterSnippets(allSnippets, fileA);
            const resultB = filterSnippets(allSnippets, fileB);

            // fileA gets EventBus snippet + config (no symbol)
            expect(resultA.map((s: CrossFileContextSnippet) => s.filePath)).toEqual(
                expect.arrayContaining(['event-bus.ts', 'config.ts']),
            );
            expect(resultA).toHaveLength(2);

            // fileB gets cacheKey snippet + config (no symbol)
            expect(resultB.map((s: CrossFileContextSnippet) => s.filePath)).toEqual(
                expect.arrayContaining(['cache-keys.ts', 'config.ts']),
            );
            expect(resultB).toHaveLength(2);
        });
    });

    // ─── createAnalysisContextFromPipelineContext ───────────────────────────

    describe('createAnalysisContextFromPipelineContext()', () => {
        it('should map crossFileContexts.contexts → crossFileSnippets', () => {
            const snippet = createSampleSnippet();
            const context = createCrossFileBaseContext({
                crossFileContexts: {
                    contexts: [snippet],
                    plannerQueries: [],
                    totalSearches: 1,
                    totalSnippetsBeforeDedup: 1,
                },
            });

            const analysisContext = (
                stage as any
            ).createAnalysisContextFromPipelineContext(context);

            expect(analysisContext.crossFileSnippets).toEqual([snippet]);
        });
    });
});
