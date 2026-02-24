#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { loadResults } = require('./load-results');
const { results } = loadResults();
if (results.length === 0) { console.error('No result files found.'); process.exit(1); }
const testDataset = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', 'codereview-tests.json'), 'utf-8'));

// ─── Step 1: Build bug registry from dataset ───
// Each bug gets a unique ID: "testIdx:bugIdx"
const bugRegistry = [];
testDataset.forEach((test, testIdx) => {
    const bugs = JSON.parse(test.vars.referenceBugs || '[]');
    bugs.forEach((bug, bugIdx) => {
        bugRegistry.push({
            id: `${testIdx}:${bugIdx}`,
            testIdx,
            bugIdx,
            file: bug.relevantFile,
            linesStart: bug.relevantLinesStart,
            linesEnd: bug.relevantLinesEnd,
            testDesc: test.description || `Test ${testIdx}`,
        });
    });
});

// ─── Step 2: Extract FOUND/MISSED per bug per model from judge text ───
// bugFindings[bugId][model] = true/false
const bugFindings = {};
bugRegistry.forEach(b => { bugFindings[b.id] = {}; });

const modelNames = new Set();

// Group results by test index — promptfoo runs tests in order across all providers
// Each test in the dataset maps to N results (one per provider)
const resultsByTest = {};
results.forEach(r => {
    const provider = r.provider.id || r.provider;
    modelNames.add(provider);

    // Find which test this result belongs to by matching vars
    const testIdx = testDataset.findIndex(t => t.vars.fileContent === r.vars?.fileContent);
    if (testIdx < 0) return;

    if (!resultsByTest[testIdx]) resultsByTest[testIdx] = {};
    resultsByTest[testIdx][provider] = r;
});

const models = [...modelNames].sort();

// Parse FOUND/MISSED from judge text
function extractFoundMissed(judgeText, numBugs) {
    // Returns array of booleans, one per reference bug
    // Look for patterns like: "FOUND", "MISSED", "**FOUND**", "— FOUND", "- FOUND"
    const found = new Array(numBugs).fill(null);

    // Strategy: find the coverage section and extract FOUND/MISSED in order
    // Both judges list reference issues sequentially with FOUND or MISSED
    const lines = judgeText.split('\n');
    let bugCount = 0;

    for (const line of lines) {
        if (bugCount >= numBugs) break;

        const upper = line.toUpperCase();
        // Look for lines that contain FOUND or MISSED as a verdict
        // Must contain a reference issue indicator (number, "reference issue", "issue", etc.)
        const hasFound = /\bFOUND\b/.test(upper) && !/\bMISSED\b/.test(upper);
        const hasMissed = /\bMISSED\b/.test(upper);

        if (hasFound || hasMissed) {
            // Check if this line references a bug number
            const numMatch = line.match(/(?:^|\b)(\d+)[.\):\s]/);
            const issueRef = line.match(/(?:reference\s+)?issue\s+(\d+)/i);
            const idx = issueRef ? parseInt(issueRef[1]) - 1
                : numMatch ? parseInt(numMatch[1]) - 1
                : bugCount;

            if (idx >= 0 && idx < numBugs && found[idx] === null) {
                found[idx] = hasFound;
                bugCount++;
            } else if (found[bugCount] === null) {
                found[bugCount] = hasFound;
                bugCount++;
            }
        }
    }

    return found;
}

