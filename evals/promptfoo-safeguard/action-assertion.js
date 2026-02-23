/**
 * Code-based action accuracy assertion for safeguard eval.
 * Compares the model's action (no_changes/update/discard) with expected action per suggestion ID.
 * No LLM call — pure string comparison.
 */

const { processResponse } = require('./parse-output');

module.exports = (output, context) => {
    const parsed = processResponse(output);
    if (!parsed) {
        return {
            pass: false,
            score: 0,
            reason: 'ACTION_SKIP: Could not parse model output',
        };
    }

    const suggestions = parsed.codeSuggestions;
    const expectedActions = JSON.parse(context.vars.expectedActions || '[]');

    // Build lookup: id -> expected action
    const expectedMap = {};
    for (const ea of expectedActions) {
        expectedMap[ea.id] = ea.action;
    }

    let correct = 0;
    let total = 0;
    const details = [];

    for (const suggestion of suggestions) {
        const expected = expectedMap[suggestion.id];
        if (!expected) continue;

        total++;
        const isCorrect = suggestion.action === expected;
        if (isCorrect) correct++;

        details.push(`  ${suggestion.id}: ${isCorrect ? 'OK' : 'WRONG'} (expected=${expected}, got=${suggestion.action})`);
    }

    if (total === 0) {
        return {
            pass: false,
            score: 0,
            reason: 'ACTION_FAIL: No matching suggestion IDs found',
        };
    }

    const accuracy = correct / total;
    const reason = `ACTION_METRICS action_accuracy=${accuracy.toFixed(4)} correct=${correct} total=${total}\n${details.join('\n')}`;

    return {
        pass: accuracy >= 0.7,
        score: accuracy,
        reason,
    };
};
