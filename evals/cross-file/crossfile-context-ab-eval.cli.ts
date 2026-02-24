#!/usr/bin/env npx ts-node

/**
 * A/B Eval: Cross-File Context Impact on Standard Code Review Quality
 *
 * Runs the same standard code review prompt WITH and WITHOUT crossFileSnippets
 * against every dataset example, compares scores via an LLM judge.
 *
 * Usage:
 *   npx ts-node evals/cross-file/crossfile-context-ab-eval.cli.ts --inspect
 *   npx ts-node evals/cross-file/crossfile-context-ab-eval.cli.ts --env=.env.prod --dataset=<uuid>
 *   npx ts-node evals/cross-file/crossfile-context-ab-eval.cli.ts --env=.env.prod --dataset=<uuid> --model=gemini-2.5-pro
 */

import * as dotenv from 'dotenv';
import { Client, type Example } from 'langsmith';
import { evaluate, type EvaluatorT, type EvaluationResult } from 'langsmith/evaluation';
import { Logger } from '@nestjs/common';
import {
    BYOKProviderService,
    LLMModelProvider,
    LLMProviderService,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { BYOKProvider } from '@kodus/kodus-common/llm';
import { z } from 'zod';

import {
    prompt_codereview_system_gemini_v2,
    prompt_codereview_user_gemini_v2,
    CodeReviewPayload,
} from '../../libs/common/utils/langchainCommon/prompts/configuration/codeReview';
import type { CrossFileContextSnippet } from '../../libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

// ============================================================================
// Types & Configuration
// ============================================================================

const CodeReviewSuggestionSchema = z.object({
    codeSuggestions: z.array(
        z.object({
            relevantFile: z.string(),
            language: z.string(),
            suggestionContent: z.string(),
            existingCode: z.string().optional(),
            improvedCode: z.string(),
            oneSentenceSummary: z.string().optional(),
            relevantLinesStart: z.number().min(1).optional(),
            relevantLinesEnd: z.number().min(1).optional(),
            label: z.string(),
            severity: z.string().optional(),
            rankScore: z.number().optional(),
            llmPrompt: z.string().optional(),
        }),
    ),
});

type CodeReviewSuggestionSchemaType = z.infer<typeof CodeReviewSuggestionSchema>;

const DEFAULT_LANGUAGE = 'en-US';
const RUN_NAME = 'codeReviewAnalyzeWithAI';
const MAX_REASONING_TOKENS = 5000;
const DEFAULT_MODEL = 'gemini-2.5-pro';
const DEFAULT_THRESHOLD = 0.7;

type ModelConfig = {
    provider?: LLMModelProvider;
    fallback?: LLMModelProvider;
    label: string;
    byok?: {
        provider: BYOKProvider;
        model: string;
    };
};

const MODEL_CONFIGS: Record<string, ModelConfig> = {
    'gemini-2.5-pro': {
        provider: LLMModelProvider.GEMINI_2_5_PRO,
        fallback: LLMModelProvider.GEMINI_2_5_FLASH,
        label: 'gemini-2.5-pro',
    },
    'gemini-2.5-flash': {
        provider: LLMModelProvider.GEMINI_2_5_FLASH,
        fallback: undefined,
        label: 'gemini-2.5-flash',
    },
    'gemini-3-pro': {
        provider: LLMModelProvider.GEMINI_3_PRO_PREVIEW,
        fallback: LLMModelProvider.GEMINI_3_FLASH_PREVIEW,
        label: 'gemini-3-pro',
    },
    'claude-3.5-sonnet': {
        provider: LLMModelProvider.CLAUDE_3_5_SONNET,
        fallback: undefined,
        label: 'claude-3.5-sonnet',
    },
    'gpt-4o': {
        provider: LLMModelProvider.OPENAI_GPT_4O,
        fallback: LLMModelProvider.OPENAI_GPT_4O_MINI,
        label: 'gpt-4o',
    },
    'gpt-4.1': {
        provider: LLMModelProvider.OPENAI_GPT_4_1,
        fallback: LLMModelProvider.OPENAI_GPT_4O,
        label: 'gpt-4.1',
    },
};

// ============================================================================
// CLI Arguments
// ============================================================================

const args = process.argv.slice(2);
const envArg = args.find((a) => a.startsWith('--env='));
const maxConcurrencyArg = args.find((a) => a.startsWith('--max-concurrency='));
const datasetArg = args.find((a) => a.startsWith('--dataset='));
const modelArg = args.find((a) => a.startsWith('--model='));
const thresholdArg = args.find((a) => a.startsWith('--threshold='));
const inspectFull = args.includes('--inspect-full');
const inspectOnly = args.includes('--inspect') || inspectFull;
const judgeProviderArg = args.find((a) => a.startsWith('--judge-provider='));
const judgeModelArg = args.find((a) => a.startsWith('--judge-model='));
const judgeBaseUrlArg = args.find((a) => a.startsWith('--judge-base-url='));
const limitArg = args.find((a) => a.startsWith('--limit='));
const runAll = args.includes('--all');

const DEFAULT_EXAMPLE_LIMIT = 10;
const exampleLimit = runAll
    ? undefined
    : limitArg
      ? parseInt(limitArg.split('=')[1], 10)
      : DEFAULT_EXAMPLE_LIMIT;

const envPath = envArg ? envArg.split('=')[1] : process.env.DOTENV_CONFIG_PATH;

if (envPath) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

// ============================================================================
// Helper Functions
// ============================================================================

function inferByokProvider(model?: string): BYOKProvider | undefined {
    if (!model) return undefined;
    const lower = model.toLowerCase();
    if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) {
        return BYOKProvider.OPENAI;
    }
    if (lower.startsWith('claude')) return BYOKProvider.ANTHROPIC;
    if (lower.startsWith('gemini')) return BYOKProvider.GOOGLE_GEMINI;
    return undefined;
}

