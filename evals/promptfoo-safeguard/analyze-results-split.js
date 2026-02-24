#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// ─── Load results from per-dataset output files ───

const resultsDir = path.join(__dirname, 'results');
const DATASET_FILES = ['no_changes', 'update', 'discard'];

const allResults = [];
const loadedFiles = [];

for (const ds of DATASET_FILES) {
    const filePath = path.join(resultsDir, `output-${ds}.json`);
    if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const entries = data.results?.results || [];
        allResults.push(...entries);
        loadedFiles.push(`output-${ds}.json (${entries.length} tests)`);
    }
}

if (allResults.length === 0) {
    const legacyPath = path.join(resultsDir, 'output.json');
    if (fs.existsSync(legacyPath)) {
        const data = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        const entries = data.results?.results || [];
        allResults.push(...entries);
        loadedFiles.push(`output.json (${entries.length} tests)`);
    }
}

if (allResults.length === 0) {
    console.error('No result files found in results/. Run eval first.');
    process.exit(1);
}

console.log(`Loaded: ${loadedFiles.join(', ')}\n`);

// ─── Helpers ───

function parseActionMetrics(reason) {
    const match = reason.match(/ACTION_METRICS\s+action_accuracy=([\d.]+)\s+correct=(\d+)\s+total=(\d+)/);
    if (!match) return null;
    return {
        action_accuracy: parseFloat(match[1]),
        correct: parseInt(match[2], 10),
        total: parseInt(match[3], 10),
    };
}

function parseActionDetails(reason) {
    const lines = reason.split('\n').slice(1);
    const details = [];
    for (const line of lines) {
        const match = line.trim().match(/^(\S+):\s+(OK|WRONG)\s+\(expected=(\w+),\s+got=(\w+)\)/);
        if (match) {
            details.push({ id: match[1], result: match[2], expected: match[3], got: match[4] });
        }
    }
    return details;
}

function extractDatasetType(description) {
    const match = description.match(/^\[(\w+)\]/);
    return match ? match[1] : 'unknown';
}

function isCrossfile(result) {
    const ctx = result.vars?.codebaseContext || '';
    return ctx.trim().length > 0;
}

function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}

function formatTime(ms) {
    if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm';
    if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
    return ms + 'ms';
}

function avg(arr) {
    const valid = arr.filter(v => v != null && !isNaN(v));
    if (valid.length === 0) return null;
    return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function fmtPct(val) {
    if (val == null || isNaN(val)) return 'N/A';
    return (val * 100).toFixed(1) + '%';
}

function shortenModel(model) {
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
        .replace('glm-4.7', 'GLM 4.7')
        .replace('glm-5', 'GLM 5');
}

function emptyBucket() {
    return {
        tests: 0,
        latencies: [],
        apiErrors: 0,
        parseErrors: 0,
        actionScores: [],
        totalCorrect: 0,
        totalSuggestions: 0,
    };
}

// ─── Aggregate stats for a subset of results ───

function aggregateStats(subset) {
    const modelStats = {};

    subset.forEach(result => {
        const provider = result.provider.id || result.provider;

        if (!modelStats[provider]) {
            modelStats[provider] = emptyBucket();
        }

        const stats = modelStats[provider];
        stats.tests++;

        const isApiError = result.error && (
            result.error.includes('API error') ||
            result.error.includes('timeout') ||
            result.error.includes('ECONNREFUSED') ||
            (result.response?.output || '').length === 0
        );
        if (isApiError) {
            stats.apiErrors++;
            return;
        }

        const components = result.gradingResult?.componentResults || [];
        const parseAssertion = components.find(
            c => (c.reason || '').includes('PARSE_FAIL') || (c.reason || '').includes('SCHEMA_FAIL')
        );
        if (parseAssertion && !parseAssertion.pass) {
            stats.parseErrors++;
        }

        if (result.latencyMs) {
            stats.latencies.push(result.latencyMs);
        }

        const actionAssertion = components.find(
            c => c.reason && c.reason.includes('ACTION_METRICS')
        );

        if (actionAssertion) {
            const metrics = parseActionMetrics(actionAssertion.reason);
            if (metrics) {
                stats.actionScores.push(metrics.action_accuracy);
                stats.totalCorrect += metrics.correct;
                stats.totalSuggestions += metrics.total;
            }
        }
    });

    return modelStats;
}

// ─── Print results for a given modelStats ───

function printSection(modelStats, title, testCount) {
    const sorted = Object.entries(modelStats).sort((a, b) => {
        const aAvg = avg(a[1].actionScores) || 0;
        const bAvg = avg(b[1].actionScores) || 0;
        return bAvg - aAvg;
    });

    if (sorted.length === 0) return;

    console.log(`\n┌──────────────────────────────────────────────────────────────┐`);
    console.log(`│  ${title}${' '.repeat(Math.max(0, 60 - title.length))}│`);
    console.log(`└──────────────────────────────────────────────────────────────┘`);

    sorted.forEach(([model, stats], index) => {
        const shortName = shortenModel(model);
        const rank = `  ${index + 1}.`;

        const overallAcc = stats.totalSuggestions > 0
            ? ((stats.totalCorrect / stats.totalSuggestions) * 100).toFixed(1)
            : 'N/A';
        const testAvg = avg(stats.actionScores);
        const passCount = stats.actionScores.filter(s => s >= 0.7).length;
        const errorTotal = stats.apiErrors + stats.parseErrors;

        console.log(`\n${rank} ${shortName}`);
        console.log(`      Action Accuracy: ${overallAcc}% (${stats.totalCorrect}/${stats.totalSuggestions} suggestions)`);
        console.log(`      Per-test avg:    ${fmtPct(testAvg)}`);
        if (errorTotal > 0) {
            const parts = [];
            if (stats.apiErrors > 0) parts.push(`${stats.apiErrors} API`);
            if (stats.parseErrors > 0) parts.push(`${stats.parseErrors} parse`);
            console.log(`      Errors:          ${errorTotal}/${stats.tests} (${parts.join(', ')})`);
        }
        console.log(`      Passed:          ${passCount}/${stats.tests} (threshold 70%)`);
    });

    console.log('');
}

// ─── Split into 6 categories ───

const DATASET_TYPES = ['no_changes', 'update', 'discard'];
const VARIANT_TYPES = ['normal', 'crossfile'];

console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║   SAFEGUARD RESULTS — SPLIT BY DATASET + NORMAL/CROSSFILE    ║');
console.log('╚════════════════════════════════════════════════════════════════╝');

for (const dsType of DATASET_TYPES) {
    for (const variant of VARIANT_TYPES) {
        const subset = allResults.filter(result => {
            const description = result.testCase?.description || result.description || '';
            const resultDsType = extractDatasetType(description);
            const resultIsCrossfile = isCrossfile(result);

            return resultDsType === dsType &&
                (variant === 'crossfile' ? resultIsCrossfile : !resultIsCrossfile);
        });

        if (subset.length === 0) continue;

        const uniqueTests = new Set(subset.map(r => {
            const desc = r.testCase?.description || r.description || '';
            return desc;
        })).size;

        const title = `${dsType.toUpperCase()} — ${variant.toUpperCase()} (${uniqueTests} tests)`;
        const stats = aggregateStats(subset);
        printSection(stats, title);
    }
}

console.log('─────────────────────────────────────────────────────────────────');
console.log('Action Accuracy = correct_actions / total_suggestions (code-based)');
console.log('Split: dataset (no_changes/update/discard) x type (normal/crossfile)');
console.log('');
