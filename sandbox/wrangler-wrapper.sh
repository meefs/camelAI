#!/bin/bash
# Wrangler wrapper that ensures WFP dispatch namespace is used for deploys.
# Intercepts wrangler commands and adds --dispatch-namespace when needed.

REAL_WRANGLER="/usr/local/bin/wrangler-real"

# Check if this is a deploy command
if [[ "$1" == "deploy" || "$1" == "publish" ]]; then
  # Check if --dispatch-namespace is already specified
  if [[ ! " $* " =~ " --dispatch-namespace " ]]; then
    # Add dispatch namespace from env var if set
    if [[ -n "$CF_DISPATCH_NAMESPACE" ]]; then
      exec "$REAL_WRANGLER" "$@" --dispatch-namespace "$CF_DISPATCH_NAMESPACE"
    fi
  fi
fi

# For all other commands, pass through directly
exec "$REAL_WRANGLER" "$@"