function parseJudgeProvider(value?: string): BYOKProvider | undefined {
    if (!value) return undefined;
    const normalized = value.toLowerCase();
    switch (normalized) {
        case 'openai': return BYOKProvider.OPENAI;
        case 'openai_compatible': return BYOKProvider.OPENAI_COMPATIBLE;
        case 'anthropic': return BYOKProvider.ANTHROPIC;
        case 'google_gemini': case 'gemini': return BYOKProvider.GOOGLE_GEMINI;
        case 'google_vertex': case 'vertex': return BYOKProvider.GOOGLE_VERTEX;
        case 'open_router': case 'openrouter': return BYOKProvider.OPEN_ROUTER;
        case 'novita': return BYOKProvider.NOVITA;
        default: return undefined;
    }
}

// ============================================================================
// Configuration
// ============================================================================

const judgeModel =
    (judgeModelArg ? judgeModelArg.split('=')[1] : undefined) ||
    process.env.EVAL_JUDGE_MODEL;
const judgeBaseUrl =
    (judgeBaseUrlArg ? judgeBaseUrlArg.split('=')[1] : undefined) ||
    process.env.EVAL_JUDGE_BASE_URL;
const judgeApiKey = process.env.EVAL_JUDGE_API_KEY;

const parsedThreshold = thresholdArg
    ? Number(thresholdArg.split('=')[1])
    : process.env.EVAL_THRESHOLD
      ? Number(process.env.EVAL_THRESHOLD)
      : undefined;

const thresholdValue =
    parsedThreshold !== undefined &&
    Number.isFinite(parsedThreshold) &&
    parsedThreshold >= 0
        ? parsedThreshold
        : DEFAULT_THRESHOLD;

const judgeProvider =
    parseJudgeProvider(judgeProviderArg?.split('=')[1]) ??
    parseJudgeProvider(process.env.EVAL_JUDGE_PROVIDER) ??
    inferByokProvider(judgeModel);
const useJudgeByok = !!judgeProvider || !!judgeModel || !!judgeBaseUrl;

const selectedModel = modelArg ? modelArg.split('=')[1].trim() : DEFAULT_MODEL;
if (!MODEL_CONFIGS[selectedModel]) {
    throw new Error(
        `Unknown model "${selectedModel}". Available: ${Object.keys(MODEL_CONFIGS).join(', ')}`,
    );
}
const modelConfig = MODEL_CONFIGS[selectedModel];

const datasetId =
    (datasetArg ? datasetArg.split('=')[1] : undefined) ??
    process.env.EVAL_AB_CROSSFILE_DATASET_ID;

const EVALUATOR_PROMPT =
    'eval_bugs_javascript_typescript_eval_codereview_standard_suggestions_3ebd1b32';
const GATE_KEYS = ['true_positives', 'recall', 'precision', 'f1'];

// Validate env
const missingEnv: string[] = [];
if (!process.env.LANGCHAIN_API_KEY && !process.env.LANGSMITH_API_KEY) {
    missingEnv.push('LANGCHAIN_API_KEY (or LANGSMITH_API_KEY)');
}
if (!process.env.API_GOOGLE_AI_API_KEY) {
    missingEnv.push('API_GOOGLE_AI_API_KEY');
}
if (missingEnv.length > 0) {
    throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
}

const parsedConcurrency = maxConcurrencyArg
    ? Number(maxConcurrencyArg.split('=')[1])
    : NaN;
const maxConcurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
        ? parsedConcurrency
        : 2;

