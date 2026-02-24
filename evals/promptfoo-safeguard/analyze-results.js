#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Load results from all available per-dataset output files
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

// Fallback: try legacy single output.json if no per-dataset files found
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

console.log(`Loaded: ${loadedFiles.join(', ')}`);

const results = allResults;

// Parse ACTION_METRICS from action-assertion.js reason string
function parseActionMetrics(reason) {
    const match = reason.match(/ACTION_METRICS\s+action_accuracy=([\d.]+)\s+correct=(\d+)\s+total=(\d+)/);
    if (!match) return null;
    return {
        action_accuracy: parseFloat(match[1]),
        correct: parseInt(match[2], 10),
        total: parseInt(match[3], 10),
    };
}

// Extract per-suggestion details from action assertion reason
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

// Extract dataset type from description: "[no_changes] Example 1: ..."
function extractDatasetType(description) {
    const match = description.match(/^\[(\w+)\]/);
    return match ? match[1] : 'unknown';
}

// Create empty stats bucket
function emptyBucket() {
    return {
        tests: 0,
        latencies: [],
        apiErrors: 0,
        parseErrors: 0,
        actionScores: [],
        totalCorrect: 0,
        totalSuggestions: 0,
        perAction: {
            no_changes: { correct: 0, total: 0 },
            update: { correct: 0, total: 0 },
            discard: { correct: 0, total: 0 },
        },
        wrongDetails: [],
    };
}

// Nested stats: modelStats[provider].overall + modelStats[provider].byDataset[type]
const modelStats = {};

results.forEach(result => {
    const provider = result.provider.id || result.provider;
    const description = result.testCase?.description || result.description || '';
    const dsType = extractDatasetType(description);

    if (!modelStats[provider]) {
        modelStats[provider] = {
            overall: emptyBucket(),
            byDataset: {},
        };
    }

    if (!modelStats[provider].byDataset[dsType]) {
        modelStats[provider].byDataset[dsType] = emptyBucket();
    }

    // Process into both overall and per-dataset buckets
    const buckets = [modelStats[provider].overall, modelStats[provider].byDataset[dsType]];

    for (const stats of buckets) {
        stats.tests++;
    }

    // Track API errors
    const isApiError = result.error && (
        result.error.includes('API error') ||
        result.error.includes('timeout') ||
        result.error.includes('ECONNREFUSED') ||
        (result.response?.output || '').length === 0
    );
    if (isApiError) {
        for (const stats of buckets) stats.apiErrors++;
        return;
    }

    // Track parse errors
    const components = result.gradingResult?.componentResults || [];
    const parseAssertion = components.find(
        c => (c.reason || '').includes('PARSE_FAIL') || (c.reason || '').includes('SCHEMA_FAIL')
    );
    if (parseAssertion && !parseAssertion.pass) {
        for (const stats of buckets) stats.parseErrors++;
    }

    // Collect latency
    if (result.latencyMs) {
        for (const stats of buckets) stats.latencies.push(result.latencyMs);
    }

    // Find action assertion
    const actionAssertion = components.find(
        c => c.reason && c.reason.includes('ACTION_METRICS')
    );

    if (actionAssertion) {
        const metrics = parseActionMetrics(actionAssertion.reason);
        if (metrics) {
            for (const stats of buckets) {
                stats.actionScores.push(metrics.action_accuracy);
                stats.totalCorrect += metrics.correct;
                stats.totalSuggestions += metrics.total;
            }

            const details = parseActionDetails(actionAssertion.reason);
            for (const d of details) {
                for (const stats of buckets) {
                    const bucket = stats.perAction[d.expected];
                    if (bucket) {
                        bucket.total++;
                        if (d.result === 'OK') bucket.correct++;
                    }
                    if (d.result === 'WRONG') {
                        stats.wrongDetails.push({
                            test: description,
                            id: d.id,
                            expected: d.expected,
                            got: d.got,
                        });
                    }
                }
            }
        }
    }
});

