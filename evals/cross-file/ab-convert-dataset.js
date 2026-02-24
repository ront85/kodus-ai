#!/usr/bin/env node

/**
 * Converts a cross-file A/B dataset (JSONL) into promptfoo test cases.
 *
 * Input JSONL format (one JSON object per line):
 * {
 *   "inputs": {
 *     "fileContent": "...",
 *     "patchWithLinesStr": "...",
 *     "pullRequest": { "body": "..." },
 *     "crossFileSnippets": [
 *       {
 *         "filePath": "path/to/file.ts",
 *         "content": "function foo() { ... }",
 *         "rationale": "Called by the changed code",
 *         "relevanceScore": 0.9,
 *         "relatedSymbol": "foo",
 *         "relationship": "calls",
 *         "hop": 1,
 *         "riskLevel": "high"
 *       }
 *     ]
 *   },
 *   "outputs": {
 *     "codeSuggestions": [...]
 *   }
 * }
 *
 * Usage:
 *   node ab-convert-dataset.js
 *   node ab-convert-dataset.js --dataset=my-dataset.jsonl
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DATASET = 'crossfile-ab.jsonl';

const datasetArg = process.argv.find((a) => a.startsWith('--dataset='));
const datasetFile = datasetArg ? datasetArg.split('=')[1] : DEFAULT_DATASET;
const datasetPath = path.join(__dirname, 'datasets', datasetFile);
const outputPath = path.join(__dirname, 'datasets', 'crossfile-ab-tests.json');

// Escape nunjucks template patterns in content to avoid interpretation
function escapeTemplatePatterns(str) {
    if (!str) return str;
    return str
        .replace(/\{\{/g, '{ {')
        .replace(/\}\}/g, '} }')
        .replace(/\{%/g, '{ %')
        .replace(/%\}/g, '% }');
}

/**
 * Formats cross-file snippets into the same markdown block used by
 * prompt_codereview_system_gemini_v2 (codeReview.ts:1442-1449).
 */
function formatCrossFileContextBlock(snippets) {
    if (!snippets || !snippets.length) return '';

    const snippetLines = snippets.map((s) => {
        const symbolNote = s.relatedSymbol
            ? ` (symbol: ${s.relatedSymbol})`
            : '';
        return (
            `### ${s.filePath}${symbolNote}\n` +
            `**Rationale:** ${s.rationale}\n` +
            '```\n' +
            s.content +
            '\n```'
        );
    });

    return (
        '### Codebase Context\n' +
        'The following snippets come from **other files in the repository** that interact with ' +
        'the code under review. Use them to detect cross-file issues (broken contracts, missing ' +
        'migrations, wrong assumptions).\n\n' +
        snippetLines.join('\n\n')
    );
}

if (!fs.existsSync(datasetPath)) {
    console.error(
        `Dataset not found: ${datasetPath}\n` +
            'Create a JSONL file in evals/cross-file/datasets/ with cross-file examples.\n' +
            'See ab-convert-dataset.js header for the expected format.',
    );
    process.exit(1);
}

const lines = fs
    .readFileSync(datasetPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
        try {
            JSON.parse(line);
            return true;
        } catch {
            console.warn('Warning: skipping malformed JSON line');
            return false;
        }
    });

if (lines.length === 0) {
    console.error('No valid examples found in dataset.');
    process.exit(1);
}

const tests = lines.map((line, index) => {
    const data = JSON.parse(line);
    const inputs = data.inputs?.inputs || data.inputs || {};
    const outputs =
        data.outputs?.reference_outputs || data.outputs || {};

    const codeSuggestions = outputs.codeSuggestions || [];
    const prSummary = inputs.pullRequest?.body || inputs.prSummary || '';
    const snippets = inputs.crossFileSnippets || [];

    // Reference bugs for line-accuracy assertion
    const referenceBugs = codeSuggestions.map((s) => ({
        relevantFile: s.relevantFile,
        relevantLinesStart: s.relevantLinesStart,
        relevantLinesEnd: s.relevantLinesEnd,
    }));

    // Pre-format the cross-file context block (escaped for nunjucks safety)
    const crossFileContextBlock = escapeTemplatePatterns(
        formatCrossFileContextBlock(snippets),
    );

    return {
        description: `Example ${index + 1}: ${inputs.filePath || 'unknown'} (${snippets.length} snippets)`,
        vars: {
            fileContent: escapeTemplatePatterns(inputs.fileContent || ''),
            patchWithLinesStr: escapeTemplatePatterns(
                inputs.patchWithLinesStr || '',
            ),
            prSummary: escapeTemplatePatterns(prSummary),
            crossFileContextBlock,
            referenceBugs: JSON.stringify(referenceBugs),
            referenceCodeSuggestions: JSON.stringify(
                codeSuggestions,
                null,
                2,
            ),
        },
        assert: [
            {
                type: 'javascript',
                value: 'file://../promptfoo/parse-assertion.js',
            },
            {
                type: 'javascript',
                value: 'file://../promptfoo/judge-assertion.js',
            },
            {
                type: 'javascript',
                value: 'file://../promptfoo/line-accuracy-assertion.js',
            },
        ],
    };
});

fs.writeFileSync(outputPath, JSON.stringify(tests, null, 2));
console.log(
    `Converted ${tests.length} examples to ${outputPath} (${tests.filter((t) => t.vars.crossFileContextBlock).length} with cross-file snippets)`,
);
