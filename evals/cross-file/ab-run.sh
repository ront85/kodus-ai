#!/bin/bash

# A/B Eval: Cross-File Context Impact
#
# Runs the same code review prompt WITH and WITHOUT cross-file snippets
# against every dataset example, using promptfoo's dual-prompt comparison.
#
# Usage:
#   ./ab-run.sh                          # Default dataset
#   ./ab-run.sh --dataset=my-data.jsonl  # Custom dataset
#   ./ab-run.sh --no-cache               # Force re-run

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Load API keys from .env
ENV_FILE="$PROJECT_ROOT/.env"

extract_env() {
    grep "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'"
}

export OPENAI_API_KEY="$(extract_env API_OPEN_AI_API_KEY)"
export ANTHROPIC_API_KEY="$(extract_env API_ANTHROPIC_API_KEY)"
export GOOGLE_API_KEY="$(extract_env API_GOOGLE_AI_API_KEY)"
export OPENROUTER_API_KEY="$(extract_env API_OPENROUTER_KEY)"

# Separate --dataset arg (for convert-dataset) from promptfoo args
DATASET_ARG=""
PROMPTFOO_ARGS=()
for arg in "$@"; do
    if [[ "$arg" == --dataset=* ]]; then
        DATASET_ARG="$arg"
    else
        PROMPTFOO_ARGS+=("$arg")
    fi
done

cd "$SCRIPT_DIR"

# Convert dataset JSONL to promptfoo test cases
node ab-convert-dataset.js ${DATASET_ARG}
if [ $? -ne 0 ]; then
    echo "Dataset conversion failed."
    exit 1
fi

# Run promptfoo eval with both control and treatment prompts
npx promptfoo eval -c promptfoo-ab.yaml -j 5 "${PROMPTFOO_ARGS[@]}"