// ============================================================================
// Services
// ============================================================================

const logger = new Logger('LangSmithABCrossFileEval');
const byokProviderService = new BYOKProviderService();
const llmProviderService = new LLMProviderService(logger, byokProviderService);
const promptRunnerService = new PromptRunnerService(logger, llmProviderService);
const client = new Client();
const evaluatorCache = new Map<string, EvaluatorT>();

// ============================================================================
// Payload Building
// ============================================================================

function normalizeKey(key: string): string {
    return key.charAt(0).toLowerCase() + key.slice(1);
}

function getField(obj: Record<string, unknown>, ...keys: string[]): unknown {
    for (const key of keys) {
        if (obj[key] !== undefined) return obj[key];
        const camel = normalizeKey(key);
        if (obj[camel] !== undefined) return obj[camel];
        const pascal = key.charAt(0).toUpperCase() + key.slice(1);
        if (obj[pascal] !== undefined) return obj[pascal];
    }
    return undefined;
}

function buildPayload(
    inputs: Record<string, unknown>,
    withSnippets: boolean,
): CodeReviewPayload {
    const nestedInputs = inputs.inputs as Record<string, unknown> | undefined;
    const actualInputs = nestedInputs || inputs;

    const fileContent = getField(actualInputs, 'fileContent', 'FileContent') as string | undefined;
    const patchWithLinesStr = getField(actualInputs, 'patchWithLinesStr', 'PatchWithLinesStr') as string | undefined;
    const languageResultPrompt = (getField(actualInputs, 'languageResultPrompt', 'LanguageResultPrompt') as string) || DEFAULT_LANGUAGE;
    const maxSuggestionsParams = getField(actualInputs, 'maxSuggestionsParams', 'MaxSuggestionsParams') as number | undefined;
    const limitationType = getField(actualInputs, 'limitationType', 'LimitationType') as string | undefined;
    const v2PromptOverrides = getField(actualInputs, 'v2PromptOverrides', 'V2PromptOverrides') as Record<string, unknown> | undefined;
    const pullRequest = getField(actualInputs, 'pullRequest', 'PullRequest') as Record<string, unknown> | undefined;
    const crossFileSnippets = getField(actualInputs, 'crossFileSnippets', 'CrossFileSnippets') as CrossFileContextSnippet[] | undefined;

    if (!patchWithLinesStr) {
        throw new Error(
            `Eval input missing patchWithLinesStr. Available keys: ${Object.keys(actualInputs).join(', ')}`,
        );
    }

    const payload: CodeReviewPayload = {
        fileContent,
        patchWithLinesStr,
        relevantContent: fileContent,
        languageResultPrompt,
        maxSuggestionsParams,
        limitationType: limitationType as any,
        v2PromptOverrides: v2PromptOverrides as any,
        prSummary: pullRequest?.body as string | undefined,
    };

    if (withSnippets && crossFileSnippets?.length) {
        payload.crossFileSnippets = crossFileSnippets;
    }

    return payload;
}

function buildRunner(
    payload: CodeReviewPayload,
    metadata: Record<string, unknown>,
    config: ModelConfig,
) {
    const baseBuilder = promptRunnerService.builder();

    if (config.byok) {
        const apiKey = process.env.API_OPENROUTER_KEY;
        if (!apiKey) {
            throw new Error('API_OPENROUTER_KEY not set in environment');
        }
        baseBuilder.setBYOKConfig({
            provider: config.byok.provider,
            model: config.byok.model,
            apiKey,
            disableReasoning: config.byok.disableReasoning,
        });
    }

    const builderWithProviders = baseBuilder.setProviders({
        main: config.provider ?? LLMModelProvider.OPENAI_GPT_4O,
        fallback: config.fallback ?? LLMModelProvider.OPENAI_GPT_4O_MINI,
    });

    return builderWithProviders
        .setParser(ParserType.ZOD, CodeReviewSuggestionSchema, {
            provider: LLMModelProvider.OPENAI_GPT_4O_MINI,
            fallbackProvider: LLMModelProvider.OPENAI_GPT_4O,
        })
        .setLLMJsonMode(true)
        .setPayload(payload)
        .addPrompt({
            prompt: prompt_codereview_system_gemini_v2,
            role: PromptRole.SYSTEM,
        })
        .addPrompt({
            prompt: prompt_codereview_user_gemini_v2,
            role: PromptRole.USER,
        })
        .setTemperature(0)
        .setRunName(RUN_NAME)
        .setMaxReasoningTokens(MAX_REASONING_TOKENS)
        .addTags(['codeReview', 'eval', 'ab-crossfile', config.label])
        .addMetadata({ ...metadata, model: config.label });
}

