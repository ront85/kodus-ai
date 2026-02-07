#!/usr/bin/env node

/**
 * Baseline comparison: diff two matrix JSONs cell-by-cell.
 *
 * Usage:
 *   node compare-baselines.js results/matrix-baseline.json results/matrix-current.json
 *   node compare-baselines.js --threshold=5 results/matrix-baseline.json results/matrix-current.json
 *
 * Exit code:
 *   0  all cells within threshold
 *   1  at least one cell regressed beyond threshold
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let threshold = 3; // default regression threshold in percentage points

const positional = [];
for (const arg of args) {
    if (arg.startsWith('--threshold=')) {
        threshold = parseFloat(arg.split('=')[1]);
    } else {
        positional.push(arg);
    }
}

if (positional.length !== 2) {
    console.error('Usage: node compare-baselines.js [--threshold=N] <baseline.json> <current.json>');
    process.exit(2);
}

const [baselineFile, currentFile] = positional;

if (!fs.existsSync(baselineFile)) {
    console.error(`Baseline file not found: ${baselineFile}`);
    process.exit(2);
}
if (!fs.existsSync(currentFile)) {
    console.error(`Current file not found: ${currentFile}`);
    process.exit(2);
}

const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
const current = JSON.parse(fs.readFileSync(currentFile, 'utf-8'));

// ---------------------------------------------------------------------------
// Build lookup: key -> cell summary
// ---------------------------------------------------------------------------
function buildLookup(matrixData) {
    const lookup = {};
    for (const cell of matrixData.cells) {
        lookup[`${cell.model}|||${cell.language}`] = cell;
    }
    return lookup;
}

const baseLookup = buildLookup(baseline);
const currLookup = buildLookup(current);

// Collect all keys from both
const allKeys = new Set([...Object.keys(baseLookup), ...Object.keys(currLookup)]);

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------
const improvements = [];
const regressions = [];
const withinNoise = [];
const newCells = [];
const removedCells = [];

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

for (const key of allKeys) {
    const [model, language] = key.split('|||');
    const label = `${shortModelName(model)} / ${language}`;
    const baseCell = baseLookup[key];
    const currCell = currLookup[key];

    if (!baseCell) {
        newCells.push({ label, model, language, current: currCell.combined_score });
        continue;
    }
    if (!currCell) {
        removedCells.push({ label, model, language, baseline: baseCell.combined_score });
        continue;
    }

    const baseScore = baseCell.combined_score;
    const currScore = currCell.combined_score;

    if (baseScore == null || currScore == null) {
        withinNoise.push({ label, model, language, baseline: baseScore, current: currScore, diff: null });
        continue;
    }

    const diffPct = (currScore - baseScore) * 100; // in percentage points

    const entry = {
        label,
        model,
        language,
        baseline: baseScore,
        current: currScore,
        diff: diffPct,
        diffStr: (diffPct >= 0 ? '+' : '') + diffPct.toFixed(1) + 'pp',
    };

    if (diffPct < -threshold) {
        regressions.push(entry);
    } else if (diffPct > threshold) {
        improvements.push(entry);
    } else {
        withinNoise.push(entry);
    }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(60));
console.log('  BASELINE COMPARISON');
console.log('  Threshold: ' + threshold + 'pp');
console.log('  Baseline: ' + path.basename(baselineFile));
console.log('  Current:  ' + path.basename(currentFile));
console.log('='.repeat(60));

// Overall
const baseOverall = baseline.overall?.combined_score;
const currOverall = current.overall?.combined_score;
if (baseOverall != null && currOverall != null) {
    const overallDiff = (currOverall - baseOverall) * 100;
    const arrow = overallDiff > 0 ? '↑' : overallDiff < 0 ? '↓' : '→';
    console.log(`\n  Overall: ${fmtPct(baseOverall)} → ${fmtPct(currOverall)} (${arrow} ${overallDiff >= 0 ? '+' : ''}${overallDiff.toFixed(1)}pp)`);
}

if (improvements.length > 0) {
    console.log(`\n  IMPROVEMENTS (${improvements.length}):`);
    improvements.sort((a, b) => b.diff - a.diff);
    for (const e of improvements) {
        console.log(`    ✓ ${e.label}: ${fmtPct(e.baseline)} → ${fmtPct(e.current)} (${e.diffStr})`);
    }
}

if (regressions.length > 0) {
    console.log(`\n  REGRESSIONS (${regressions.length}):`);
    regressions.sort((a, b) => a.diff - b.diff);
    for (const e of regressions) {
        console.log(`    ✗ ${e.label}: ${fmtPct(e.baseline)} → ${fmtPct(e.current)} (${e.diffStr})`);
    }
}

if (withinNoise.length > 0) {
    console.log(`\n  WITHIN NOISE (${withinNoise.length}):`);
    for (const e of withinNoise) {
        const diffStr = e.diff != null ? ((e.diff >= 0 ? '+' : '') + e.diff.toFixed(1) + 'pp') : 'N/A';
        console.log(`    ~ ${e.label}: ${fmtPct(e.baseline)} → ${fmtPct(e.current)} (${diffStr})`);
    }
}

if (newCells.length > 0) {
    console.log(`\n  NEW CELLS (${newCells.length}):`);
    for (const e of newCells) {
        console.log(`    + ${e.label}: ${fmtPct(e.current)}`);
    }
}

if (removedCells.length > 0) {
    console.log(`\n  REMOVED CELLS (${removedCells.length}):`);
    for (const e of removedCells) {
        console.log(`    - ${e.label}: was ${fmtPct(e.baseline)}`);
    }
}

console.log('');

// ---------------------------------------------------------------------------
// Exit code
// ---------------------------------------------------------------------------
if (regressions.length > 0) {
    console.log(`FAIL: ${regressions.length} cell(s) regressed beyond ${threshold}pp threshold.`);
    process.exit(1);
} else {
    console.log(`PASS: No regressions beyond ${threshold}pp threshold.`);
    process.exit(0);
}
