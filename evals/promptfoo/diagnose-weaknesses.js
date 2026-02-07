#!/usr/bin/env node

/**
 * Weakness diagnosis: identify weak cells and categorize failures.
 *
 * Reads the latest matrix JSON + raw output.json to produce a structured
 * diagnosis that can be used to decide next optimization steps.
 *
 * A cell is "weak" if:
 *   - combined_score < 60%  OR
 *   - combined_score < (mean - 1 standard deviation)
 *
 * Usage:
 *   node diagnose-weaknesses.js
 *   node diagnose-weaknesses.js results/matrix-2026-02-06.json results/output.json
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const matrixFile = process.argv[2] || path.join(__dirname, 'results', 'matrix-latest.json');
const outputFile = process.argv[3] || path.join(__dirname, 'results', 'output.json');

if (!fs.existsSync(matrixFile)) {
    console.error(`Matrix file not found: ${matrixFile}`);
    console.error('Run analyze-matrix.js first to generate it.');
    process.exit(1);
}
if (!fs.existsSync(outputFile)) {
    console.error(`Output file not found: ${outputFile}`);
    process.exit(1);
}

const matrix = JSON.parse(fs.readFileSync(matrixFile, 'utf-8'));
const rawData = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
const results = rawData.results.results;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function avg(arr) {
    const valid = arr.filter(v => v != null && !isNaN(v));
    if (valid.length === 0) return null;
    return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function stdev(arr) {
    const valid = arr.filter(v => v != null && !isNaN(v));
    if (valid.length < 2) return 0;
    const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
    const variance = valid.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (valid.length - 1);
    return Math.sqrt(variance);
}

function fmtPct(val) {
    if (val == null || isNaN(val)) return 'N/A';
    return (val * 100).toFixed(1) + '%';
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

function getLanguage(result) {
    if (result.testCase?.vars?.language) return result.testCase.vars.language;
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
// Identify weak cells
// ---------------------------------------------------------------------------
const scores = matrix.cells
    .map(c => c.combined_score)
    .filter(v => v != null && !isNaN(v));

const meanScore = avg(scores);
const stdevScore = stdev(scores);
const dynamicThreshold = meanScore - stdevScore;
const absoluteThreshold = 0.6;
const weakThreshold = Math.max(absoluteThreshold, dynamicThreshold);

console.log('\n' + '='.repeat(70));
console.log('  WEAKNESS DIAGNOSIS');
console.log('='.repeat(70));
console.log(`  Mean score:       ${fmtPct(meanScore)}`);
console.log(`  Stdev:            ${(stdevScore * 100).toFixed(1)}pp`);
console.log(`  Dynamic cutoff:   ${fmtPct(dynamicThreshold)} (mean - 1σ)`);
console.log(`  Absolute cutoff:  ${fmtPct(absoluteThreshold)}`);
console.log(`  Effective cutoff: ${fmtPct(weakThreshold)}`);
console.log('');

const weakCells = matrix.cells.filter(c => {
    if (c.combined_score == null) return true;
    return c.combined_score < weakThreshold;
});

if (weakCells.length === 0) {
    console.log('  No weak cells found! All cells are above the threshold.');
    console.log('');
    process.exit(0);
}

console.log(`  Found ${weakCells.length} weak cell(s):\n`);

// ---------------------------------------------------------------------------
// For each weak cell, analyze raw results
// ---------------------------------------------------------------------------
const diagnosis = [];

for (const cell of weakCells) {
    const label = `${shortModelName(cell.model)} / ${cell.language}`;
    console.log('─'.repeat(70));
    console.log(`  ${label} — combined: ${fmtPct(cell.combined_score)} | coverage: ${fmtPct(cell.coverage)} | validity: ${fmtPct(cell.validity)}`);
    console.log(`  tests: ${cell.tests} | parse_errors: ${cell.parse_errors} | api_errors: ${cell.api_errors} | judge_fails: ${cell.judge_fails}`);

    // Find matching raw results
    const cellResults = results.filter(r => {
        const model = r.provider?.id || r.provider || '';
        const lang = getLanguage(r);
        return model === cell.model && lang === cell.language;
    });

    // Categorize failures
    const categories = {
        parse_error: [],
        api_error: [],
        low_coverage: [],
        low_validity: [],
        judge_fail: [],
    };

    for (const r of cellResults) {
        const components = r.gradingResult?.componentResults || [];
        const desc = r.testCase?.description || 'unknown';

        // API error
        const isApiError = r.error && (
            r.error.includes('API error') ||
            r.error.includes('timeout') ||
            r.error.includes('ECONNREFUSED') ||
            (r.response?.output || '').length === 0
        );
        if (isApiError) {
            categories.api_error.push({ desc, error: r.error });
            continue;
        }

        // Parse error
        const parseAssertion = components.find(
            c => (c.reason || '').includes('PARSE_FAIL')
        );
        if (parseAssertion && !parseAssertion.pass) {
            categories.parse_error.push({ desc, reason: parseAssertion.reason });
            continue;
        }

        // Judge metrics
        const judgeAssertion = components.find(c => c.reason && c.reason.includes('JUDGE_METRICS'));
        if (!judgeAssertion) {
            categories.judge_fail.push({ desc, reason: 'No JUDGE_METRICS found in result' });
            continue;
        }

        const metricsMatch = judgeAssertion.reason.match(/JUDGE_METRICS\s+(.+)/);
        if (!metricsMatch) continue;

        const pairs = metricsMatch[1].split(/\s+/);
        const metrics = {};
        for (const pair of pairs) {
            const [key, val] = pair.split('=');
            if (key && val) metrics[key] = val === 'null' ? null : parseFloat(val);
        }

        // Extract judge reasoning (everything after JUDGE_METRICS line)
        const reasonParts = judgeAssertion.reason.split('\n');
        const judgeReasoning = reasonParts.slice(1).join('\n').trim();

        // Check coverage
        const covValues = [metrics.sonnet_coverage, metrics.gpt_coverage].filter(v => v != null && !isNaN(v));
        const avgCov = covValues.length > 0 ? covValues.reduce((a, b) => a + b, 0) / covValues.length : null;

        // Check validity
        const valValues = [metrics.sonnet_validity, metrics.gpt_validity].filter(v => v != null && !isNaN(v));
        const avgVal = valValues.length > 0 ? valValues.reduce((a, b) => a + b, 0) / valValues.length : null;

        if (avgCov != null && avgCov < 0.7) {
            categories.low_coverage.push({
                desc,
                coverage: avgCov,
                reasoning: judgeReasoning.slice(0, 500),
            });
        }

        if (avgVal != null && avgVal < 0.7) {
            categories.low_validity.push({
                desc,
                validity: avgVal,
                reasoning: judgeReasoning.slice(0, 500),
            });
        }
    }

    // Print category breakdown
    const totalFailures = Object.values(categories).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`\n  Failure breakdown (${totalFailures} issues):`);

    if (categories.parse_error.length > 0) {
        console.log(`    Parse errors (${categories.parse_error.length}):`);
        for (const f of categories.parse_error) {
            console.log(`      - ${f.desc}: ${f.reason}`);
        }
    }

    if (categories.api_error.length > 0) {
        console.log(`    API errors (${categories.api_error.length}):`);
        for (const f of categories.api_error) {
            console.log(`      - ${f.desc}: ${(f.error || '').slice(0, 100)}`);
        }
    }

    if (categories.low_coverage.length > 0) {
        console.log(`    Low coverage (${categories.low_coverage.length}):`);
        for (const f of categories.low_coverage) {
            console.log(`      - ${f.desc}: coverage=${fmtPct(f.coverage)}`);
            if (f.reasoning) {
                const lines = f.reasoning.split('\n').slice(0, 5);
                for (const line of lines) {
                    console.log(`          ${line}`);
                }
            }
        }
    }

    if (categories.low_validity.length > 0) {
        console.log(`    Low validity (${categories.low_validity.length}):`);
        for (const f of categories.low_validity) {
            console.log(`      - ${f.desc}: validity=${fmtPct(f.validity)}`);
            if (f.reasoning) {
                const lines = f.reasoning.split('\n').slice(0, 5);
                for (const line of lines) {
                    console.log(`          ${line}`);
                }
            }
        }
    }

    if (categories.judge_fail.length > 0) {
        console.log(`    Judge failures (${categories.judge_fail.length}):`);
        for (const f of categories.judge_fail) {
            console.log(`      - ${f.desc}: ${f.reason}`);
        }
    }

    diagnosis.push({
        model: cell.model,
        language: cell.language,
        combined_score: cell.combined_score,
        categories: {
            parse_error: categories.parse_error.length,
            api_error: categories.api_error.length,
            low_coverage: categories.low_coverage.length,
            low_validity: categories.low_validity.length,
            judge_fail: categories.judge_fail.length,
        },
        details: categories,
    });

    console.log('');
}

// ---------------------------------------------------------------------------
// Pattern analysis: model-wide vs language-wide problems
// ---------------------------------------------------------------------------
console.log('─'.repeat(70));
console.log('  PATTERN ANALYSIS');
console.log('─'.repeat(70));

// Check for model-wide weakness (model weak across all languages)
const weakByModel = {};
for (const cell of weakCells) {
    if (!weakByModel[cell.model]) weakByModel[cell.model] = [];
    weakByModel[cell.model].push(cell.language);
}

const allLanguages = matrix.languages;
for (const [model, langs] of Object.entries(weakByModel)) {
    if (langs.length >= allLanguages.length * 0.75) {
        console.log(`  MODEL-WIDE: ${shortModelName(model)} is weak in ${langs.length}/${allLanguages.length} languages → likely a format/instruction issue`);
    }
}

// Check for language-wide weakness (language weak across all models)
const weakByLang = {};
for (const cell of weakCells) {
    if (!weakByLang[cell.language]) weakByLang[cell.language] = [];
    weakByLang[cell.language].push(cell.model);
}

const allModels = matrix.models;
for (const [lang, models] of Object.entries(weakByLang)) {
    if (models.length >= allModels.length * 0.75) {
        console.log(`  LANG-WIDE:  ${lang} is weak across ${models.length}/${allModels.length} models → likely needs language-specific hints`);
    }
}

// Check for parse error pattern
const parseHeavy = weakCells.filter(c => c.parse_errors > c.tests * 0.3);
if (parseHeavy.length > 0) {
    console.log(`  PARSE-HEAVY: ${parseHeavy.length} cell(s) have >30% parse errors:`);
    for (const c of parseHeavy) {
        console.log(`    - ${shortModelName(c.model)} / ${c.language}: ${c.parse_errors}/${c.tests} parse errors`);
    }
}

console.log('');

// ---------------------------------------------------------------------------
// Save JSON diagnosis
// ---------------------------------------------------------------------------
const diagnosisOutput = {
    generated: new Date().toISOString(),
    threshold: weakThreshold,
    stats: { mean: meanScore, stdev: stdevScore },
    weakCells: diagnosis,
    patterns: {
        modelWide: Object.entries(weakByModel)
            .filter(([, langs]) => langs.length >= allLanguages.length * 0.75)
            .map(([model, langs]) => ({ model, languages: langs })),
        languageWide: Object.entries(weakByLang)
            .filter(([, models]) => models.length >= allModels.length * 0.75)
            .map(([lang, models]) => ({ language: lang, models })),
    },
};

const diagPath = path.join(__dirname, 'results', 'diagnosis-latest.json');
fs.writeFileSync(diagPath, JSON.stringify(diagnosisOutput, null, 2));
console.log(`Diagnosis saved to ${diagPath}`);