// Process each test × model
for (const [testIdxStr, modelResults] of Object.entries(resultsByTest)) {
    const testIdx = parseInt(testIdxStr);
    const testBugs = bugRegistry.filter(b => b.testIdx === testIdx);
    if (testBugs.length === 0) continue;

    for (const [model, result] of Object.entries(modelResults)) {
        const components = result.gradingResult?.componentResults || [];
        const judge = components.find(c => c.reason && c.reason.includes('JUDGE_METRICS'));
        if (!judge) continue;

        // Try both Sonnet and GPT sections — use consensus (either says FOUND = found)
        const sonnetMatch = judge.reason.match(/--- SONNET JUDGE ---\n([\s\S]*?)(?=--- GPT JUDGE ---|$)/);
        const gptMatch = judge.reason.match(/--- GPT JUDGE ---\n([\s\S]*?)$/);

        const sonnetFound = sonnetMatch ? extractFoundMissed(sonnetMatch[1], testBugs.length) : new Array(testBugs.length).fill(null);
        const gptFound = gptMatch ? extractFoundMissed(gptMatch[1], testBugs.length) : new Array(testBugs.length).fill(null);

        testBugs.forEach((bug, i) => {
            // A bug is "found" if either judge says FOUND
            const s = sonnetFound[i];
            const g = gptFound[i];
            if (s === true || g === true) {
                bugFindings[bug.id][model] = true;
            } else if (s === false || g === false) {
                bugFindings[bug.id][model] = false;
            }
            // null = couldn't determine (parse error, API error, etc.)
        });
    }
}

// ─── Step 3: Classify difficulty ───
bugRegistry.forEach(bug => {
    const findings = bugFindings[bug.id];
    let found = 0, total = 0;
    for (const model of models) {
        if (findings[model] === true || findings[model] === false) {
            total++;
            if (findings[model]) found++;
        }
    }
    bug.findRate = total > 0 ? found / total : 0;
    bug.foundBy = found;
    bug.totalModels = total;
    bug.difficulty = bug.findRate > 0.7 ? 'easy' : bug.findRate >= 0.3 ? 'medium' : 'hard';
});

const easy = bugRegistry.filter(b => b.difficulty === 'easy');
const medium = bugRegistry.filter(b => b.difficulty === 'medium');
const hard = bugRegistry.filter(b => b.difficulty === 'hard');

// ─── Step 4: Per-model breakdown by difficulty ───
function modelDifficultyStats(model, bugs) {
    let found = 0, total = 0;
    for (const bug of bugs) {
        if (bugFindings[bug.id][model] === true || bugFindings[bug.id][model] === false) {
            total++;
            if (bugFindings[bug.id][model]) found++;
        }
    }
    return { found, total };
}

// ─── Step 5: Head-to-head Kimi vs GPT ───
const kimiModel = models.find(m => m.includes('kimi'));
const gptModel = models.find(m => m.includes('gpt'));

let kimiWins = 0, gptWins = 0, ties = 0;
let kimiAdvEasy = 0, kimiAdvMedium = 0, kimiAdvHard = 0;

if (kimiModel && gptModel) {
    // Per-test comparison
    const testIndices = [...new Set(bugRegistry.map(b => b.testIdx))];
    for (const testIdx of testIndices) {
        const testBugs = bugRegistry.filter(b => b.testIdx === testIdx);
        let kimiFound = 0, gptFound = 0;
        for (const bug of testBugs) {
            if (bugFindings[bug.id][kimiModel]) kimiFound++;
            if (bugFindings[bug.id][gptModel]) gptFound++;
        }
        if (kimiFound > gptFound) kimiWins++;
        else if (gptFound > kimiFound) gptWins++;
        else ties++;
    }

    // Advantage by difficulty
    for (const bug of bugRegistry) {
        const kimiF = bugFindings[bug.id][kimiModel] ? 1 : 0;
        const gptF = bugFindings[bug.id][gptModel] ? 1 : 0;
        const diff = kimiF - gptF;
        if (bug.difficulty === 'easy') kimiAdvEasy += diff;
        else if (bug.difficulty === 'medium') kimiAdvMedium += diff;
        else kimiAdvHard += diff;
    }
}

// ─── Output ───

// Shorten model name
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

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║          BUG DIFFICULTY ANALYSIS                 ║');
console.log('╚══════════════════════════════════════════════════╝\n');

