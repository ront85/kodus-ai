#!/bin/bash

# Carrega variáveis do .env se existir
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

# Parse argumentos
while [[ $# -gt 0 ]]; do
    case $1 in
        --largest|-l)
            export SELECT_LARGEST_PRS=true
            shift
            ;;
        --close|-c)
            export CLOSE_EXISTING_PRS=true
            shift
            ;;
        --total|-n)
            export TOTAL_PRS="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: ./run.sh [options]"
            echo ""
            echo "Options:"
            echo "  -l, --largest     Select branches with most changed files"
            echo "  -c, --close       Close existing PRs before creating new ones"
            echo "  -n, --total NUM   Number of PRs to create (default: 10)"
            echo "  -h, --help        Show this help message"
            echo ""
            echo "Examples:"
            echo "  ./run.sh --largest           # Create PRs from largest branches"
            echo "  ./run.sh -l -n 5             # Create 5 PRs from largest branches"
            echo "  ./run.sh --close --largest   # Close existing PRs and create from largest"
            exit 0
            ;;
        *)
            shift
            ;;
    esac
done

# Executa o script Node
node create-test-prs.mjs
