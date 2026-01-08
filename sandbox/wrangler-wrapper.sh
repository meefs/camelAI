#!/bin/bash
# Wrangler wrapper that ensures WFP dispatch namespace is used for deploys.
# Intercepts wrangler commands and adds --dispatch-namespace when needed.
# Preview is set automatically by the proxy using per-thread deploy tokens.

REAL_WRANGLER="/usr/local/bin/wrangler-real"

# Block init/generate commands - use create-worker instead
if [[ "$1" == "init" || "$1" == "generate" ]]; then
  echo "Error: 'wrangler $1' is not available. Use 'create-worker' instead:" >&2
  echo "" >&2
  echo "  create-worker nextjs-fullstack my-app        # Next.js fullstack app" >&2
  echo "  create-worker nextjs-fullstack my-app --auth # With authentication" >&2
  echo "" >&2
  echo "Run 'create-worker --help' for all available templates." >&2
  exit 1
fi

# Check if this is a deploy command
if [[ "$1" == "deploy" || "$1" == "publish" ]]; then
  # Temp file to capture output while still streaming to terminal
  OUTPUT_FILE=$(mktemp)
  trap "rm -f '$OUTPUT_FILE'" EXIT

  # Add --dispatch-namespace if not already present and CF_DISPATCH_NAMESPACE is set
  if [[ ! " $* " =~ " --dispatch-namespace " ]] && [[ -n "$CF_DISPATCH_NAMESPACE" ]]; then
    "$REAL_WRANGLER" "$@" --dispatch-namespace "$CF_DISPATCH_NAMESPACE" 2>&1 | tee "$OUTPUT_FILE"
    EXIT_CODE=${PIPESTATUS[0]}
  else
    "$REAL_WRANGLER" "$@" 2>&1 | tee "$OUTPUT_FILE"
    EXIT_CODE=${PIPESTATUS[0]}
  fi

  # On successful deploy, extract script name from wrangler's output and print URL
  # Wrangler outputs: "Uploaded <name> (x.xx sec)" for dispatch namespace deploys
  if [[ $EXIT_CODE -eq 0 ]]; then
    SCRIPT_NAME=$(grep -oE 'Uploaded [^ ]+ ' "$OUTPUT_FILE" | head -1 | awk '{print $2}')
    if [[ -n "$SCRIPT_NAME" ]]; then
      echo ""
      echo "🚀 Deployed to: https://${SCRIPT_NAME}.chiridion.ai"
    fi
  fi

  exit $EXIT_CODE
fi

# For all other commands, pass through directly
exec "$REAL_WRANGLER" "$@"
