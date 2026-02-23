/**
 * Parses safeguard LLM output into structured codeSuggestions.
 * Reuses the same JSON parsing logic from the analyze eval,
 * but validates against the safeguard schema (action, reason, id).
 *
 * IMPORTANT: Keep in sync with production parser in:
 * - libs/ai-engine/infrastructure/adapters/services/llmResponseProcessor.transform.ts
 * - libs/common/utils/transforms/json.ts
 */

const JSON5 = require('json5');

function extractValidJsonBlocks(text) {
    const cleanText = text.replace(/^['"]|['"]$/g, '');
    const blocks = [];

    const jsonMatches = cleanText.matchAll(/```json([\s\S]*?)```/g);
    for (const match of jsonMatches) {
        try {
            JSON.parse(match[1].trim());
            blocks.push(match[1]);
        } catch { /* skip invalid */ }
    }
    if (blocks.length > 0) return blocks;

    const genericMatches = cleanText.match(/```(?:\w*)\s*([\s\S]*?)```/g);
    if (genericMatches) {
        for (const block of genericMatches) {
            const content = block.replace(/^```\w*\s*/, '').replace(/```$/, '').trim();
            if (content.startsWith('{') || content.startsWith('[')) {
                blocks.push(content);
            }
        }
    }

    return blocks;
}

function stripCodeBlocks(text) {
    const blocks = extractValidJsonBlocks(text);
    if (blocks.length > 0) return blocks[blocks.length - 1];
    return text.replace(/^['"]|['"]$/g, '');
}

function tryParseJSONObjectWithFallback(payload, validator) {
    try {
        if (payload.length <= 0) return null;
        return JSON5.parse(payload);
    } catch {
        try {
            return JSON.parse(payload);
        } catch {
            try {
                const validBlocks = extractValidJsonBlocks(payload);

                if (validBlocks.length > 0) {
                    if (validator) {
                        for (const block of validBlocks) {
                            try {
                                const parsed = JSON.parse(block.trim());
                                if (validator(parsed)) return parsed;
                            } catch { /* next block */ }
                        }
                    }

                    const lastBlock = validBlocks[validBlocks.length - 1];
                    try {
                        return JSON.parse(lastBlock.trim());
                    } catch { /* fall through */ }

                    const cleanedPayload = lastBlock
                        .replace(/\\n/g, '')
                        .replace(/\\/g, '')
                        .replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/<[^>]*>/g, '')
                        .replace(/^`+|`+$/g, '')
                        .trim();
                    return JSON.parse(cleanedPayload);
                }

                const noCodeBlocks = stripCodeBlocks(payload);
                try {
                    return JSON.parse(noCodeBlocks.trim());
                } catch { /* fall through */ }
                const cleanedPayload = noCodeBlocks
                    .replace(/\\n/g, '')
                    .replace(/\\/g, '')
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/<[^>]*>/g, '')
                    .replace(/^`+|`+$/g, '')
                    .trim();
                return JSON.parse(cleanedPayload);
            } catch {
                return null;
            }
        }
    }
}

function tryParseJSONObject(payload, validator) {
    try {
        const cleanedPayload = payload
            .replace(/\\\\n/g, '\\n')
            .replace(/\\'/g, "'")
            .replace(/(\r\n|\n|\r)/gm, '')
            .replace(/\\\\"/g, '\\"');

        const parsedData = tryParseJSONObjectWithFallback(cleanedPayload, validator);

        if (parsedData && (typeof parsedData === 'object' || Array.isArray(parsedData))) {
            return parsedData;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Parses safeguard LLM response.
 * Returns { codeSuggestions: [...] } or null on parse failure.
 */
function processResponse(response) {
    try {
        let cleanResponse = response;

        if (response?.startsWith('```')) {
            cleanResponse = response
                .replace(/^```json\n/, '')
                .replace(/\n```$/, '')
                .trim();
        }

        const parsedResponse = tryParseJSONObject(
            cleanResponse,
            (obj) => Array.isArray(obj?.codeSuggestions),
        );

        if (!parsedResponse) {
            return null;
        }

        if (parsedResponse?.codeSuggestions) {
            parsedResponse.codeSuggestions = parsedResponse.codeSuggestions.map((s) => ({
                ...s,
                relevantLinesStart: Number(s.relevantLinesStart) || undefined,
                relevantLinesEnd: Number(s.relevantLinesEnd) || undefined,
            }));
        }

        return {
            codeSuggestions: parsedResponse?.codeSuggestions || [],
        };
    } catch {
        return null;
    }
}

const VALID_ACTIONS = new Set(['no_changes', 'update', 'discard']);

/**
 * Validates safeguard codeSuggestions against production Zod schema.
 * Returns { valid: boolean, errors: string[] }
 */
function validateSchema(codeSuggestions) {
    const errors = [];
    if (!Array.isArray(codeSuggestions)) {
        return { valid: false, errors: ['codeSuggestions is not an array'] };
    }

    codeSuggestions.forEach((s, i) => {
        if (!s.id || typeof s.id !== 'string') {
            errors.push(`[${i}] missing or invalid id`);
        }
        if (!s.action || !VALID_ACTIONS.has(s.action)) {
            errors.push(`[${i}] invalid action: ${s.action} (expected no_changes|update|discard)`);
        }
        if (!s.suggestionContent || typeof s.suggestionContent !== 'string') {
            errors.push(`[${i}] missing or invalid suggestionContent`);
        }
        if (!s.existingCode || typeof s.existingCode !== 'string') {
            errors.push(`[${i}] missing or invalid existingCode`);
        }
        if (s.action === 'update') {
            if (!s.improvedCode || typeof s.improvedCode !== 'string') {
                errors.push(`[${i}] update action requires improvedCode`);
            }
        }
        if (s.relevantLinesStart !== undefined && (typeof s.relevantLinesStart !== 'number' || s.relevantLinesStart < 1)) {
            errors.push(`[${i}] relevantLinesStart must be number >= 1, got ${s.relevantLinesStart}`);
        }
        if (s.relevantLinesEnd !== undefined && (typeof s.relevantLinesEnd !== 'number' || s.relevantLinesEnd < 1)) {
            errors.push(`[${i}] relevantLinesEnd must be number >= 1, got ${s.relevantLinesEnd}`);
        }
    });

    return { valid: errors.length === 0, errors };
}

module.exports = { processResponse, validateSchema, tryParseJSONObject, stripCodeBlocks };