// ============================================================================
// Feedback Collection & Summary
// ============================================================================

type FeedbackStats = {
    total: number;
    runIds: Set<string>;
    scoreNumericCount: number;
    scoreNumericSum: number;
    scoreBoolCount: number;
    scoreBoolTrue: number;
    valueNumericCount: number;
    valueNumericSum: number;
    valueBoolCount: number;
    valueBoolTrue: number;
    valueStringCount: number;
};

type FeedbackSummary = {
    key: string;
    coverage: number;
    scoreAvg?: number;
    scoreTrueRate?: number;
    valueAvg?: number;
    valueTrueRate?: number;
    effectiveScore?: number;
    status?: 'PASS' | 'FAIL' | 'SKIP';
    threshold?: number;
};

function initFeedbackStats(): FeedbackStats {
    return {
        total: 0,
        runIds: new Set<string>(),
        scoreNumericCount: 0,
        scoreNumericSum: 0,
        scoreBoolCount: 0,
        scoreBoolTrue: 0,
        valueNumericCount: 0,
        valueNumericSum: 0,
        valueBoolCount: 0,
        valueBoolTrue: 0,
        valueStringCount: 0,
    };
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectFeedbackStats(runIds: string[]) {
    const statsByKey = new Map<string, FeedbackStats>();

    for await (const feedback of client.listFeedback({ runIds })) {
        const key = feedback.key ?? 'unknown';
        const stats = statsByKey.get(key) ?? initFeedbackStats();

        stats.total += 1;
        stats.runIds.add(feedback.run_id);

        if (typeof feedback.score === 'number') {
            stats.scoreNumericCount += 1;
            stats.scoreNumericSum += feedback.score;
        } else if (typeof feedback.score === 'boolean') {
            stats.scoreBoolCount += 1;
            stats.scoreBoolTrue += feedback.score ? 1 : 0;
        }

        if (typeof feedback.value === 'number') {
            stats.valueNumericCount += 1;
            stats.valueNumericSum += feedback.value;
        } else if (typeof feedback.value === 'boolean') {
            stats.valueBoolCount += 1;
            stats.valueBoolTrue += feedback.value ? 1 : 0;
        } else if (typeof feedback.value === 'string') {
            stats.valueStringCount += 1;
        }

        statsByKey.set(key, stats);
    }

    return statsByKey;
}

function computeSummary(
    key: string,
    stats: FeedbackStats,
    totalRuns: number,
): FeedbackSummary {
    const coverage = totalRuns > 0 ? (stats.runIds.size / totalRuns) * 100 : 0;
    const scoreAvg =
        stats.scoreNumericCount > 0
            ? stats.scoreNumericSum / stats.scoreNumericCount
            : undefined;
    const scoreTrueRate =
        stats.scoreBoolCount > 0
            ? stats.scoreBoolTrue / stats.scoreBoolCount
            : undefined;
    const valueAvg =
        stats.valueNumericCount > 0
            ? stats.valueNumericSum / stats.valueNumericCount
            : undefined;
    const valueTrueRate =
        stats.valueBoolCount > 0
            ? stats.valueBoolTrue / stats.valueBoolCount
            : undefined;

    const effectiveScore =
        scoreAvg ?? valueAvg ?? scoreTrueRate ?? valueTrueRate ?? undefined;

    return {
        key,
        coverage,
        scoreAvg,
        scoreTrueRate,
        valueAvg,
        valueTrueRate,
        effectiveScore,
    };
}

async function summarizeFeedback(
    experimentName: string,
    threshold: number,
    gateKeys?: string[],
) {
    const runIds: string[] = [];

    for await (const run of client.listRuns({
        projectName: experimentName,
        isRoot: true,
        select: ['id'],
    })) {
        if (run?.id) {
            runIds.push(run.id);
        }
    }

    if (runIds.length === 0) {
        logger.warn(`No runs found for experiment "${experimentName}".`);
        return { summaries: [] as FeedbackSummary[], failures: [] as string[] };
    }

    let statsByKey = await collectFeedbackStats(runIds);
    let attempts = 0;

    while (statsByKey.size === 0 && attempts < 3) {
        attempts += 1;
        logger.log(
            `No feedback yet for "${experimentName}". Retrying in 3s (attempt ${attempts}/3)...`,
        );
        await delay(3000);
        statsByKey = await collectFeedbackStats(runIds);
    }

    if (statsByKey.size === 0) {
        logger.warn(
            `No feedback found for experiment "${experimentName}". Check if evaluators are attached in LangSmith.`,
        );
        return {
            summaries: [] as FeedbackSummary[],
            failures: [`${experimentName}: no feedback`],
        };
    }

    logger.log(`Feedback summary for "${experimentName}"`);

    const summaries: FeedbackSummary[] = [];
    const failures: string[] = [];
    const gateKeySet = new Set(gateKeys ?? []);

    for (const [key, stats] of statsByKey.entries()) {
        const summary = computeSummary(key, stats, runIds.length);
        const parts: string[] = [`coverage=${summary.coverage.toFixed(1)}%`];

        if (summary.scoreAvg !== undefined) {
            parts.push(`score_avg=${summary.scoreAvg.toFixed(3)}`);
        }
        if (summary.scoreTrueRate !== undefined) {
            parts.push(`score_true=${(summary.scoreTrueRate * 100).toFixed(1)}%`);
        }
        if (summary.valueAvg !== undefined) {
            parts.push(`value_avg=${summary.valueAvg.toFixed(3)}`);
        }
        if (summary.valueTrueRate !== undefined) {
            parts.push(`value_true=${(summary.valueTrueRate * 100).toFixed(1)}%`);
        }

        const shouldGate =
            !gateKeys || gateKeys.length === 0 || gateKeySet.has(key);

        if (shouldGate) {
            summary.threshold = threshold;
            if (summary.effectiveScore === undefined) {
                summary.status = 'FAIL';
                parts.push(`threshold=${threshold.toFixed(2)} (FAIL)`);
                failures.push(
                    `${experimentName}:${key} missing score for threshold ${threshold.toFixed(2)}`,
                );
            } else {
                summary.status =
                    summary.effectiveScore >= threshold ? 'PASS' : 'FAIL';
                parts.push(`threshold=${threshold.toFixed(2)} (${summary.status})`);
                if (summary.status === 'FAIL') {
                    failures.push(
                        `${experimentName}:${key} score ${summary.effectiveScore.toFixed(3)} < ${threshold.toFixed(2)}`,
                    );
                }
            }
        } else {
            summary.status = 'SKIP';
            parts.push('threshold=skipped');
        }

        logger.log(`- ${key}: ${parts.join(' | ')}`);
        summaries.push(summary);
    }

    return { summaries, failures };
}

// ============================================================================
// Evaluator
// ============================================================================

function renderMustache(
    template: string,
    vars: Record<string, string>,
): string {
    return template.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '',
    );
}