console.log('Dataset Overview:');
console.log(`  Total bugs: ${bugRegistry.length}`);
console.log(`  Easy (>70% models find):   ${easy.length} (${(easy.length / bugRegistry.length * 100).toFixed(0)}%)`);
console.log(`  Medium (30-70%):           ${medium.length} (${(medium.length / bugRegistry.length * 100).toFixed(0)}%)`);
console.log(`  Hard (<30%):               ${hard.length} (${(hard.length / bugRegistry.length * 100).toFixed(0)}%)`);

console.log('\n─── Per-model breakdown by difficulty ───\n');

// Header
const nameWidth = 22;
const colWidth = 13;
console.log('Model'.padEnd(nameWidth) + '│ Easy (' + easy.length + ')'.padEnd(colWidth) + '│ Medium (' + medium.length + ')'.padEnd(colWidth) + '│ Hard (' + hard.length + ')'.padEnd(colWidth) + '│ Total');
console.log('─'.repeat(nameWidth) + '┼' + '─'.repeat(colWidth) + '┼' + '─'.repeat(colWidth) + '┼' + '─'.repeat(colWidth) + '┤');

// Sort models by total found rate
const modelTotalFound = models.map(m => {
    const stats = modelDifficultyStats(m, bugRegistry);
    return { model: m, rate: stats.total > 0 ? stats.found / stats.total : 0 };
}).sort((a, b) => b.rate - a.rate);

for (const { model } of modelTotalFound) {
    const eStats = modelDifficultyStats(model, easy);
    const mStats = modelDifficultyStats(model, medium);
    const hStats = modelDifficultyStats(model, hard);
    const tStats = modelDifficultyStats(model, bugRegistry);

    const fmtCol = (s) => {
        if (s.total === 0) return 'N/A'.padEnd(colWidth);
        return `${s.found}/${s.total} ${(s.found / s.total * 100).toFixed(0)}%`.padEnd(colWidth);
    };

    console.log(
        shortName(model).padEnd(nameWidth) + '│ ' +
        fmtCol(eStats) + '│ ' +
        fmtCol(mStats) + '│ ' +
        fmtCol(hStats) + '│ ' +
        (tStats.total > 0 ? (tStats.found / tStats.total * 100).toFixed(0) + '%' : 'N/A')
    );
}

if (kimiModel && gptModel) {
    console.log('\n─── Head-to-head: ' + shortName(kimiModel) + ' vs ' + shortName(gptModel) + ' ───\n');
    console.log(`Tests where ${shortName(kimiModel)} wins (higher coverage):  ${kimiWins}`);
    console.log(`Tests where ${shortName(gptModel)} wins:                     ${gptWins}`);
    console.log(`Tests tied:                                ${ties}`);
    console.log('');
    console.log(`${shortName(kimiModel)} advantage comes from:`);
    console.log(`  Easy bugs:    ${kimiAdvEasy >= 0 ? '+' : ''}${kimiAdvEasy} more found`);
    console.log(`  Medium bugs:  ${kimiAdvMedium >= 0 ? '+' : ''}${kimiAdvMedium} more found`);
    console.log(`  Hard bugs:    ${kimiAdvHard >= 0 ? '+' : ''}${kimiAdvHard} more found`);
}

// Hardest bugs
console.log('\n─── Hardest bugs (found by <2 models) ───\n');
const hardest = bugRegistry.filter(b => b.foundBy <= 1).sort((a, b) => a.foundBy - b.foundBy);
if (hardest.length === 0) {
    console.log('No bugs found by fewer than 2 models.');
} else {
    for (const bug of hardest.slice(0, 15)) {
        const foundByModels = models.filter(m => bugFindings[bug.id][m] === true).map(shortName);
        console.log(`${bug.testDesc.slice(0, 55)}, bug ${bug.bugIdx + 1}:`);
        console.log(`  Lines ${bug.linesStart}-${bug.linesEnd} | Found by: ${foundByModels.length > 0 ? foundByModels.join(', ') : '(none)'}`);
    }
}

console.log('');
