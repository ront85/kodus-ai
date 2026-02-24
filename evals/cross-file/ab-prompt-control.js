/**
 * Control prompt — standard code review WITHOUT cross-file context.
 * Loads the same pre-generated prompt used by the main eval.
 */

const fs = require('fs');
const path = require('path');

const basePrompt = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, '../promptfoo/generated-prompt.json'),
        'utf8',
    ),
);

module.exports = function (_context) {
    return JSON.stringify(basePrompt);
};