async function getEvaluator(promptName: string): Promise<EvaluatorT> {
    const cached = evaluatorCache.get(promptName);
    if (cached) return cached;

    const commit = await client.pullPromptCommit(promptName);
    const manifest = commit.manifest ?? {};
    const schema = manifest?.kwargs?.schema_ as Record<string, unknown> | undefined;
    const messages = (manifest?.kwargs?.messages as any[]) ?? [];

    const systemTemplate = messages.find(
        (msg) => msg?.id?.[3] === 'SystemMessagePromptTemplate',
    )?.kwargs?.prompt?.kwargs?.template as string | undefined;

    const userTemplate = messages.find(
        (msg) => msg?.id?.[3] === 'HumanMessagePromptTemplate',
    )?.kwargs?.prompt?.kwargs?.template as string | undefined;

    if (!systemTemplate || !userTemplate) {
        throw new Error(
            `Evaluator prompt "${promptName}" is missing system or user template.`,
        );
    }

    const key = (schema?.title as string | undefined) ?? promptName ?? 'evaluation';

    const evaluator = (async (evalArgs: any): Promise<EvaluationResult> => {
        const payload = evalArgs as {
            inputs?: Record<string, unknown>;
            outputs?: Record<string, unknown>;
            referenceOutputs?: Record<string, unknown>;
            run?: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> };
            example?: { outputs?: Record<string, unknown> };
        };

        const inputs = payload.inputs ?? payload.run?.inputs ?? {};
        const outputs = payload.outputs ?? payload.run?.outputs ?? {};
        const referenceOutputs = payload.referenceOutputs ?? payload.example?.outputs ?? {};

        const vars = {
            input: JSON.stringify(inputs ?? {}),
            output: JSON.stringify(outputs ?? {}),
            reference: JSON.stringify(referenceOutputs ?? {}),
        };

        const systemPrompt = renderMustache(systemTemplate, vars);
        const userPrompt = renderMustache(userTemplate, vars);

        let builder = promptRunnerService.builder();

        if (useJudgeByok) {
            const provider = judgeProvider ?? BYOKProvider.OPENAI;
            const apiKey =
                judgeApiKey ??
                (provider === BYOKProvider.ANTHROPIC
                    ? process.env.API_ANTHROPIC_API_KEY
                    : provider === BYOKProvider.GOOGLE_GEMINI
                      ? process.env.API_GOOGLE_AI_API_KEY
                      : provider === BYOKProvider.GOOGLE_VERTEX
                        ? process.env.API_VERTEX_AI_API_KEY
                        : provider === BYOKProvider.NOVITA
                          ? process.env.API_NOVITA_AI_API_KEY
                          : process.env.API_OPEN_AI_API_KEY);

            if (!apiKey) {
                throw new Error(`Missing API key for judge provider ${provider}.`);
            }

            builder = builder.setBYOKConfig({
                provider,
                apiKey,
                model: judgeModel ?? 'gpt-5.1-chat-2025-11-13',
                baseURL:
                    provider === BYOKProvider.OPENAI_COMPATIBLE
                        ? judgeBaseUrl
                        : undefined,
            });
        }

        const result = await builder
            .setProviders({
                main: useJudgeByok
                    ? LLMModelProvider.OPENAI_GPT_4O
                    : LLMModelProvider.GEMINI_2_5_PRO,
                fallback: useJudgeByok ? undefined : LLMModelProvider.GEMINI_2_5_FLASH,
            })
            .setParser(ParserType.JSON)
            .setLLMJsonMode(true)
            .addPrompt({ prompt: systemPrompt, role: PromptRole.SYSTEM })
            .addPrompt({ prompt: userPrompt, role: PromptRole.USER })
            .setTemperature(0)
            .setRunName(`${promptName}-judge`)
            .execute();

        if (!result || typeof result !== 'object') {
            throw new Error(`Evaluator "${promptName}" returned invalid JSON output.`);
        }

        const record = result as Record<string, unknown>;
        const score =
            typeof record.correctness_score === 'number'
                ? record.correctness_score
                : typeof record.score === 'number'
                  ? record.score
                  : typeof record.passed === 'boolean'
                    ? record.passed
                    : null;
        const value =
            (record.value ??
                record.correctness_score ??
                record.score ??
                record.passed ??
                record.result ??
                record) as EvaluationResult['value'];
        const comment =
            (record.reasoning as string | undefined) ??
            (record.failure_reason as string | undefined) ??
            (record.reason as string | undefined) ??
            (record.summary as string | undefined) ??
            (record.comment as string | undefined) ??
            null;

        return { key, score, value, comment: comment ?? undefined };
    }) as EvaluatorT;

    evaluatorCache.set(promptName, evaluator);
    return evaluator;
}

