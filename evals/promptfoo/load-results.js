#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const resultsDir = path.join(__dirname, 'results');
const DATASET_TYPE_FILES = ['normal', 'crossfile'];

/**
 * Load results from per-dataset-type output files (output-normal.json, output-crossfile.json).
 * Falls back to legacy output.json if no per-type files exist.
 * Returns { results: [...], loadedFiles: [...] }
 */
function loadResults() {
    const allResults = [];
    const loadedFiles = [];

    for (const dt of DATASET_TYPE_FILES) {
        const filePath = path.join(resultsDir, `output-${dt}.json`);
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const entries = data.results?.results || [];
            allResults.push(...entries);
            loadedFiles.push(`output-${dt}.json (${entries.length} results)`);
        }
    }

    // Fallback: try legacy single output.json if no per-type files found
    if (allResults.length === 0) {
        const legacyPath = path.join(resultsDir, 'output.json');
        if (fs.existsSync(legacyPath)) {
            const data = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
            const entries = data.results?.results || [];
            allResults.push(...entries);
            loadedFiles.push(`output.json (${entries.length} results)`);
        }
    }

    return { results: allResults, loadedFiles };
}

module.exports = { loadResults };
