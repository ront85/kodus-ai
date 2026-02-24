/**
 * Parse assertion for safeguard eval.
 * Validates that the model output is parseable and conforms to the safeguard schema:
 * - Contains codeSuggestions array
 * - Each item has id, action (no_changes|update|discard), reason
 * - For update: modified fields present
 */

const { processResponse, validateSchema } = require('./parse-output');

module.exports = (output, context) => {
    // Step 1: Parse the raw output
    const parsed = processResponse(output);

    if (!parsed) {
        return {
            pass: false,
            score: 0,
            reason: 'PARSE_FAIL: Could not parse safeguard output as JSON',
        };
    }

    const suggestions = parsed.codeSuggestions;

    if (!suggestions || suggestions.length === 0) {
        return {
            pass: false,
            score: 0,
            reason: 'PARSE_FAIL: Missing or empty codeSuggestions array',
        };
    }

    // Step 2: Validate schema
    const { valid, errors } = validateSchema(suggestions);

    if (!valid) {
        return {
            pass: false,
            score: 0.3,
            reason: `SCHEMA_FAIL: ${errors.join('; ')}`,
        };
    }

    // Step 3: Check that all input suggestion IDs are present in output
    const expectedIds = JSON.parse(context.vars.expectedSuggestionIds || '[]');
    const outputIds = new Set(suggestions.map(s => s.id));
    const missingIds = expectedIds.filter(id => !outputIds.has(id));

    if (missingIds.length > 0) {
        return {
            pass: false,
            score: 0.5,
            reason: `COMPLETENESS_FAIL: Missing suggestions for IDs: ${missingIds.join(', ')}`,
        };
    }

    // Step 4: Check action distribution makes sense
    const actions = suggestions.map(s => s.action);
    const actionCounts = {
        no_changes: actions.filter(a => a === 'no_changes').length,
        update: actions.filter(a => a === 'update').length,
        discard: actions.filter(a => a === 'discard').length,
    };

    return {
        pass: true,
        score: 1.0,
        reason: `PARSE_OK: ${suggestions.length} suggestions parsed. Actions: ${actionCounts.no_changes} no_changes, ${actionCounts.update} update, ${actionCounts.discard} discard`,
    };
};
