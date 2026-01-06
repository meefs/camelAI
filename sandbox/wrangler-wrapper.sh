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

  # If deploy succeeded, set preview and output the worker URL
  if [[ $EXIT_CODE -eq 0 ]]; then
    USER_SCRIPT_NAME=$(get_script_name "$@")

    # Auto-set preview if THREAD_ID, WORKER_BASE_URL, and deploy token are available
    # The preview endpoint computes the prefixed name and returns the full URL
    if [[ -n "$THREAD_ID" ]] && [[ -n "$WORKER_BASE_URL" ]] && [[ -n "$CLOUDFLARE_API_TOKEN" ]]; then
      PREVIEW_RESPONSE=$(curl -s -X POST \
        "${WORKER_BASE_URL}/api/threads/${THREAD_ID}/preview" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        -d "{\"workers\": [\"${USER_SCRIPT_NAME}\"]}" 2>/dev/null)

      # Extract URL from response (expects {"workers":[...],"urls":["https://..."]})
      WORKER_URL=$(echo "$PREVIEW_RESPONSE" | jq -r '.urls[0] // empty')

      echo ""
      echo "=== Chiridion Deploy Complete ==="
      if [[ -n "$WORKER_URL" ]]; then
        echo "Worker URL: ${WORKER_URL}"
        echo "Preview: Updated automatically"
      else
        echo "Preview: Failed to update"
        echo "Response: ${PREVIEW_RESPONSE}"
      fi
      echo "================================="
      echo ""
    else
      echo ""
      echo "=== Chiridion Deploy Complete ==="
      echo "Worker: ${USER_SCRIPT_NAME}"
      echo "(Preview not set - missing THREAD_ID, WORKER_BASE_URL, or CLOUDFLARE_API_TOKEN)"
      echo "================================="
      echo ""
    fi
  fi

  exit $EXIT_CODE
fi

# For all other commands, pass through directly
exec "$REAL_WRANGLER" "$@"
