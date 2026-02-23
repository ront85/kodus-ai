#!/bin/bash

# Get the script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Load only the specific API keys we need from .env (safer than sourcing entire file)
ENV_FILE="$PROJECT_ROOT/.env"

extract_env() {
    grep "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'"
}

# Map from kodus .env naming convention to promptfoo's expected names
export OPENAI_API_KEY="$(extract_env API_OPEN_AI_API_KEY)"
export ANTHROPIC_API_KEY="$(extract_env API_ANTHROPIC_API_KEY)"
export GOOGLE_API_KEY="$(extract_env API_GOOGLE_AI_API_KEY)"
export OPENROUTER_API_KEY="$(extract_env API_OPENROUTER_KEY)"

# Extract --lang, --limit, --dir, and --dataset-type arguments for convert-dataset.js (pass the rest to promptfoo)
DATASET_TYPE=""
CONVERT_ARGS=()
PROMPTFOO_ARGS=()
for arg in "$@"; do
    if [[ "$arg" == --dataset-type=* ]]; then
        DATASET_TYPE="${arg#--dataset-type=}"
        CONVERT_ARGS+=("$arg")
    elif [[ "$arg" == --lang=* ]] || [[ "$arg" == --limit=* ]] || [[ "$arg" == --dir=* ]]; then
        CONVERT_ARGS+=("$arg")
    else
        PROMPTFOO_ARGS+=("$arg")
    fi
done

cd "$SCRIPT_DIR"
mkdir -p results

# Run a single dataset type: convert → eval → save to results/output-<type>.json
run_dataset_type() {
    local dt="$1"
    echo ""
    echo "═══════════════════════════════════════════════════════"
    echo "  Running dataset-type: $dt"
    echo "═══════════════════════════════════════════════════════"
    echo ""

    # Build convert args: always pass --dataset-type=<dt>, plus any --lang/--limit/--dir from CLI
    local convert_flags=("--dataset-type=$dt")
    for arg in "${CONVERT_ARGS[@]}"; do
        # Skip --dataset-type since we override it
        [[ "$arg" == --dataset-type=* ]] && continue
        convert_flags+=("$arg")
    done

    node convert-dataset.js "${convert_flags[@]}"
    npx promptfoo eval -c promptfoo.yaml -o "results/output-${dt}.json" -j 10 "${PROMPTFOO_ARGS[@]}" || true
}

if [[ -n "$DATASET_TYPE" && "$DATASET_TYPE" != "all" ]]; then
    # Single dataset type: run just that one
    run_dataset_type "$DATASET_TYPE"
else
    # All: run each separately so each gets its own output file
    for dt in normal crossfile; do
        run_dataset_type "$dt"
    done
fi

echo ""
echo "Done. Analyze results with: node analyze-results.js"
