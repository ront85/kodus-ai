#!/usr/bin/env node

/**
 * Merge two promptfoo output.json files.
 *
 * Replaces results for matching providers from the patch file into the base file.
 * Useful for re-running a subset of providers without re-running the full eval.
 *
 * Usage:
 *   node merge-results.js <base.json> <patch.json> [output.json]
 *   node merge-results.js results/output.json results/output-openrouter.json
 */

const fs = require('fs');
const path = require('path');

const [baseFile, patchFile, outputFile] = process.argv.slice(2);

if (!baseFile || !patchFile) {
    console.error('Usage: node merge-results.js <base.json> <patch.json> [output.json]');
    process.exit(2);
}

const base = JSON.parse(fs.readFileSync(baseFile, 'utf-8'));
const patch = JSON.parse(fs.readFileSync(patchFile, 'utf-8'));

const baseResults = base.results.results;
const patchResults = patch.results.results;

// Find which providers are in the patch
const patchProviders = new Set(
    patchResults.map(r => r.provider?.id || r.provider || '')
);

console.log(`Base: ${baseResults.length} results`);
console.log(`Patch: ${patchResults.length} results from providers: ${[...patchProviders].join(', ')}`);

// Remove old results for patched providers, add new ones
const filtered = baseResults.filter(r => {
    const provider = r.provider?.id || r.provider || '';
    return !patchProviders.has(provider);
});

const merged = [...filtered, ...patchResults];
base.results.results = merged;

// Update prompts array if patch has new prompts
if (patch.results.prompts) {
    const existingPromptProviders = new Set(
        (base.results.prompts || []).map(p => p.provider)
    );
    for (const p of patch.results.prompts) {
        if (!existingPromptProviders.has(p.provider)) {
            base.results.prompts.push(p);
        }
    }
}

const dest = outputFile || baseFile;
fs.writeFileSync(dest, JSON.stringify(base, null, 2));
console.log(`Merged: ${merged.length} results → ${dest}`);