// ============================================================================
// Dataset Inspection
// ============================================================================

function formatKeys(obj?: Record<string, unknown>) {
    if (!obj) return [];
    return Object.keys(obj);
}

function previewObject(obj?: Record<string, unknown>, maxLen = 300) {
    if (!obj) return '';
    try {
        const str = JSON.stringify(obj);
        if (str.length <= maxLen) return str;
        return `${str.slice(0, maxLen)}...`;
    } catch {
        return '[unserializable]';
    }
}

async function inspectDataset(id: string) {
    let firstExample: any | null = null;

    for await (const example of client.listExamples({
        datasetId: id,
        limit: 1,
        asOf: 'latest',
    })) {
        firstExample = example;
        break;
    }

    if (!firstExample) {
        logger.warn(`No examples found for dataset ${id}.`);
        return;
    }

    logger.log(`Inspecting dataset (${id})`);
    logger.log(`- exampleId: ${firstExample.id}`);
    logger.log(`- input keys: ${formatKeys(firstExample.inputs).join(', ')}`);

    const nestedInputs = firstExample.inputs?.inputs;
    if (nestedInputs && typeof nestedInputs === 'object') {
        logger.log(`- inputs.inputs keys: ${formatKeys(nestedInputs).join(', ')}`);
    }

    logger.log(`- output keys: ${formatKeys(firstExample.outputs).join(', ')}`);
    logger.log(`- inputs preview: ${previewObject(firstExample.inputs, 500)}`);

    // Check for crossFileSnippets in the dataset
    const actualInputs = nestedInputs || firstExample.inputs;
    const snippets = getField(actualInputs as Record<string, unknown>, 'crossFileSnippets', 'CrossFileSnippets');
    if (snippets && Array.isArray(snippets)) {
        logger.log(`- crossFileSnippets: ${snippets.length} snippets`);
        if (snippets.length > 0) {
            logger.log(`  - first snippet file: ${snippets[0].filePath}`);
            logger.log(`  - first snippet symbol: ${snippets[0].relatedSymbol ?? '(none)'}`);
        }
    } else {
        logger.warn(`- crossFileSnippets: NOT FOUND in dataset inputs`);
    }

    // Try building payload
    try {
        const payloadWithSnippets = buildPayload(firstExample.inputs, true);
        logger.log(`- payload build (with snippets): OK`);
        logger.log(`  - fileContent: ${payloadWithSnippets.fileContent ? `${payloadWithSnippets.fileContent.length} chars` : 'missing'}`);
        logger.log(`  - patchWithLinesStr: ${payloadWithSnippets.patchWithLinesStr ? `${payloadWithSnippets.patchWithLinesStr.length} chars` : 'missing'}`);
        logger.log(`  - crossFileSnippets: ${payloadWithSnippets.crossFileSnippets?.length ?? 0}`);
    } catch (e) {
        logger.log(`- payload build: FAILED - ${(e as Error).message}`);
    }

    if (inspectFull) {
        logger.log(`- inputs full: ${JSON.stringify(firstExample.inputs, null, 2)}`);
        logger.log(`- outputs full: ${JSON.stringify(firstExample.outputs, null, 2)}`);
    }
}

