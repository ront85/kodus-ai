#!/usr/bin/env node

/**
 * Matrix analysis: model × language breakdown.
 *
 * Reads results/output.json (promptfoo eval output) and produces:
 *   1. A console table showing combined_score per (model, language) cell
 *   2. A JSON file at results/matrix-{date}.json with full metrics
 *
 * Usage:
 *   node analyze-matrix.js                         # reads default output.json
 *   node analyze-matrix.js results/some-output.json # reads custom file
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const inputFile = process.argv[2] || path.join(__dirname, 'results', 'output.json');

if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
const results = data.results.results;

// ---------------------------------------------------------------------------
// Helpers (shared with analyze-results.js)
// ---------------------------------------------------------------------------
function parseJudgeMetrics(reason) {
    const metrics = {};
    const match = reason.match(/JUDGE_METRICS\s+(.+)/);
    if (!match) return null;
    const pairs = match[1].split(/\s+/);
    for (const pair of pairs) {
        const [key, val] = pair.split('=');
        if (key && val) {
            metrics[key] = val === 'null' ? null : parseFloat(val);
        }
    }
    return metrics;
}

function avg(arr) {
    const valid = arr.filter(v => v != null && !isNaN(v));
    if (valid.length === 0) return null;
    return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}

function fmtPct(val) {
    if (val == null || isNaN(val)) return 'N/A';
    return (val * 100).toFixed(0) + '%';
}

function shortModelName(model) {
    return model
        .replace('google:gemini-', 'Gemini ')
        .replace('anthropic:messages:', '')
        .replace('openai:', '')
        .replace('openrouter:moonshotai/', '')
        .replace('openrouter:z-ai/', '')
        .replace('-20250929', '')
        .replace('-20251001', '')
        .replace('-preview', '')
        .replace('kimi-k2.5', 'Kimi K2.5')
        .replace('glm-4.7', 'GLM 4.7');
}

// ---------------------------------------------------------------------------
// Determine language for a result (with backwards compat for old outputs)
// ---------------------------------------------------------------------------
function getLanguage(result) {
    // New: language field added by convert-dataset.js
    if (result.testCase?.vars?.language) {
        return result.testCase.vars.language;
    }
    // Fallback: infer from testCase.description or filePath in vars
    const desc = result.testCase?.description || '';
    const filePath = result.testCase?.vars?.patchWithLinesStr || '';
    const combined = desc + ' ' + filePath;
    if (/\.(ts|tsx|js|jsx)['"\s]/i.test(combined) || /typescript|javascript/i.test(combined)) return 'tsjs';
    if (/\.py['"\s]/i.test(combined) || /python/i.test(combined)) return 'python';
    if (/\.java['"\s]/i.test(combined) || /\bjava\b/i.test(combined)) return 'java';
    if (/\.rb['"\s]/i.test(combined) || /ruby/i.test(combined)) return 'ruby';
    return 'unknown';
}

// ---------------------------------------------------------------------------
// Build matrix: cells[model][language] = { ...metrics arrays }
// ---------------------------------------------------------------------------
const cells = {};
const allModels = new Set();
const allLanguages = new Set();

for (const result of results) {
    const model = result.provider?.id || result.provider || 'unknown';
    const language = getLanguage(result);

    allModels.add(model);
    allLanguages.add(language);

    const key = `${model}|||${language}`;
    if (!cells[key]) {
        cells[key] = {
            model,
            language,
            tests: 0,
            combinedScores: [],
            coverageScores: [],
            validityScores: [],
            parseErrors: 0,
            apiErrors: 0,
            latencies: [],
            lineAccScores: [],
            judgeFailsSonnet: 0,
            judgeFailsGpt: 0,
        };
    }
    const cell = cells[key];
    cell.tests++;

    // API errors
    const isApiError = result.error && (
        result.error.includes('API error') ||
        result.error.includes('timeout') ||
        result.error.includes('ECONNREFUSED') ||
        (result.response?.output || '').length === 0
    );
    if (isApiError) {
        cell.apiErrors++;
        continue;
    }

    // Parse errors
    const components = result.gradingResult?.componentResults || [];
    const parseAssertion = components.find(
        c => (c.reason || '').includes('PARSE_FAIL') || (c.reason || '').includes('Invalid JSON') || (c.reason || '').includes('Missing codeSuggestions')
    );
    if (parseAssertion && !parseAssertion.pass) {
        cell.parseErrors++;
    }

    // Latency
    if (result.latencyMs) {
        cell.latencies.push(result.latencyMs);
    }

    // Judge metrics
    const judgeAssertion = components.find(c => c.reason && c.reason.includes('JUDGE_METRICS'));
    if (judgeAssertion) {
        const metrics = parseJudgeMetrics(judgeAssertion.reason);
        if (metrics) {
            const sonnetScore = metrics.sonnet_score;
            const gptScore = metrics.gpt_score;

            if (sonnetScore !== null && !isNaN(sonnetScore)) {
                if (metrics.sonnet_coverage !== null) cell.coverageScores.push(metrics.sonnet_coverage);
                if (metrics.sonnet_validity !== null) cell.validityScores.push(metrics.sonnet_validity);
            } else {
                cell.judgeFailsSonnet++;
            }

            if (gptScore !== null && !isNaN(gptScore)) {
                if (metrics.gpt_coverage !== null) cell.coverageScores.push(metrics.gpt_coverage);
                if (metrics.gpt_validity !== null) cell.validityScores.push(metrics.gpt_validity);
            } else {
                cell.judgeFailsGpt++;
            }

            const s = sonnetScore !== null && !isNaN(sonnetScore) ? sonnetScore : 0;
            const g = gptScore !== null && !isNaN(gptScore) ? gptScore : 0;
            cell.combinedScores.push((s + g) / 2);
        }
    }

    // Line accuracy
    const lineAssertions = components.filter(c => c.reason && c.reason.includes('LINE_METRICS'));
    for (const la of lineAssertions) {
        const lineAccMatch = la.reason.match(/line_acc=([\d.]+)/);
        if (lineAccMatch) cell.lineAccScores.push(parseFloat(lineAccMatch[1]));
    }
}

// ---------------------------------------------------------------------------
// Compute summary per cell
// ---------------------------------------------------------------------------
function summarizeCell(cell) {
    return {
        model: cell.model,
        language: cell.language,
        tests: cell.tests,
        combined_score: avg(cell.combinedScores),
        coverage: avg(cell.coverageScores),
        validity: avg(cell.validityScores),
        line_accuracy: avg(cell.lineAccScores),
        parse_errors: cell.parseErrors,
        api_errors: cell.apiErrors,
        judge_fails: cell.judgeFailsSonnet + cell.judgeFailsGpt,
        latency_p50: percentile(cell.latencies, 50),
        latency_p95: percentile(cell.latencies, 95),
    };
}

const summaries = Object.values(cells).map(summarizeCell);

// ---------------------------------------------------------------------------
// Console table
// ---------------------------------------------------------------------------
const sortedModels = [...allModels].sort();
const sortedLanguages = [...allLanguages].sort();

// Build lookup
const lookup = {};
for (const s of summaries) {
    lookup[`${s.model}|||${s.language}`] = s;
}

// Column widths
const modelColWidth = Math.max(20, ...sortedModels.map(m => shortModelName(m).length + 2));
const langColWidth = 8;

function pad(str, width) {
    return String(str).padEnd(width);
}
function padL(str, width) {
    return String(str).padStart(width);
}

// Header
console.log('\n' + '='.repeat(modelColWidth + (sortedLanguages.length + 1) * langColWidth + 4));
console.log('  MODEL × LANGUAGE MATRIX (combined_score)');
console.log('='.repeat(modelColWidth + (sortedLanguages.length + 1) * langColWidth + 4));

let header = pad('', modelColWidth) + '| ';
for (const lang of sortedLanguages) {
    header += padL(lang, langColWidth);
}
header += padL('OVERALL', langColWidth);
console.log(header);
console.log('-'.repeat(header.length));

// Rows for each model
for (const model of sortedModels) {
    let row = pad(shortModelName(model), modelColWidth) + '| ';
    for (const lang of sortedLanguages) {
        const s = lookup[`${model}|||${lang}`];
        row += padL(s ? fmtPct(s.combined_score) : '-', langColWidth);
    }
    // Model overall
    const modelCells = summaries.filter(s => s.model === model);
    const modelOverall = avg(modelCells.flatMap(c => cells[`${model}|||${c.language}`]?.combinedScores || []));
    row += padL(fmtPct(modelOverall), langColWidth);
    console.log(row);
}

// Overall row
let overallRow = pad('OVERALL', modelColWidth) + '| ';
for (const lang of sortedLanguages) {
    const langCells = summaries.filter(s => s.language === lang);
    const langOverall = avg(langCells.flatMap(c => cells[`${c.model}|||${lang}`]?.combinedScores || []));
    overallRow += padL(fmtPct(langOverall), langColWidth);
}
const grandOverall = avg(Object.values(cells).flatMap(c => c.combinedScores));
overallRow += padL(fmtPct(grandOverall), langColWidth);
console.log('-'.repeat(header.length));
console.log(overallRow);
console.log('');

// ---------------------------------------------------------------------------
// Detailed table (errors + latency)
// ---------------------------------------------------------------------------
console.log('  DETAIL: parse_errors / tests | latency p50');
console.log('-'.repeat(header.length));
for (const model of sortedModels) {
    let row = pad(shortModelName(model), modelColWidth) + '| ';
    for (const lang of sortedLanguages) {
        const s = lookup[`${model}|||${lang}`];
        if (s) {
            const errRate = `${s.parse_errors}/${s.tests}`;
            row += padL(errRate, langColWidth);
        } else {
            row += padL('-', langColWidth);
        }
    }
    console.log(row);
}
console.log('');

// ---------------------------------------------------------------------------
// Save JSON
// ---------------------------------------------------------------------------
const dateStr = new Date().toISOString().slice(0, 10);
const matrixOutput = {
    generated: new Date().toISOString(),
    sourceFile: path.resolve(inputFile),
    models: sortedModels,
    languages: sortedLanguages,
    cells: summaries,
    overall: {
        combined_score: grandOverall,
        total_tests: results.length,
    },
};

const outputPath = path.join(__dirname, 'results', `matrix-${dateStr}.json`);
fs.writeFileSync(outputPath, JSON.stringify(matrixOutput, null, 2));
console.log(`Matrix saved to ${outputPath}`);

// Also save as matrix-latest.json for easy scripting
const latestPath = path.join(__dirname, 'results', 'matrix-latest.json');
fs.writeFileSync(latestPath, JSON.stringify(matrixOutput, null, 2));
console.log(`Also saved to ${latestPath}`);
