/**
 * Replicates the production output parser from:
 * - libs/ai-engine/infrastructure/adapters/services/llmResponseProcessor.transform.ts
 * - libs/common/utils/transforms/json.ts
 *
 * This ensures the eval tests parseability with the same logic used in production.
 * IMPORTANT: Keep in sync with the production files above.
 */

const JSON5 = require('json5');

function extractValidJsonBlocks(text) {
    const cleanText = text.replace(/^['"]|['"]$/g, '');
    const blocks = [];

    // Collect all ```json blocks that parse as valid JSON
    const jsonMatches = cleanText.matchAll(/```json([\s\S]*?)```/g);
    for (const match of jsonMatches) {
        try {
            JSON.parse(match[1].trim());
            blocks.push(match[1]);
        } catch { /* skip invalid */ }
    }
    if (blocks.length > 0) return blocks;

    // Fallback: any code block with JSON-like content
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
                    // If validator provided, return the first block that passes
                    if (validator) {
                        for (const block of validBlocks) {
                            try {
                                const parsed = JSON.parse(block.trim());
                                if (validator(parsed)) return parsed;
                            } catch { /* next block */ }
                        }
                    }

                    // No validator OR none passed → last valid block (current behavior)
                    const lastBlock = validBlocks[validBlocks.length - 1];
                    try {
                        return JSON.parse(lastBlock.trim());
                    } catch { /* fall through to aggressive cleaning */ }

                    // Aggressive cleaning on last block (last resort)
                    const cleanedPayload = lastBlock
                        .replace(/\\n/g, '')
                        .replace(/\\/g, '')
                        .replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/<[^>]*>/g, '')
                        .replace(/^`+|`+$/g, '')
                        .trim();
                    return JSON.parse(cleanedPayload);
                }

                // No code blocks → try stripped payload, then aggressive cleaning
                const noCodeBlocks = stripCodeBlocks(payload);
                try {
                    return JSON.parse(noCodeBlocks.trim());
                } catch { /* fall through to aggressive cleaning */ }
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
 * Replicates LLMResponseProcessor.processResponse()
 * Returns { codeSuggestions: [...] } or null on parse failure.
 */
function processResponse(response) {
    try {
        let cleanResponse = response;

        // If response starts with ```, remove markdown markers (same as production)
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

        // Normalize line number types (same as production)
        if (parsedResponse?.codeSuggestions) {
            parsedResponse.codeSuggestions = parsedResponse.codeSuggestions.map((suggestion) => ({
                ...suggestion,
                relevantLinesStart: Number(suggestion.relevantLinesStart) || undefined,
                relevantLinesEnd: Number(suggestion.relevantLinesEnd) || undefined,
            }));
        }

        return {
            codeSuggestions: parsedResponse?.codeSuggestions || [],
        };
    } catch {
        return null;
    }
}

/**
 * Validates codeSuggestions structure against production Zod schema requirements.
 * Returns { valid: boolean, errors: string[] }
 */
function validateSchema(codeSuggestions) {
    const errors = [];
    if (!Array.isArray(codeSuggestions)) {
        return { valid: false, errors: ['codeSuggestions is not an array'] };
    }

    codeSuggestions.forEach((s, i) => {
        if (!s.relevantFile || typeof s.relevantFile !== 'string') {
            errors.push(`[${i}] missing or invalid relevantFile`);
        }
        if (!s.language || typeof s.language !== 'string') {
            errors.push(`[${i}] missing or invalid language`);
        }
        if (!s.suggestionContent || typeof s.suggestionContent !== 'string') {
            errors.push(`[${i}] missing or invalid suggestionContent`);
        }
        if (!s.improvedCode || typeof s.improvedCode !== 'string') {
            errors.push(`[${i}] missing or invalid improvedCode`);
        }
        if (!s.label || typeof s.label !== 'string') {
            errors.push(`[${i}] missing or invalid label`);
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