// ============================================================================
// A/B Experiment Runner
// ============================================================================

type ExperimentSummary = {
    label: 'control' | 'treatment';
    experimentName: string;
    summaries: FeedbackSummary[];
    failures: string[];
};

async function runSingleExperiment(
    experimentPrefix: string,
    label: 'control' | 'treatment',
    withSnippets: boolean,
    examples: Example[] | string,
    totalExamples: number,
): Promise<ExperimentSummary> {
    const evaluator = await getEvaluator(EVALUATOR_PROMPT);

    let completedCount = 0;

    logger.log(
        `Starting ${label} experiment: ${experimentPrefix} | model: ${modelConfig.label} | snippets: ${withSnippets} | examples: ${totalExamples}`,
    );

    const target = async (
        inputs: Record<string, unknown>,
    ): Promise<CodeReviewSuggestionSchemaType> => {
        const startTime = Date.now();
        const payload = buildPayload(inputs, withSnippets);
        const runner = buildRunner(
            payload,
            {
                datasetId: datasetId!,
                variant: label,
                withSnippets,
                model: modelConfig.label,
            },
            modelConfig,
        );

        const result = await runner.execute();

        completedCount++;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.log(`[${label}] [${completedCount}/${totalExamples}] Completed (${elapsed}s)`);

        if (!result) {
            throw new Error('LLM returned empty response for eval run.');
        }

        return result;
    };

    const results = await evaluate(target, {
        data: examples,
        experimentPrefix,
        maxConcurrency,
        description: `A/B cross-file ${label} (${modelConfig.label}) - snippets=${withSnippets}`,
        metadata: {
            datasetId: datasetId!,
            variant: label,
            withSnippets,
            model: modelConfig.label,
            judgeProvider: useJudgeByok ? (judgeProvider ?? 'openai') : 'gemini',
            judgeModel: useJudgeByok
                ? (judgeModel ?? 'gpt-5.1-chat-2025-11-13')
                : 'gemini-2.5-pro',
        },
        evaluators: [evaluator],
        client,
    });

    logger.log(`Completed ${label} experiment: ${results.experimentName}`);

    const summary = await summarizeFeedback(
        results.experimentName,
        thresholdValue,
        GATE_KEYS,
    );

    return {
        label,
        experimentName: results.experimentName,
        summaries: summary?.summaries ?? [],
        failures: summary?.failures ?? [],
    };
}

async function runABExperiment(): Promise<{
    control: ExperimentSummary;
    treatment: ExperimentSummary;
}> {
    // Fetch examples once (shared by both experiments)
    const examples: Example[] = [];
    if (exampleLimit) {
        for await (const example of client.listExamples({
            datasetId: datasetId!,
            limit: exampleLimit,
        })) {
            examples.push(example);
        }
    } else {
        for await (const example of client.listExamples({
            datasetId: datasetId!,
        })) {
            examples.push(example);
        }
    }

    if (examples.length === 0) {
        throw new Error(`No examples found in dataset ${datasetId}`);
    }

    logger.log(`Loaded ${examples.length} examples from dataset`);

    const controlPrefix = `ab-control-${modelConfig.label}`;
    const treatmentPrefix = `ab-treatment-${modelConfig.label}`;

    // Run control (no snippets), then treatment (with snippets)
    const control = await runSingleExperiment(
        controlPrefix,
        'control',
        false,
        examples,
        examples.length,
    );

    const treatment = await runSingleExperiment(
        treatmentPrefix,
        'treatment',
        true,
        examples,
        examples.length,
    );

    return { control, treatment };
}

// ============================================================================
// Comparison Table
// ============================================================================

