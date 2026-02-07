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
export OPENROUTER_API_KEY="$(extract_env OPENROUTER_API_KEY)"

# Extract --lang and --limit arguments for convert-dataset.js (pass the rest to promptfoo)
LANG_ARG=""
LIMIT_ARG=""
PROMPTFOO_ARGS=()
for arg in "$@"; do
    if [[ "$arg" == --lang=* ]]; then
        LANG_ARG="$arg"
    elif [[ "$arg" == --limit=* ]]; then
        LIMIT_ARG="$arg"
    else
        PROMPTFOO_ARGS+=("$arg")
    fi
done

# Run convert-dataset.js to generate test cases
cd "$SCRIPT_DIR"
node convert-dataset.js ${LANG_ARG} ${LIMIT_ARG}

# Run promptfoo (exit code != 0 is expected when test cases fail, not a script error)
npx promptfoo eval -c promptfoo.yaml -j 10 "${PROMPTFOO_ARGS[@]}" || true
