#!/bin/bash
# Wrangler wrapper that ensures WFP dispatch namespace is used for deploys.
# Intercepts wrangler commands and adds --dispatch-namespace when needed.
# After successful deploy, outputs the worker URL for Claude to use.

REAL_WRANGLER="/usr/local/bin/wrangler-real"

# Extract script name from --name flag or wrangler.toml
get_script_name() {
  # Check for --name flag in args
  local args=("$@")
  for ((i=0; i<${#args[@]}; i++)); do
    if [[ "${args[i]}" == "--name" ]] && [[ -n "${args[i+1]}" ]]; then
      echo "${args[i+1]}"
      return
    fi
  done

  # Try to read from wrangler.toml or wrangler.jsonc
  if [[ -f "wrangler.toml" ]]; then
    grep -E '^name\s*=' wrangler.toml | head -1 | sed 's/.*=\s*["'\'']\?\([^"'\'']*\)["'\'']\?.*/\1/'
  elif [[ -f "wrangler.jsonc" ]]; then
    grep -E '"name"\s*:' wrangler.jsonc | head -1 | sed 's/.*:\s*["'\'']\([^"'\'']*\)["'\''].*/\1/'
  elif [[ -f "wrangler.json" ]]; then
    grep -E '"name"\s*:' wrangler.json | head -1 | sed 's/.*:\s*["'\'']\([^"'\'']*\)["'\''].*/\1/'
  else
    echo "worker"
  fi
}

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

  # If deploy succeeded, output the worker URL and auto-set preview
  if [[ $EXIT_CODE -eq 0 ]] && [[ -n "$ORG_ID" ]]; then
    # Get the script name and construct the prefixed URL
    USER_SCRIPT_NAME=$(get_script_name "$@")
    # Sanitize script name (same logic as proxy)
    SAFE_NAME=$(echo "$USER_SCRIPT_NAME" | sed 's/[^a-zA-Z0-9_-]/_/g')
    # Org prefix is first 32 chars of ORG_ID
    ORG_PREFIX=$(echo "$ORG_ID" | cut -c1-32 | sed 's/[^a-zA-Z0-9_-]/_/g')
    SCRIPT_NAME="${ORG_PREFIX}-${SAFE_NAME}"
    WORKER_URL="https://${SCRIPT_NAME}.chiridion.ai"
    echo ""
    echo "=== Chiridion Deploy Complete ==="
    echo "Worker URL: ${WORKER_URL}"

    # Auto-set preview if THREAD_ID, WORKER_BASE_URL, and deploy token are available
    if [[ -n "$THREAD_ID" ]] && [[ -n "$WORKER_BASE_URL" ]] && [[ -n "$CLOUDFLARE_API_TOKEN" ]]; then
      PREVIEW_RESULT=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        "${WORKER_BASE_URL}/api/threads/${THREAD_ID}/preview" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        -d "{\"workers\": [\"${SCRIPT_NAME}\"]}" 2>/dev/null)

      if [[ "$PREVIEW_RESULT" == "200" ]]; then
        echo "Preview: Updated automatically"
      else
        echo "Preview: Failed to update (HTTP ${PREVIEW_RESULT})"
      fi
    fi
    echo "================================="
    echo ""
  fi

  exit $EXIT_CODE
fi

# For all other commands, pass through directly
exec "$REAL_WRANGLER" "$@"