function printComparisonTable(
    control: ExperimentSummary,
    treatment: ExperimentSummary,
) {
    const metrics = [...GATE_KEYS];

    // Collect all metric keys from both summaries
    const allKeys = new Set<string>();
    for (const s of [...control.summaries, ...treatment.summaries]) {
        allKeys.add(s.key);
    }
    for (const key of allKeys) {
        if (!metrics.includes(key)) {
            metrics.push(key);
        }
    }

    const getScore = (summaries: FeedbackSummary[], key: string) => {
        const found = summaries.find((s) => s.key === key);
        return found?.effectiveScore;
    };

    // Build table rows
    type Row = { metric: string; control: string; treatment: string; delta: string };
    const rows: Row[] = [];

    for (const metric of metrics) {
        const cScore = getScore(control.summaries, metric);
        const tScore = getScore(treatment.summaries, metric);

        const cStr = cScore !== undefined ? cScore.toFixed(3) : '-';
        const tStr = tScore !== undefined ? tScore.toFixed(3) : '-';

        let deltaStr = '-';
        if (cScore !== undefined && tScore !== undefined) {
            const diff = tScore - cScore;
            const sign = diff >= 0 ? '+' : '';
            deltaStr = `${sign}${diff.toFixed(3)}`;
        }

        rows.push({ metric, control: cStr, treatment: tStr, delta: deltaStr });
    }

    // Calculate column widths
    const cols: (keyof Row)[] = ['metric', 'control', 'treatment', 'delta'];
    const headers: Record<string, string> = {
        metric: 'Metric',
        control: 'Control',
        treatment: 'Treatment',
        delta: 'Delta',
    };
    const widths: Record<string, number> = {};
    for (const col of cols) {
        widths[col] = Math.max(
            headers[col].length,
            ...rows.map((r) => r[col].length),
        );
    }

    const hr = '\u2500';
    const sep = '\u2502';

    logger.log('');
    logger.log(`A/B Comparison: ${modelConfig.label}`);
    logger.log(`  Control:   ${control.experimentName}`);
    logger.log(`  Treatment: ${treatment.experimentName}`);
    logger.log('');

    logger.log('\u250C' + cols.map((c) => hr.repeat(widths[c] + 2)).join('\u252C') + '\u2510');
    logger.log(sep + cols.map((c) => ` ${headers[c].padEnd(widths[c])} `).join(sep) + sep);
    logger.log('\u251C' + cols.map((c) => hr.repeat(widths[c] + 2)).join('\u253C') + '\u2524');

    for (const row of rows) {
        const cells = cols.map((c) => ` ${row[c].padEnd(widths[c])} `);
        logger.log(sep + cells.join(sep) + sep);
    }

    logger.log('\u2514' + cols.map((c) => hr.repeat(widths[c] + 2)).join('\u2534') + '\u2518');
    logger.log('');

    // Pass/fail verdict
    const treatmentF1 = getScore(treatment.summaries, 'f1');
    const controlF1 = getScore(control.summaries, 'f1');

    if (treatmentF1 !== undefined && controlF1 !== undefined) {
        const noRegression = treatmentF1 >= controlF1;
        const aboveThreshold = treatmentF1 >= thresholdValue;

        logger.log(`Verdict:`);
        logger.log(`  No regression (treatment >= control): ${noRegression ? 'PASS' : 'FAIL'} (${treatmentF1.toFixed(3)} vs ${controlF1.toFixed(3)})`);
        logger.log(`  Above threshold (>= ${thresholdValue.toFixed(2)}):        ${aboveThreshold ? 'PASS' : 'FAIL'} (${treatmentF1.toFixed(3)})`);
        logger.log(`  Overall: ${noRegression && aboveThreshold ? 'PASS' : 'FAIL'}`);
    }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    if (inspectOnly) {
        if (!datasetId) {
            throw new Error(
                'Provide --dataset=<uuid> or set EVAL_AB_CROSSFILE_DATASET_ID env var.',
            );
        }
        await inspectDataset(datasetId);
        return;
    }

    if (!datasetId) {
        throw new Error(
            'Provide --dataset=<uuid> or set EVAL_AB_CROSSFILE_DATASET_ID env var.',
        );
    }

    logger.log(`A/B Cross-File Context Eval`);
    logger.log(`  Model:     ${modelConfig.label}`);
    logger.log(`  Dataset:   ${datasetId}`);
    logger.log(`  Threshold: ${thresholdValue}`);
    logger.log(`  Limit:     ${exampleLimit ?? 'all'}`);

    const { control, treatment } = await runABExperiment();

    // Print comparison table
    printComparisonTable(control, treatment);

    // Aggregate failures
    const allFailures = [...control.failures, ...treatment.failures];

    if (allFailures.length > 0) {
        logger.error(`Threshold check failures:`);
        allFailures.forEach((f) => logger.error(`- ${f}`));
        process.exitCode = 1;
    }
}

main().catch((error) => {
    logger.error('A/B cross-file eval failed', error as Error);
    process.exitCode = 1;
});
