#!/bin/bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Optimization cycle orchestrator.
#
# Chains: baseline → diagnosis → (manual edit) → re-eval → comparison
#
# Usage:
#   ./run-optimization-cycle.sh --baseline-only          # run eval + generate baseline
#   ./run-optimization-cycle.sh --diagnose-only          # matrix + diagnosis from existing output
#   ./run-optimization-cycle.sh --compare-only OLD NEW   # compare two matrix JSONs
#   ./run-optimization-cycle.sh --full-cycle             # full loop (max 3 iterations)
#
# Options:
#   --lang=LANG           filter by language (tsjs, python, java, ruby, all)
#   --max-iterations=N    max iterations for --full-cycle (default: 3)
#   --threshold=N         regression threshold in pp (default: 3)
# ──────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"

# Defaults
MODE=""
LANG_ARG=""
LIMIT_ARG=""
MAX_ITERATIONS=3
THRESHOLD=3
COMPARE_FILES=()

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --baseline-only)   MODE="baseline"; shift ;;
        --diagnose-only)   MODE="diagnose"; shift ;;
        --compare-only)    MODE="compare"; shift
            # Next two args are the files to compare
            if [[ $# -ge 2 ]]; then
                COMPARE_FILES=("$1" "$2"); shift 2
            else
                echo "Error: --compare-only requires two file arguments"
                exit 2
            fi
            ;;
        --full-cycle)      MODE="full"; shift ;;
        --lang=*)          LANG_ARG="$1"; shift ;;
        --limit=*)         LIMIT_ARG="$1"; shift ;;
        --max-iterations=*) MAX_ITERATIONS="${1#*=}"; shift ;;
        --threshold=*)     THRESHOLD="${1#*=}"; shift ;;
        *)
            echo "Unknown argument: $1"
            echo "Usage: $0 {--baseline-only|--diagnose-only|--compare-only OLD NEW|--full-cycle} [--lang=LANG] [--limit=N] [--max-iterations=N] [--threshold=N]"
            exit 2
            ;;
    esac
done

if [[ -z "$MODE" ]]; then
    echo "Error: specify a mode: --baseline-only, --diagnose-only, --compare-only, or --full-cycle"
    echo "Usage: $0 {--baseline-only|--diagnose-only|--compare-only OLD NEW|--full-cycle} [--lang=LANG] [--limit=N] [--max-iterations=N] [--threshold=N]"
    exit 2
fi

# ──────────────────────────────────────────────────────────────────────────────
# Helper functions
# ──────────────────────────────────────────────────────────────────────────────

run_eval() {
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Running eval... ${LANG_ARG:-all languages}"
    echo "═══════════════════════════════════════════════════════════════"
    bash "$SCRIPT_DIR/run-eval.sh" ${LANG_ARG} ${LIMIT_ARG}
}

run_matrix() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Generating matrix..."
    echo "═══════════════════════════════════════════════════════════════"
    node "$SCRIPT_DIR/analyze-matrix.js"
}

run_diagnosis() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Running diagnosis..."
    echo "═══════════════════════════════════════════════════════════════"
    node "$SCRIPT_DIR/diagnose-weaknesses.js"
}

run_compare() {
    local baseline_file="$1"
    local current_file="$2"
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Comparing baselines..."
    echo "═══════════════════════════════════════════════════════════════"
    node "$SCRIPT_DIR/compare-baselines.js" --threshold="$THRESHOLD" "$baseline_file" "$current_file"
}

save_baseline() {
    local date_str
    date_str="$(date +%Y-%m-%d_%H%M%S)"
    local baseline_path="$RESULTS_DIR/matrix-baseline-${date_str}.json"
    cp "$RESULTS_DIR/matrix-latest.json" "$baseline_path"
    # Also keep a symlink-like copy for easy access
    cp "$RESULTS_DIR/matrix-latest.json" "$RESULTS_DIR/matrix-baseline.json"
    echo "  Baseline saved: $baseline_path"
    echo "  Also at: $RESULTS_DIR/matrix-baseline.json"
}

# ──────────────────────────────────────────────────────────────────────────────
# Modes
# ──────────────────────────────────────────────────────────────────────────────

case "$MODE" in
    baseline)
        run_eval
        run_matrix
        save_baseline
        run_diagnosis
        echo ""
        echo "Done! Baseline established. Review diagnosis above to plan optimizations."
        ;;

    diagnose)
        run_matrix
        run_diagnosis
        ;;

    compare)
        run_compare "${COMPARE_FILES[0]}" "${COMPARE_FILES[1]}"
        ;;

    full)
        echo "═══════════════════════════════════════════════════════════════"
        echo "  FULL OPTIMIZATION CYCLE (max $MAX_ITERATIONS iterations)"
        echo "═══════════════════════════════════════════════════════════════"

        # Step 1: Establish baseline if none exists
        if [[ ! -f "$RESULTS_DIR/matrix-baseline.json" ]]; then
            echo ""
            echo "  No baseline found. Running initial eval..."
            run_eval
            run_matrix
            save_baseline
        fi

        BASELINE_FILE="$RESULTS_DIR/matrix-baseline.json"

        for i in $(seq 1 "$MAX_ITERATIONS"); do
            echo ""
            echo "═══════════════════════════════════════════════════════════════"
            echo "  ITERATION $i / $MAX_ITERATIONS"
            echo "═══════════════════════════════════════════════════════════════"

            # Diagnose current state
            run_diagnosis

            echo ""
            echo "  ─────────────────────────────────────────────────────────"
            echo "  Review the diagnosis above."
            echo "  Make your prompt changes, then press ENTER to re-eval."
            echo "  Or type 'skip' to end the cycle."
            echo "  ─────────────────────────────────────────────────────────"
            read -r user_input

            if [[ "$user_input" == "skip" ]]; then
                echo "  Skipping remaining iterations."
                break
            fi

            # Re-eval
            run_eval
            run_matrix

            # Compare
            if run_compare "$BASELINE_FILE" "$RESULTS_DIR/matrix-latest.json"; then
                echo ""
                echo "  No regressions detected. Saving as new baseline."
                save_baseline
                BASELINE_FILE="$RESULTS_DIR/matrix-baseline.json"
            else
                echo ""
                echo "  Regressions detected! Review above and decide:"
                echo "  Press ENTER to continue iterating, or 'skip' to stop."
                read -r user_input
                if [[ "$user_input" == "skip" ]]; then
                    break
                fi
            fi
        done

        echo ""
        echo "═══════════════════════════════════════════════════════════════"
        echo "  Cycle complete after $i iteration(s)."
        echo "═══════════════════════════════════════════════════════════════"
        ;;
esac