// Helpers
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

function fmtBucket(bucket) {
    if (bucket.total === 0) return '-';
    const pct = ((bucket.correct / bucket.total) * 100).toFixed(0);
    return `${pct}% (${bucket.correct}/${bucket.total})`;
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

// Print a stats bucket for a model
function printBucket(stats, indent) {
    const pad = ' '.repeat(indent);
    const overallAcc = stats.totalSuggestions > 0
        ? ((stats.totalCorrect / stats.totalSuggestions) * 100).toFixed(1)
        : 'N/A';
    const testAvg = avg(stats.actionScores);
    const passCount = stats.actionScores.filter(s => s >= 0.7).length;
    const errorTotal = stats.apiErrors + stats.parseErrors;

    console.log(`${pad}Action Accuracy: ${overallAcc}% (${stats.totalCorrect}/${stats.totalSuggestions} suggestions)`);
    console.log(`${pad}Per-test avg:    ${fmtPct(testAvg)}`);
    if (errorTotal > 0) {
        const parts = [];
        if (stats.apiErrors > 0) parts.push(`${stats.apiErrors} API`);
        if (stats.parseErrors > 0) parts.push(`${stats.parseErrors} parse`);
        console.log(`${pad}Errors:          ${errorTotal}/${stats.tests} (${parts.join(', ')})`);
    }
    console.log(`${pad}Passed:          ${passCount}/${stats.tests} (threshold 70%)`);
}

// Sort by overall action accuracy
const sorted = Object.entries(modelStats).sort((a, b) => {
    const aAvg = avg(a[1].overall.actionScores) || 0;
    const bAvg = avg(b[1].overall.actionScores) || 0;
    return bAvg - aAvg;
});

// Collect all dataset types present
const allDatasetTypes = [...new Set(
    sorted.flatMap(([, s]) => Object.keys(s.byDataset))
)].sort();

// ── OVERALL ──
console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║         SAFEGUARD EVALUATION — Action Accuracy               ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

sorted.forEach(([model, data], index) => {
    const shortName = shortenModel(model);
    const stats = data.overall;
    const rank = `  ${index + 1}.`;

    const overallAcc = stats.totalSuggestions > 0
        ? ((stats.totalCorrect / stats.totalSuggestions) * 100).toFixed(1)
        : 'N/A';

    const p50 = formatTime(percentile(stats.latencies, 50));
    const p95 = formatTime(percentile(stats.latencies, 95));

    console.log(`${rank} ${shortName}  —  ${overallAcc}% overall (${stats.totalCorrect}/${stats.totalSuggestions})`);
    console.log(`      Latency: p50=${p50}  p95=${p95}`);
    console.log('');
});

// ── PER-DATASET SECTIONS ──
for (const dsType of allDatasetTypes) {
    const label = dsType.toUpperCase();
    console.log(`┌──────────────────────────────────────────────────────────────┐`);
    console.log(`│  Dataset: ${label}${' '.repeat(Math.max(0, 50 - label.length))}│`);
    console.log(`└──────────────────────────────────────────────────────────────┘`);

    // Sort models by this dataset's accuracy
    const dsorted = sorted
        .filter(([, d]) => d.byDataset[dsType])
        .sort((a, b) => {
            const aAvg = avg(a[1].byDataset[dsType].actionScores) || 0;
            const bAvg = avg(b[1].byDataset[dsType].actionScores) || 0;
            return bAvg - aAvg;
        });

    dsorted.forEach(([model, data], index) => {
        const shortName = shortenModel(model);
        const stats = data.byDataset[dsType];
        const rank = `  ${index + 1}.`;

        console.log(`\n${rank} ${shortName}`);
        printBucket(stats, 6);

    });

    console.log('\n');
}

console.log('─────────────────────────────────────────────────────────────────');
console.log('Action Accuracy = correct_actions / total_suggestions (code-based, no LLM judge)');
console.log('Results split by dataset type so you can tune instructions per action');
console.log('');
