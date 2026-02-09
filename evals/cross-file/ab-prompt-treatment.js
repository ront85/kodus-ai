/**
 * Treatment prompt — code review WITH cross-file context injected.
 *
 * Takes the base system prompt and appends the cross-file context block
 * using the same format as prompt_codereview_system_gemini_v2.
 *
 * The cross-file context block is pre-formatted by ab-convert-dataset.js
 * and passed as {{crossFileContextBlock}} via promptfoo template vars.
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
    // Deep clone to avoid mutating the cached base
    const prompt = JSON.parse(JSON.stringify(basePrompt));

    const systemMsg = prompt.find((m) => m.role === 'system');
    if (systemMsg) {
        // Append the cross-file context section.
        // {{crossFileContextBlock}} is substituted by promptfoo from test vars.
        // If the var is empty, the section still appears but is harmless.
        systemMsg.content +=
            '\n\n## External Context & Injected Knowledge\n\n' +
            'The following information is provided to ground your analysis in the broader system reality. ' +
            'Use this as your source of truth.\n\n---\n\n' +
            '{{crossFileContextBlock}}';
    }

    return JSON.stringify(prompt);
};
