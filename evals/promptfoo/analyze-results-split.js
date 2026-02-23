#!/usr/bin/env node

const { loadResults } = require('./load-results');
const { results, loadedFiles } = loadResults();

if (results.length === 0) {
    console.error('No result files found in results/. Run eval first.');
    process.exit(1);
}
console.log(`Loaded: ${loadedFiles.join(', ')}\n`);

// ─── Helpers ───

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
    return (val * 100).toFixed(0) + '%';
}

function shortName(model) {
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

function newModelStats() {
    return {
        tests: 0,
        latencies: [],
        lineAccScores: [],
        avgIoUScores: [],
        exactMatchScores: [],
        within3Scores: [],
        apiErrors: 0,
        parseErrors: 0,
        judges: {
            sonnet: { coverage: [], validity: [], scores: [] },
            gpt: { coverage: [], validity: [], scores: [] },
        },
        judgeFailsSonnet: 0,
        judgeFailsGpt: 0,
        combinedScores: [],
    };
}

// ─── Split results into normal vs crossfile ───

function isCrossfile(result) {
    const ctx = result.vars?.crossFileContext || '';
    return ctx.trim().length > 0;
}

const normalResults = results.filter(r => !isCrossfile(r));
const crossfileResults = results.filter(r => isCrossfile(r));

// ─── Aggregate stats for a subset of results ───

function aggregateStats(subset) {
    const modelStats = {};

    subset.forEach(result => {
        const provider = result.provider.id || result.provider;

        if (!modelStats[provider]) {
            modelStats[provider] = newModelStats();
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
            c => (c.reason || '').includes('PARSE_FAIL') || (c.reason || '').includes('Invalid JSON') || (c.reason || '').includes('Missing codeSuggestions')
        );
        if (parseAssertion && !parseAssertion.pass) {
            stats.parseErrors++;
        }

        if (result.latencyMs) {
            stats.latencies.push(result.latencyMs);
        }

        const judgeAssertion = components.find(
            c => c.reason && c.reason.includes('JUDGE_METRICS')
        );
        if (judgeAssertion) {
            const metrics = parseJudgeMetrics(judgeAssertion.reason);
            if (metrics) {
                const sonnetScore = metrics.sonnet_score;
                const gptScore = metrics.gpt_score;

                if (sonnetScore !== null && !isNaN(sonnetScore)) {
                    stats.judges.sonnet.scores.push(sonnetScore);
                    if (metrics.sonnet_coverage !== null) stats.judges.sonnet.coverage.push(metrics.sonnet_coverage);
                    if (metrics.sonnet_validity !== null) stats.judges.sonnet.validity.push(metrics.sonnet_validity);
                } else {
                    stats.judgeFailsSonnet++;
                }

                if (gptScore !== null && !isNaN(gptScore)) {
                    stats.judges.gpt.scores.push(gptScore);
                    if (metrics.gpt_coverage !== null) stats.judges.gpt.coverage.push(metrics.gpt_coverage);
                    if (metrics.gpt_validity !== null) stats.judges.gpt.validity.push(metrics.gpt_validity);
                } else {
                    stats.judgeFailsGpt++;
                }

                const s = sonnetScore !== null && !isNaN(sonnetScore) ? sonnetScore : 0;
                const g = gptScore !== null && !isNaN(gptScore) ? gptScore : 0;
                stats.combinedScores.push((s + g) / 2);
            }
        }

        const lineAssertions = components.filter(
            c => c.reason && c.reason.includes('LINE_METRICS')
        );
        for (const lineAssertion of lineAssertions) {
            const reason = lineAssertion.reason || '';
            const lineAccMatch = reason.match(/line_acc=([\d.]+)/);
            const avgIoUMatch = reason.match(/avg_iou=([\d.]+)/);
            const exactMatchMatch = reason.match(/exact_match=([\d.]+)/);
            const within3Match = reason.match(/within3=([\d.]+)/);

            if (lineAccMatch) stats.lineAccScores.push(parseFloat(lineAccMatch[1]));
            if (avgIoUMatch) stats.avgIoUScores.push(parseFloat(avgIoUMatch[1]));
            if (exactMatchMatch) stats.exactMatchScores.push(parseFloat(exactMatchMatch[1]));
            if (within3Match) stats.within3Scores.push(parseFloat(within3Match[1]));
        }
    });

    return modelStats;
}

// ─── Print results for a given modelStats ───

function printResults(modelStats, title, testCount) {
    const sorted = Object.entries(modelStats).sort((a, b) => {
        const aAvg = avg(a[1].combinedScores) || 0;
        const bAvg = avg(b[1].combinedScores) || 0;
        return bAvg - aAvg;
    });

    console.log(`\n═══ ${title} (${testCount} tests) ═══\n`);

    sorted.forEach(([model, stats], index) => {
        const totalTests = stats.tests;
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';

        const combinedAvg = avg(stats.combinedScores);
        const combinedPct = combinedAvg !== null ? (combinedAvg * 100).toFixed(1) : 'N/A';

        const sonnet = stats.judges.sonnet;
        const gpt = stats.judges.gpt;

        const sonnetCov = avg(sonnet.coverage);
        const gptCov = avg(gpt.coverage);
        const sonnetVal = avg(sonnet.validity);
        const gptVal = avg(gpt.validity);

        const covValues = [...sonnet.coverage, ...gpt.coverage];
        const valValues = [...sonnet.validity, ...gpt.validity];
        const combinedCov = avg(covValues);
        const combinedVal = avg(valValues);

        const passCount = stats.combinedScores.filter(s => s >= 0.7).length;

        const p50 = formatTime(percentile(stats.latencies, 50));
        const p95 = formatTime(percentile(stats.latencies, 95));

        const errorTotal = stats.apiErrors + stats.parseErrors;

        console.log(`${medal} ${shortName(model)}`);
        console.log(`   ├─ Score:     ${combinedPct}% (avg of 2 judges)`);
        const judgeFails = stats.judgeFailsSonnet + stats.judgeFailsGpt;
        if (errorTotal > 0 || judgeFails > 0) {
            const parts = [];
            if (stats.apiErrors > 0) parts.push(`${stats.apiErrors} API`);
            if (stats.parseErrors > 0) parts.push(`${stats.parseErrors} parse`);
            if (stats.judgeFailsSonnet > 0) parts.push(`${stats.judgeFailsSonnet} judge-sonnet`);
            if (stats.judgeFailsGpt > 0) parts.push(`${stats.judgeFailsGpt} judge-gpt`);
            console.log(`   ├─ Errors:    ${errorTotal + judgeFails}/${totalTests} (${parts.join(', ')})`);
        }
        console.log(`   ├─ Passed:    ${passCount}/${totalTests} (threshold 0.7)`);
        console.log(`   ├─ Coverage:  ${fmtPct(combinedCov)} (Sonnet: ${fmtPct(sonnetCov)} | GPT: ${fmtPct(gptCov)})`);
        console.log(`   ├─ Validity:  ${fmtPct(combinedVal)} (Sonnet: ${fmtPct(sonnetVal)} | GPT: ${fmtPct(gptVal)})`);

        const avgLineAcc = avg(stats.lineAccScores);
        const avgIoU = avg(stats.avgIoUScores);
        const avgExactMatch = avg(stats.exactMatchScores);
        const avgWithin3 = avg(stats.within3Scores);

        if (avgLineAcc !== null) {
            console.log(`   ├─ Line Acc:  ${(avgLineAcc * 100).toFixed(1)}%`);
            console.log(`   ├─ Avg IoU:   ${(avgIoU * 100).toFixed(1)}%`);
            console.log(`   ├─ Exact:     ${(avgExactMatch * 100).toFixed(1)}%`);
            console.log(`   ├─ Within 3:  ${(avgWithin3 * 100).toFixed(1)}%`);
        }

        console.log(`   └─ Latency:   p50=${p50}  p95=${p95}`);
        console.log('');
    });
}

// ─── Unique test count (per dataset, not per model) ───

const normalTestCount = new Set(normalResults.map(r => JSON.stringify(r.vars?.referenceBugs || ''))).size;
const crossfileTestCount = new Set(crossfileResults.map(r => JSON.stringify(r.vars?.referenceBugs || ''))).size;

// ─── Output ───

console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║   CODE REVIEW RESULTS — NORMAL vs CROSSFILE                  ║');
console.log('╚════════════════════════════════════════════════════════════════╝');

printResults(aggregateStats(normalResults), 'NORMAL', normalTestCount);
printResults(aggregateStats(crossfileResults), 'CROSSFILE', crossfileTestCount);

console.log('─────────────────────────────────────────────────────────────────');
console.log('Normal    = tests WITHOUT crossFileContext');
console.log('Crossfile = tests WITH crossFileContext');
console.log('Score     = avg(Judge Sonnet score, Judge GPT score)');
console.log('Coverage  = % of known bugs that were found');
console.log('Validity  = % of suggestions that are real bugs');
console.log('Line Acc  = avg IoU of lines (unfound bugs count as 0)');
console.log('Avg IoU   = avg IoU only for bugs the model found');
console.log('Exact     = % of lines exactly matching reference');
console.log('Within 3  = % with start/end diff <= 3 lines');
console.log('');
