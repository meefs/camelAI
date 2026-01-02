#!/bin/bash
# Wrangler wrapper that ensures WFP dispatch namespace is used for deploys.
# Intercepts wrangler commands and adds --dispatch-namespace when needed.
# After successful deploy, outputs the worker URL for Claude to use.

REAL_WRANGLER="/usr/local/bin/wrangler-real"

# Check if this is a deploy command
if [[ "$1" == "deploy" || "$1" == "publish" ]]; then
  # Build the command with dispatch namespace if needed
  if [[ ! " $* " =~ " --dispatch-namespace " ]] && [[ -n "$CF_DISPATCH_NAMESPACE" ]]; then
    "$REAL_WRANGLER" "$@" --dispatch-namespace "$CF_DISPATCH_NAMESPACE"
    EXIT_CODE=$?
  else
    "$REAL_WRANGLER" "$@"
    EXIT_CODE=$?
  fi

  # If deploy succeeded, output the worker URL
  if [[ $EXIT_CODE -eq 0 ]] && [[ -n "$ORG_ID" ]]; then
    # Script name matches what container.ts generates
    SCRIPT_NAME="org-${ORG_ID}"
    WORKER_URL="https://${SCRIPT_NAME}.chiridion.ai"
    echo ""
    echo "=== Chiridion Deploy Complete ==="
    echo "Worker URL: ${WORKER_URL}"
    echo "================================="
    echo ""
  fi

  exit $EXIT_CODE
fi

# For all other commands, pass through directly
exec "$REAL_WRANGLER" "$@"
