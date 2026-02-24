/**
 * Custom LLM judge assertion for safeguard eval.
 * Evaluates whether the model made correct action decisions (no_changes/update/discard)
 * and provided quality reasoning.
 *
 * Calls Sonnet + GPT APIs directly (same pattern as analyze eval).
 *
 * Metrics:
 * - action_accuracy: % of suggestions with correct action
 * - reason_quality: LLM judge evaluates reason specificity and factual grounding
 * - final_score: (action_accuracy * 0.6) + (reason_quality * 0.4)
 */

const { processResponse } = require('./parse-output');

// Call Anthropic Claude Sonnet API
async function callSonnet(prompt) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 8192,
            temperature: 0,
        }),
        signal: AbortSignal.timeout(180000),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Anthropic API ${resp.status}: ${text.slice(0, 300)}`);
    }

    const data = await resp.json();
    return data.content?.[0]?.text || '';
}

// Call OpenAI GPT API
async function callGPT(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: 'gpt-5.2',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
        }),
        signal: AbortSignal.timeout(180000),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`OpenAI API ${resp.status}: ${text.slice(0, 300)}`);
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
}

// Extract scores from judge response
function extractScores(text) {
    const lines = text.split('\n');
    let action_accuracy = null, reason_quality = null, final_score = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.includes('=')) continue;

        const lower = trimmed.toLowerCase();
        const parts = trimmed.split('=');
        const lastPart = parts[parts.length - 1].trim();
        const match = lastPart.match(/^([\d.]+)/);
        if (!match) continue;
        const value = Math.min(parseFloat(match[1]), 1.0);
        if (isNaN(value)) continue;

        if (/^action[_ ]?accuracy/i.test(lower)) {
            action_accuracy = value;
        } else if (/^reason[_ ]?quality/i.test(lower)) {
            reason_quality = value;
        } else if (/^final[_ ]?score/i.test(lower)) {
            final_score = value;
        }
    }

    return { action_accuracy, reason_quality, final_score };
}

function buildJudgePrompt(inputSuggestions, modelOutput, expectedActions, fileContent, codeDiff) {
    return `You are a strict judge evaluating a code review SAFEGUARD system. The safeguard receives AI-generated code suggestions and must decide for each one: keep it as-is (no_changes), fix it (update), or remove it (discard).

## Input suggestions given to the safeguard:
${inputSuggestions}

## Expected actions (ground truth):
${expectedActions}

## Model's actual output:
${modelOutput}

## File content (for verification):
${fileContent?.slice(0, 3000) || 'N/A'}

## Code diff (for verification):
${codeDiff?.slice(0, 3000) || 'N/A'}

## Evaluation Steps

### Step 1: Action Accuracy
For EACH suggestion, compare the model's action with the expected action:

#### Suggestion [id]: [summary]
- Expected action: [no_changes|update|discard]
- Model's action: [no_changes|update|discard]
- Correct: YES/NO
- Analysis: [brief explanation]

Count correct actions vs total suggestions.
action_accuracy = correct_count / total_suggestions

### Step 2: Reason Quality
For EACH suggestion, evaluate the model's "reason" field:

#### Suggestion [id]: Reason evaluation
- Is the reason **specific** (references actual code, line numbers, or concrete details)? YES/NO
- Is the reason **factual** (claims can be verified against the file content and diff)? YES/NO
- Is the reason **evidence-based** (cites FileContentContext or CodeDiffContext)? YES/NO
- Does the reason avoid generic/vague language ("could cause issues", "might fail")? YES/NO
- Quality: HIGH (3-4 yes) / MEDIUM (2 yes) / LOW (0-1 yes)

Score each reason:
- HIGH = 1.0
- MEDIUM = 0.5
- LOW = 0.0

reason_quality = average of all reason scores

### Step 3: Final Score
final_score = (action_accuracy * 0.6) + (reason_quality * 0.4)

You MUST end your response with EXACTLY these three lines (no other text after them):
action_accuracy = X/Y = Z
reason_quality = A/B = W
final_score = Z * 0.6 + W * 0.4 = SCORE`;
}

module.exports = async (output, context) => {
    const expectedActions = context.vars.expectedActions || '[]';
    const inputSuggestions = context.vars.suggestionsContext || '[]';
    const fileContent = context.vars.fileContent || '';
    const codeDiff = context.vars.patchWithLinesStr || '';

    // Parse the model output to check if it's valid
    const parsed = processResponse(output);
    if (!parsed) {
        return {
            pass: false,
            score: 0,
            reason: 'JUDGE_SKIP: Could not parse model output',
        };
    }

    const evalPrompt = buildJudgePrompt(
        inputSuggestions,
        output,
        expectedActions,
        fileContent,
        codeDiff,
    );

    // Call both judges in parallel
    const [sonnetResult, gptResult] = await Promise.allSettled([
        callSonnet(evalPrompt),
        callGPT(evalPrompt),
    ]);

    let sonnetScores = { action_accuracy: null, reason_quality: null, final_score: null };
    let gptScores = { action_accuracy: null, reason_quality: null, final_score: null };
    let sonnetReason = '';
    let gptReason = '';

    if (sonnetResult.status === 'fulfilled') {
        sonnetReason = sonnetResult.value;
        sonnetScores = extractScores(sonnetReason);
    } else {
        sonnetReason = 'JUDGE_ERROR: ' + sonnetResult.reason.message;
    }

    if (gptResult.status === 'fulfilled') {
        gptReason = gptResult.value;
        gptScores = extractScores(gptReason);
    } else {
        gptReason = 'JUDGE_ERROR: ' + gptResult.reason.message;
    }

    // Combined score (missing/NaN judge = 0 to prevent inflation)
    const sScore = sonnetScores.final_score !== null && !isNaN(sonnetScores.final_score) ? sonnetScores.final_score : 0;
    const gScore = gptScores.final_score !== null && !isNaN(gptScores.final_score) ? gptScores.final_score : 0;
    const combined = (sScore + gScore) / 2;

    // Build structured reason for analyze-results.js
    const fmt = v => v !== null && !isNaN(v) ? v.toFixed(4) : 'null';
    const metrics = `JUDGE_METRICS sonnet_score=${fmt(sonnetScores.final_score)} gpt_score=${fmt(gptScores.final_score)} sonnet_action_acc=${fmt(sonnetScores.action_accuracy)} sonnet_reason_qual=${fmt(sonnetScores.reason_quality)} gpt_action_acc=${fmt(gptScores.action_accuracy)} gpt_reason_qual=${fmt(gptScores.reason_quality)}`;

    const reason = `${metrics}\n\n--- SONNET JUDGE ---\n${sonnetReason.slice(-1000)}\n\n--- GPT JUDGE ---\n${gptReason.slice(-1000)}`;

    return {
        pass: combined >= 0.7,
        score: combined,
        reason,
    };
};
