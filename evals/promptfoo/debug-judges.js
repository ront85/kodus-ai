const { loadResults } = require('./load-results');
const { results } = loadResults();
if (results.length === 0) { console.error('No result files found.'); process.exit(1); }
results.forEach((r, i) => {
    const components = r.gradingResult?.componentResults || [];
    const judge = components.find(c => c.reason && c.reason.includes("JUDGE_METRICS"));
    if (judge) {
        console.log("=== TEST " + (i + 1) + " ===");
        console.log(judge.reason);
        console.log("");
    }
});
